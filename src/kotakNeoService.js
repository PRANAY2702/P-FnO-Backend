const axios = require('axios');
const EventEmitter = require('events');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
// otplib can generate TOTP from a shared secret if you store the secret instead of a static code
const { authenticator } = require('otplib');

/**
 * KotakNeoService
 * ───────────────
 * Drop-in replacement for ShoonyaService.
 * Authenticates against the Kotak Neo Trade API (REST),
 * then streams live index ticks via the Kotak wstreamer Socket.io feed.
 *
 * Required env vars:
 *   KOTAK_CONSUMER_KEY     – from Neo API Dashboard
 *   KOTAK_CONSUMER_SECRET  – from Neo API Dashboard
 *   KOTAK_MOBILE_NUMBER    – registered mobile (e.g. +919999999999)
 *   KOTAK_PASSWORD         – trading password
 *   KOTAK_TOTP             – 6-digit TOTP code (or TOTP secret for auto-generation)
 *   KOTAK_MPIN             – 6-digit MPIN
 *   KOTAK_ENVIRONMENT      – 'prod' | 'uat'  (default: 'prod')
   KOTAK_TOTP_SECRET       – optional base32 secret for generating TOTP (if you don't want to store the 6‑digit code)
 */
class KotakNeoService extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;

        const env = (config.environment || 'prod').toLowerCase();
        this.baseUrl = env === 'uat'
            ? 'https://gw-napi.kotaksecurities.com/login/1.0/login'
            : 'https://gw-napi.kotaksecurities.com/login/1.0/login';

        this.tradeApiBase = env === 'uat'
            ? 'https://gw-napi.kotaksecurities.com'
            : 'https://gw-napi.kotaksecurities.com';

        // Path to store session information securely on the server
        this.sessionFile = path.resolve(__dirname, '..', 'kotak_session.json');

        this.wsUrl = 'https://wstreamer.kotaksecurities.com';

        this.sessionToken = null;
        this.sid         = null;
        this.serverId    = null;
        this.socket      = null;
    }

    // ─── Auth header for Step-1 (Basic <base64 key:secret>) ────────────────
    _basicAuth() {
        const creds = `${this.config.consumerKey}:${this.config.consumerSecret}`;
        return 'Basic ' + Buffer.from(creds).toString('base64');
    }

    // ─── Step 1: Trade API Login (V6 TOTP) ──────────────────────────────────
    async login() {
        if (!this.config.consumerKey) {
            console.warn('[KotakNeo] No credentials configured. Order execution unavailable.');
            return;
        }

        try {
            console.log('[KotakNeo] Initiating Trade API V6 login…');

            // 1. Perform TOTP Login – generate if secret provided
            let totpCode = this.config.totp;
            if (!totpCode && this.config.totpSecret) {
                // otplib expects a base32 secret; generate the 6‑digit code on the fly
                totpCode = authenticator.generate(this.config.totpSecret);
            }
            const loginBody = {
                mobileNumber: this.config.mobileNumber, // mis.kotaksecurities strictly requires + country code
                ucc: this.config.ucc,
                totp: totpCode
            };

            const headers = {
                'Content-Type':  'application/json',
                'Authorization': this.config.consumerKey, // Direct key, NO Bearer
                'neo-fin-key': 'neotradeapi'
            };

            const res = await axios.post(
                `https://mis.kotaksecurities.com/login/1.0/tradeApiLogin`,
                loginBody,
                { headers }
            );

            const body = res.data;
            if (!body || !body.data || !body.data.token) {
                console.error('[KotakNeo] Login step-1 (TOTP) failed:', JSON.stringify(body));
                throw new Error('Login step-1 rejected');
            }

            this.sessionToken = body.data.token; // This is the view_token
            this.sid = body.data.sid;
            // Persist session info for later reuse
            this._saveSession();
            console.log('[KotakNeo] Login step-1 OK. Proceeding to MPIN Validation…');
            await this._validate2FA();

        } catch (err) {
            console.error('[KotakNeo] Login error:', err.response ? JSON.stringify(err.response.data) : err.message);
            throw new Error('Login HTTP error');
        }
    }

    // ─── Step 2: Validate 2FA with MPIN (V6) ────────────────────────────────
    async _validate2FA() {
        try {
            const body2fa = {
                mpin: this.config.mpin
            };

            const headers = {
                'Content-Type':  'application/json',
                'Authorization': this.config.consumerKey, // Direct key, NO Bearer
                'sid': this.sid,
                'Auth': this.sessionToken,
                'neo-fin-key': 'neotradeapi'
            };

            const res = await axios.post(
                `https://mis.kotaksecurities.com/login/1.0/tradeApiValidate`,
                body2fa,
                { headers }
            );

            const body = res.data;
            if (!body || !body.data || !body.data.token) {
                console.error('[KotakNeo] MPIN validation failed:', JSON.stringify(body));
                throw new Error('MPIN rejected');
            }

            this.tradingToken = body.data.token;
            this.tradingSid = body.data.sid;
            this.apiBaseUrl = body.data.baseUrl;

            // Persist the trading credentials as part of the session file
            this._saveSession();

            // The Market Data websocket is strictly mlhsm.kotaksecurities.com
            this.wsUrl = 'wss://mlhsm.kotaksecurities.com/feed/';

            console.log('[KotakNeo] Session established. Connecting to live feed…');
            this._connectFeed();

        } catch (err) {
            console.error('[KotakNeo] Login error:', err.response ? err.response.data : err.message);
            throw new Error('2FA HTTP error');
        }
    }

    // ─── Step 3: Place Order ──────────────────────────────────────────────────
    async placeOrder({ ts, tt, qt, pt, pr, es, pc }) {
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            throw new Error('Not fully authenticated for trading');
        }

        const qs = require('querystring');
        const jData = JSON.stringify({
            am: "NO",
            dq: "0",
            es: es || "nse_cm",
            mp: "0",
            pc: pc || "CNC",
            pf: "N",
            pr: pr || "0",
            pt: pt || "MKT",
            qt: qt.toString(),
            rt: "DAY",
            tp: "0",
            ts: ts,
            tt: tt
        });

        const headers = {
            'Auth': this.tradingToken,
            'Sid': this.tradingSid,
            'neo-fin-key': 'neotradeapi',
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const data = qs.stringify({ jData });

        try {
            const res = await axios.post(
                `${this.apiBaseUrl}/quick/order/rule/ms/place`,
                data,
                { headers }
            );

            return res.data;
        } catch (error) {
            console.error('[KotakNeo] Order Placement Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // ─── Modify Order ─────────────────────────────────────────────────────────
    async modifyOrder(orderParams) {
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            throw new Error('Not fully authenticated for trading');
        }

        const qs = require('querystring');
        const payload = {
            am: orderParams.am || "NO",
            dq: orderParams.dq || "0",
            es: orderParams.es || "nse_cm",
            mp: orderParams.mp || "0",
            pc: orderParams.pc || "NRML",
            pf: orderParams.pf || "N",
            pr: orderParams.pr || "0",
            pt: orderParams.pt || "MKT",
            qt: (orderParams.qt || 1).toString(),
            rt: orderParams.rt || "DAY",
            tp: orderParams.tp || "0",
            ts: orderParams.ts,
            tt: orderParams.tt || "B",
            no: orderParams.no
        };

        if (orderParams.tk) payload.tk = orderParams.tk;
        if (orderParams.vd) payload.vd = orderParams.vd;
        if (orderParams.dd) payload.dd = orderParams.dd;

        const jData = JSON.stringify(payload);

        const headers = {
            'Auth': this.tradingToken,
            'Sid': this.tradingSid,
            'neo-fin-key': 'neotradeapi',
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const data = qs.stringify({ jData });

        try {
            const res = await axios.post(
                `${this.apiBaseUrl}/quick/order/vr/modify`,
                data,
                { headers }
            );

            return res.data;
        } catch (error) {
            console.error('[KotakNeo] Order Modification Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // ─── Cancel Order ─────────────────────────────────────────────────────────
    async cancelOrder(orderParams) {
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            throw new Error('Not fully authenticated for trading');
        }

        const qs = require('querystring');
        const payload = {
            on: orderParams.on,
            am: orderParams.am || "NO"
        };

        if (orderParams.ts) payload.ts = orderParams.ts;
        if (orderParams.symOrdId) payload.symOrdId = orderParams.symOrdId;

        const jData = JSON.stringify(payload);

        const headers = {
            'Auth': this.tradingToken,
            'Sid': this.tradingSid,
            'neo-fin-key': 'neotradeapi',
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const data = qs.stringify({ jData });

        // Determine correct endpoint based on orderType (regular, BO, CO)
        let endpoint = '/quick/order/cancel';
        if (orderParams.orderType === 'BO') endpoint = '/quick/order/bo/exit';
        else if (orderParams.orderType === 'CO') endpoint = '/quick/order/co/exit';

        try {
            const res = await axios.post(
                `${this.apiBaseUrl}${endpoint}`,
                data,
                { headers }
            );

            return res.data;
        } catch (error) {
            console.error('[KotakNeo] Order Cancellation Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // ─── Step 4: Check Order Status ───────────────────────────────────────────
    async getOrders() {
        // Auto‑login if session missing
        await this._ensureAuthenticated();
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            throw new Error('Not fully authenticated for trading');
        }

        const headers = {
            'Auth': this.tradingToken,
            'Sid': this.tradingSid,
            'neo-fin-key': 'neotradeapi'
        };

        try {
            const res = await axios.get(
                `${this.apiBaseUrl}/quick/user/orders`,
                { headers }
            );

            return res.data;
        } catch (error) {
            console.error('[KotakNeo] Get Orders Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // ─── Step 5: Check Positions ──────────────────────────────────────────────
    async getPositions() {
        // Ensure we have a valid session – attempt auto‑login if missing
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            await this._ensureAuthenticated();
        }
        if (!this.tradingToken || !this.tradingSid || !this.apiBaseUrl) {
            throw new Error('Not fully authenticated for trading');
        }

        const headers = {
            'Auth': this.tradingToken,
            'Sid': this.tradingSid,
            'neo-fin-key': 'neotradeapi'
        };

        try {
            const res = await axios.get(
                `${this.apiBaseUrl}/quick/user/positions`,
                { headers }
            );

            return res.data;
        } catch (error) {
            console.error('[KotakNeo] Get Positions Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // ─── Step 3: Connect to wstreamer via pure WebSocket ──────────────────────
    _connectFeed() {
        // If we already have a valid session token, reuse it; otherwise attempt a fresh login.
        if (!this.sessionToken) {
            console.warn('[KotakNeo] No session token – attempting login before feeding.');
            // Fire and forget – login will eventually call _connectFeed again via _validate2FA()
            this.login().catch(err => console.error('Auto‑login failed:', err));
            return;
        }
        if (!this.sessionToken) return;

        console.log('[KotakNeo] Connecting to pure websocket feed…');
        const url = `${this.wsUrl}?access_token=${this.sessionToken}&Sid=${this.sid}&Auth=${this.sessionToken}&EIO=3&transport=websocket`;
        
        this.socket = new WebSocket(url);

        this.socket.on('open', () => {
            console.log('[KotakNeo] Feed connected. Subscribing to indices…');
            this._subscribeIndices();
        });

        this.socket.on('message', (data) => {
            try {
                const msgStr = data.toString();
                // Respond to ping with pong (Engine.IO)
                if (msgStr === '2') {
                    this.socket.send('3');
                    return;
                }
                // Socket.IO messages usually start with '42'
                if (msgStr.startsWith('42')) {
                    const parsed = JSON.parse(msgStr.slice(2));
                    // parsed is usually ["event_name", { data }]
                    if (Array.isArray(parsed) && parsed.length > 1) {
                        this._handleTick(parsed[1]);
                    }
                } else if (msgStr.startsWith('0')) {
                    // Engine.IO open frame
                    console.log('[KotakNeo] Engine.IO handshake received.');
                }
            } catch (err) {
                // ignore binary or non-json feed data
            }
        });

        this.socket.on('close', (code, reason) => {
            console.warn(`[KotakNeo] Feed disconnected (code ${code}):`, reason.toString());
            // Remove session file so next attempt will re‑login if needed
            this._clearSession();
            this._scheduleReconnect();
        });

        this.socket.on('error', (err) => {
            console.error('[KotakNeo] Feed connection error:', err.message);
            this._scheduleReconnect();
        });
    }

    _scheduleReconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket = null;
        }
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            console.log('[KotakNeo] Attempting to reconnect feed...');
            this.reconnectTimer = null;
            this._connectFeed();
        }, 3000);
    }

    // ─── Subscribe to index scrips ────────────────────────────────────────────
    _subscribeIndices() {
        const instruments = [
            { instrument_token: 'Nifty 50',  exchange_segment: 'nse_cm' },
            { instrument_token: 'Nifty Bank', exchange_segment: 'nse_cm' },
            { instrument_token: 'SENSEX',     exchange_segment: 'bse_cm' }
        ];

        // Kotak Socket.io raw websocket format – we only need to send a subscription request.
        const payloadStr = JSON.stringify([
            "pageload",
            {
                "inputtoken": "26000,26009",
                "exchange_segment": "nse_cm",
                "type": "sub"
            }
        ]);

        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send("42" + payloadStr);
            console.log('[KotakNeo] Subscription payload sent for Nifty 50, Nifty Bank, SENSEX.');
        } else {
            console.warn('[KotakNeo] Socket not open, cannot subscribe.');
        }
    }

    // ─── Parse a tick and emit a normalised event ─────────────────────────────
    _handleTick(data) {
        try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;

            // Kotak feed sends: { tk: "Nifty 50", ltp: "22150.00", ... }
            const token = msg.tk  || msg.instrument_token || msg.symbol;
            const price = parseFloat(msg.ltp || msg.lp || msg.last_price || msg.c);

            if (token && !isNaN(price)) {
                this.emit('tick', { token, price });
            }
        } catch (_) {
            // Non-JSON heartbeat frames – ignore
        }
        // Keep the session alive – if the socket closes, we will auto‑reconnect.
    }

    // ─── Session handling helpers ──────────────────────────────────────────────
    _saveSession() {
        const data = {
            sessionToken: this.sessionToken,
            sid: this.sid,
            tradingToken: this.tradingToken,
            tradingSid: this.tradingSid,
            apiBaseUrl: this.apiBaseUrl,
            wsUrl: this.wsUrl
        };
        try {
            fs.writeFileSync(this.sessionFile, JSON.stringify(data), { mode: 0o600 });
        } catch (e) {
            console.warn('[KotakNeo] Unable to persist session:', e.message);
        }
    }

    _loadSession() {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const raw = fs.readFileSync(this.sessionFile, 'utf8');
                const data = JSON.parse(raw);
                this.sessionToken = data.sessionToken;
                this.sid = data.sid;
                this.tradingToken = data.tradingToken;
                this.tradingSid = data.tradingSid;
                this.apiBaseUrl = data.apiBaseUrl;
                this.wsUrl = data.wsUrl || this.wsUrl;
                console.log('[KotakNeo] Loaded persisted session.');
                return true;
            }
        } catch (e) {
            console.warn('[KotakNeo] Failed to load session file:', e.message);
        }
        return false;
    }

    _clearSession() {
        try { fs.unlinkSync(this.sessionFile); } catch (_) {}
        this.sessionToken = null;
        this.sid = null;
        this.tradingToken = null;
        this.tradingSid = null;
        this.apiBaseUrl = null;
    }

    async _ensureAuthenticated() {
        // If we already have a trading token, assume it's still valid.
        if (this.tradingToken && this.tradingSid && this.apiBaseUrl) return;
        // Try to load persisted session.
        if (this._loadSession()) return;
        // Fallback to fresh login.
        console.log('[KotakNeo] No valid session – performing fresh login.');
        await this.login();
    }
        // No extra code needed here because _scheduleReconnect handles it.
}

module.exports = KotakNeoService;
