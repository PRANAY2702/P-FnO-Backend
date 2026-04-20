const axios = require('axios');
const EventEmitter = require('events');
const { io: socketIo } = require('socket.io-client');

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

        this.wsUrl = 'https://wstreamer.kotaksecurities.com';

        this.sessionToken = null;
        this.sid         = null;
        this.serverId    = null;
        this.socket      = null;
        this._simRunning = false;
    }

    // ─── Auth header for Step-1 (Basic <base64 key:secret>) ────────────────
    _basicAuth() {
        const creds = `${this.config.consumerKey}:${this.config.consumerSecret}`;
        return 'Basic ' + Buffer.from(creds).toString('base64');
    }

    // ─── Simulation fallback ─────────────────────────────────────────────────
    startSimulation(reason) {
        if (this._simRunning) return;
        this._simRunning = true;
        console.log(`[KotakNeo] Live data unavailable (${reason}). Using simulated ticks.`);

        const spots = { NIFTY: 22000, BANKNIFTY: 48000, SENSEX: 73000 };
        setInterval(() => {
            spots.NIFTY     += (Math.random() - 0.5) * 10;
            spots.BANKNIFTY += (Math.random() - 0.5) * 25;
            spots.SENSEX    += (Math.random() - 0.5) * 30;

            this.emit('tick', { token: 'Nifty 50',  price: spots.NIFTY });
            this.emit('tick', { token: 'Nifty Bank', price: spots.BANKNIFTY });
            this.emit('tick', { token: 'SENSEX',     price: spots.SENSEX });
        }, 1000);
    }

    // ─── Step 1: Trade API Login (generates OTP / session-id) ────────────────
    async login() {
        if (!this.config.consumerKey) {
            this.startSimulation('Credentials not configured');
            return;
        }

        try {
            console.log('[KotakNeo] Initiating Trade API login…');

            const loginBody = {
                mobileNumber: this.config.mobileNumber,
                password:     this.config.password
            };

            const res = await axios.post(
                `${this.baseUrl}/v2/login/trading/validatePassword`,
                loginBody,
                {
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': this._basicAuth()
                    }
                }
            );

            const body = res.data;
            if (!body || !body.data) {
                console.error('[KotakNeo] Login step-1 failed:', JSON.stringify(body));
                this.startSimulation('Login step-1 rejected');
                return;
            }

            // sid is returned in step-1; needed for OTP validation
            this.sid = body.data.sid;
            console.log('[KotakNeo] Login step-1 OK. Proceeding to 2FA…');
            await this._validate2FA();

        } catch (err) {
            console.error('[KotakNeo] Login error:', err.message);
            this.startSimulation('Login HTTP error');
        }
    }

    // ─── Step 2: Validate 2FA with TOTP + MPIN ────────────────────────────────
    async _validate2FA() {
        try {
            const body2fa = {
                sid:  this.sid,
                totp: this.config.totp,   // 6-digit TOTP from authenticator
                mpin: this.config.mpin
            };

            const res = await axios.post(
                `${this.tradeApiBase}/login/1.0/login/v2/validate`,
                body2fa,
                {
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': this._basicAuth()
                    }
                }
            );

            const body = res.data;
            if (!body || !body.data || !body.data.token) {
                console.error('[KotakNeo] 2FA validation failed:', JSON.stringify(body));
                this.startSimulation('2FA rejected');
                return;
            }

            this.sessionToken = body.data.token;
            this.sid          = body.data.sid       || this.sid;
            this.serverId     = body.data.hsServerId || '';

            console.log('[KotakNeo] Session established. Connecting to live feed…');
            this._connectFeed();

        } catch (err) {
            console.error('[KotakNeo] 2FA error:', err.message);
            this.startSimulation('2FA HTTP error');
        }
    }

    // ─── Step 3: Connect to wstreamer via Socket.io ───────────────────────────
    _connectFeed() {
        if (!this.sessionToken) return;

        console.log('[KotakNeo] Connecting to wstreamer feed…');

        this.socket = socketIo(this.wsUrl, {
            path:       '/feed/',
            transports: ['websocket'],
            query: {
                Authorization: this.sessionToken,
                Sid:           this.sid
            },
            reconnection:        true,
            reconnectionAttempts: 10,
            reconnectionDelay:   3000
        });

        this.socket.on('connect', () => {
            console.log('[KotakNeo] Feed connected. Subscribing to indices…');
            this._subscribeIndices();
        });

        this.socket.on('message', (data) => {
            this._handleTick(data);
        });

        // Some versions emit on 'tick' directly
        this.socket.on('tick', (data) => {
            this._handleTick(data);
        });

        this.socket.on('disconnect', (reason) => {
            console.warn('[KotakNeo] Feed disconnected:', reason);
        });

        this.socket.on('connect_error', (err) => {
            console.error('[KotakNeo] Feed connection error:', err.message);
            this.emit('error', err);
        });
    }

    // ─── Subscribe to index scrips ────────────────────────────────────────────
    _subscribeIndices() {
        const instruments = [
            { instrument_token: 'Nifty 50',  exchange_segment: 'nse_cm' },
            { instrument_token: 'Nifty Bank', exchange_segment: 'nse_cm' },
            { instrument_token: 'SENSEX',     exchange_segment: 'bse_cm' }
        ];

        const payload = JSON.stringify({
            instrument_tokens: instruments,
            isIndex: true,
            isDepth: false
        });

        this.socket.emit('pageload', payload);
        console.log('[KotakNeo] Subscription payload sent for Nifty 50, Nifty Bank, SENSEX.');
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
    }
}

module.exports = KotakNeoService;
