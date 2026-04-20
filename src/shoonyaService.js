const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');

class ShoonyaService extends EventEmitter {
    constructor(config) {
        super();
        this.config = config; // { uid, pwd, factor2, vc, appkey, imei }
        this.baseUrl = 'https://api.shoonya.com/NorenWClientTP';
        this.wsUrl = 'wss://api.shoonya.com/NorenWSTP/';
        this.susertoken = null;
        this.ws = null;
    }

    // SHA256 hashing for password and AppKey
    sha256(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    startSimulation(reason) {
        console.log(`Shoonya Live Data unavailable: ${reason}. Using simulated market ticks for previewing.`);
        let spots = {
            '26000': 22000, // NIFTY
            '26009': 48000, // BANKNIFTY
            '1': 73000      // SENSEX
        };
        setInterval(() => {
            Object.keys(spots).forEach(token => {
                const movement = (Math.random() - 0.5) * (spots[token] * 0.001); // 0.1% max movement
                spots[token] += movement;
                this.emit('tick', { token: token, price: spots[token] });
            });
        }, 1000);
    }

    async login() {
        if (!this.config.uid) {
            this.startSimulation("Credentials not configured");
            return;
        }

        try {
            console.log("Attempting Shoonya Login...");
            const payload = {
                apkversion: "js:1.0.0",
                uid: this.config.uid,
                pwd: this.sha256(this.config.pwd),
                factor2: this.config.factor2,
                vc: this.config.vc,
                appkey: this.sha256(`${this.config.uid}|${this.config.appkey}`),
                imei: this.config.imei,
                source: "API"
            };

            const response = await axios.post(`${this.baseUrl}/QuickAuth`, `jData=${JSON.stringify(payload)}`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            if (response.data && response.data.stat === "Ok") {
                this.susertoken = response.data.susertoken;
                console.log("Shoonya Login Successful!");
                this.connectWebSocket();
            } else {
                console.error("Shoonya Login Failed: ", response.data.emsg || response.data);
                this.startSimulation("API Rejected");
            }
        } catch (error) {
            console.error("Shoonya Login Error: ", error.message);
            this.startSimulation("API Error or 502 Bad Gateway");
        }
    }

    connectWebSocket() {
        if (!this.susertoken) return;

        console.log("Connecting to Shoonya WebSocket...");
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log("Shoonya WebSocket connected. Sending init payload...");
            const initPayload = {
                t: "c",
                uid: this.config.uid,
                actid: this.config.uid,
                source: "API",
                susertoken: this.susertoken
            };
            this.ws.send(JSON.stringify(initPayload));
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            
            // Connection acknowledgment
            if (message.t === 'ck' && message.s === 'OK') {
                console.log("Shoonya WebSocket authenticated. Subscribing to indices...");
                this.subscribeIndices();
            }
            
            // Touchline data (e.g., tick updates)
            if (message.t === 'tf' || message.t === 'tk') {
                const lp = parseFloat(message.lp || message.c);
                if (!isNaN(lp)) {
                    this.emit('tick', {
                        exchange: message.e,
                        token: message.tk,
                        price: lp 
                    });
                }
            }
        });

        this.ws.on('close', () => {
             console.log("Shoonya WebSocket closed. Attempting to reconnect in 5 seconds...");
             setTimeout(() => this.connectWebSocket(), 5000);
        });

        this.ws.on('error', (err) => {
             console.error("Shoonya WebSocket Error:", err.message);
        });
    }

    subscribeIndices() {
        // NIFTY: '26000' in NSE, BANKNIFTY: '26009' in NSE, SENSEX: '1' in BSE
        const payload = {
            t: "t", 
            k: "NSE|26000#NSE|26009#BSE|1" 
        };
        this.ws.send(JSON.stringify(payload));
    }
}

module.exports = ShoonyaService;
