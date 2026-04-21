require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { router: authRouter, passport } = require('./src/authRoutes');
const KotakNeoService = require('./src/kotakNeoService');
let quantEngine;
try {
  quantEngine = require('./build/Release/quant_engine.node');
  console.log('Successfully loaded C++ Quant Engine N-API addon.');
} catch (e) {
  console.warn('Failed to load C++ Addon. Falling back to Javascript BSM engine.', e.message);
  
  // Standard Normal CDF
  const norm_cdf = (x) => {
    let t = 1 / (1 + 0.2316419 * Math.abs(x));
    let d = 0.3989423 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  };

  const norm_pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  quantEngine = {
    calculateAll: (S, K, T, r, v, type) => {
      if (T <= 0) return { premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
      
      const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
      const d2 = d1 - v * Math.sqrt(T);
      const gamma = norm_pdf(d1) / (S * v * Math.sqrt(T));
      const vega = (S * norm_pdf(d1) * Math.sqrt(T)) / 100;
      
      if (type === "call") {
        return {
          premium: S * norm_cdf(d1) - K * Math.exp(-r * T) * norm_cdf(d2),
          delta: norm_cdf(d1),
          gamma, vega,
          theta: (-S * norm_pdf(d1) * v / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * norm_cdf(d2)) / 365,
          rho: (K * T * Math.exp(-r * T) * norm_cdf(d2)) / 100
        };
      } else {
        return {
          premium: K * Math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1),
          delta: norm_cdf(d1) - 1,
          gamma, vega,
          theta: (-S * norm_pdf(d1) * v / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * norm_cdf(-d2)) / 365,
          rho: (-K * T * Math.exp(-r * T) * norm_cdf(-d2)) / 100
        };
      }
    }
  };
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'pfno-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── Auth Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = 3001;

// Market Simulator State
let spots = {
    NIFTY: 22000,
    BANKNIFTY: 48000,
    SENSEX: 73000
};
let timeToMaturity = 14.0 / 365.0; // 14 days to maturity
const riskFreeRate = 0.065; // 6.5% interest rate
const generateOptionsChain = (spot) => {
    const dynamicStrikes = [];
    const atmStrike = Math.round(spot / 50) * 50;
    for (let i = -10; i <= 10; i++) {
        dynamicStrikes.push(atmStrike + i * 50);
    }

    return dynamicStrikes.map(strike => {
        const moneyness = Math.abs(spot - strike) / spot;
        const volatility = 0.15 + (moneyness * 0.5); 

        const callData = quantEngine.calculateAll(spot, strike, timeToMaturity, riskFreeRate, volatility, "call");
        const putData = quantEngine.calculateAll(spot, strike, timeToMaturity, riskFreeRate, volatility, "put");

        return {
            strike,
            volatility: (volatility * 100).toFixed(2),
            call: callData,
            put: putData
        };
    });
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.emit('market_update', {
    spots: { NIFTY: spots.NIFTY, BANKNIFTY: spots.BANKNIFTY, SENSEX: spots.SENSEX },
    timeToMaturity: (timeToMaturity * 365).toFixed(0),
    rfRate: (riskFreeRate * 100).toFixed(1),
    chains: {
        NIFTY: generateOptionsChain(spots.NIFTY),
        BANKNIFTY: generateOptionsChain(spots.BANKNIFTY),
        SENSEX: generateOptionsChain(spots.SENSEX)
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ── Start server first so it always binds ───────────────────────────────────
server.listen(PORT, () => {
  console.log(`Backend Market Engine running on http://localhost:${PORT}`);
});

// ── Simulation fallback (used when Kotak Neo is unavailable) ────────────────
function startSimulation() {
  console.log('Starting simulated market tick interval...');
  setInterval(() => {
    spots.NIFTY     += (Math.random() - 0.499) * 8;
    spots.BANKNIFTY += (Math.random() - 0.499) * 20;
    spots.SENSEX    += (Math.random() - 0.499) * 25;
    timeToMaturity  -= 0.000002;
    if (timeToMaturity <= 0) timeToMaturity = 0;

    io.emit('market_update', {
      spots: {
        NIFTY:     spots.NIFTY.toFixed(2),
        BANKNIFTY: spots.BANKNIFTY.toFixed(2),
        SENSEX:    spots.SENSEX.toFixed(2)
      },
      timeToMaturity: (timeToMaturity * 365).toFixed(2),
      rfRate: (riskFreeRate * 100).toFixed(1),
      chains: {
        NIFTY:     generateOptionsChain(spots.NIFTY),
        BANKNIFTY: generateOptionsChain(spots.BANKNIFTY),
        SENSEX:    generateOptionsChain(spots.SENSEX)
      }
    });
  }, 800);
}

// ── Kotak Neo API Integration (optional, falls back gracefully) ──────────────
const kotakNeo = new KotakNeoService({
    consumerKey:    process.env.KOTAK_CONSUMER_KEY    || "",
    consumerSecret: process.env.KOTAK_CONSUMER_SECRET || "",
    mobileNumber:   process.env.KOTAK_MOBILE_NUMBER   || "",
    password:       process.env.KOTAK_PASSWORD         || "",
    totp:           process.env.KOTAK_TOTP             || "",
    mpin:           process.env.KOTAK_MPIN             || "",
    environment:    process.env.KOTAK_ENVIRONMENT      || "prod"
});

// Kotak Neo uses string token names for indices
const tokenToIndex = {
    'Nifty 50':  'NIFTY',
    'Nifty Bank': 'BANKNIFTY',
    'SENSEX':    'SENSEX'
};

let useLiveData = false;

// Try Kotak Neo login; fall back to simulation if unavailable
try {
  kotakNeo.on('error', (err) => {
    if (!useLiveData) {
      console.warn('Kotak Neo error — running in simulation mode:', err?.message ?? err);
      startSimulation();
    }
  });

  kotakNeo.on('tick', (data) => {
    const indexName = tokenToIndex[data.token];
    if (!indexName) return;
    if (!useLiveData) { useLiveData = true; console.log('Live Kotak Neo ticks active.'); }

    spots[indexName] = data.price;
    timeToMaturity  -= 0.000001;
    if (timeToMaturity <= 0) timeToMaturity = 0;

    io.emit('market_update', {
      spots: {
        NIFTY:     spots.NIFTY.toFixed(2),
        BANKNIFTY: spots.BANKNIFTY.toFixed(2),
        SENSEX:    spots.SENSEX.toFixed(2)
      },
      timeToMaturity: (timeToMaturity * 365).toFixed(2),
      rfRate: (riskFreeRate * 100).toFixed(1),
      chains: {
        NIFTY:     generateOptionsChain(spots.NIFTY),
        BANKNIFTY: generateOptionsChain(spots.BANKNIFTY),
        SENSEX:    generateOptionsChain(spots.SENSEX)
      }
    });
  });

  kotakNeo.login();

  // If no live tick arrives in 8 s, fall back to simulation
  setTimeout(() => {
    if (!useLiveData) {
      console.warn('No Kotak Neo ticks in 8 s — switching to simulation mode.');
      startSimulation();
    }
  }, 8000);

} catch (err) {
  console.warn('Kotak Neo init failed — simulation mode:', err.message);
  startSimulation();
}

// Basic health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', spots, mode: useLiveData ? 'live (Kotak Neo)' : 'simulation' });
});

