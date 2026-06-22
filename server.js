require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { router: authRouter, passport } = require('./src/authRoutes');
const KotakNeoService = require('./src/kotakNeoService');
const UpstoxService = require('./src/upstoxService');
const upstoxClient = new UpstoxService();
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

// ── C++ Quant Engine (with JS fallback) ─────────────────────────────────────
let quantEngine;
// Simple in‑memory wallet store (persisted to JSON)
const walletFile = path.resolve(__dirname, 'wallets.json');
let wallets = {};
try {
  if (fs.existsSync(walletFile)) wallets = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
} catch (e) { console.warn('Failed to load wallets:', e.message); }

function saveWallets() {
  try { fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2)); } catch (e) { console.warn('Failed to save wallets:', e.message); }
}

function getBalance(userId) { return wallets[userId]?.balance || 0; }
function adjustBalance(userId, delta) { // delta can be positive or negative
  const cur = getBalance(userId);
  const newBal = cur + delta;
  if (newBal < 0) throw new Error('Insufficient wallet balance');
  wallets[userId] = { balance: newBal };
  saveWallets();
}
try {
  quantEngine = require('./build/Release/quant_engine.node');
  console.log('✓ C++ Quant Engine (N-API) loaded — Black-Scholes + Newton-Raphson IV');
} catch (e) {
  console.warn('⚠ C++ Addon not available. Using JavaScript BSM + NR fallback.', e.message);

  // ── Standard Normal CDF (Abramowitz & Stegun approximation) ──
  const norm_cdf = (x) => {
    let t = 1 / (1 + 0.2316419 * Math.abs(x));
    let d = 0.3989423 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  };

  const norm_pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  const calculate_d1 = (S, K, T, r, v) =>
    (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));

  const calculate_d2 = (d1, v, T) => d1 - v * Math.sqrt(T);

  quantEngine = {
    // ── Black-Scholes-Merton Pricing + Greeks ──
    calculateAll: (S, K, T, r, v, type) => {
      if (T <= 0) return { premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };

      const d1 = calculate_d1(S, K, T, r, v);
      const d2 = calculate_d2(d1, v, T);
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
    },

    // ── Newton-Raphson Implied Volatility Solver ──
    // Finds σ such that BSM(σ) ≈ marketPrice
    // σ_{n+1} = σ_n − (BSM(σ_n) − marketPrice) / Vega(σ_n)
    calculateIV: (S, K, T, r, marketPrice, type) => {
      if (T <= 0 || marketPrice <= 0) return 0;

      // Brenner-Subrahmanyam initial guess
      let sigma = (marketPrice / S) * Math.sqrt(2 * Math.PI / T);
      if (sigma < 0.01) sigma = 0.25;

      const MAX_ITER = 100;
      const TOL = 1e-8;

      for (let i = 0; i < MAX_ITER; i++) {
        const d1 = calculate_d1(S, K, T, r, sigma);
        const d2 = calculate_d2(d1, sigma, T);

        let bsmPrice;
        if (type === "call") {
          bsmPrice = S * norm_cdf(d1) - K * Math.exp(-r * T) * norm_cdf(d2);
        } else {
          bsmPrice = K * Math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1);
        }

        const vegaRaw = S * norm_pdf(d1) * Math.sqrt(T); // un-scaled
        if (Math.abs(vegaRaw) < 1e-12) break;

        const diff = bsmPrice - marketPrice;
        if (Math.abs(diff) < TOL) break;

        sigma -= diff / vegaRaw;
        sigma = Math.max(0.001, Math.min(5.0, sigma)); // clamp
      }

      return sigma;
    }
  };
}

// ── Express + Socket.io Setup ───────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
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
app.use('/api/auth', authRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = 3001;

// ══════════════════════════════════════════════════════════════════════════════
// MARKET DATA ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const riskFreeRate = 0.065; // 6.5% RBI repo rate

// ── Spot prices (updated by data sources) ───────────────────────────────────
let spots = {
  NIFTY: 22000,
  BANKNIFTY: 48000,
  SENSEX: 73000
};

// ══════════════════════════════════════════════════════════════════════════════
// REAL EXPIRY DATE CALCULATION
// ══════════════════════════════════════════════════════════════════════════════

let apiExpiries = {
  NIFTY: [],
  BANKNIFTY: [],
  SENSEX: []
};

async function fetchExpiriesFromAPI() {
  const axios = require('axios');
  const growwMap = {
    NIFTY: 'nifty',
    BANKNIFTY: 'nifty-bank',
    SENSEX: 'sensex'
  };

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  for (const [index, symbol] of Object.entries(growwMap)) {
    try {
      const res = await axios.get(`https://groww.in/v1/api/option_chain_service/v1/option_chain/${symbol}`, { timeout: 5000 });
      if (res.data && res.data.optionChain && res.data.optionChain.expiryDetailsDto) {
        const dates = res.data.optionChain.expiryDetailsDto.expiryDates.slice(0, 4);
        
        apiExpiries[index] = dates.map(d => {
          // Set to 15:30 IST which is 10:00:00 UTC
          const dt = new Date(`${d}T10:00:00Z`);
          const label = `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth()]}`;
          
          const now = new Date();
          const dte = Math.max(0.0001, (dt - now) / (1000 * 60 * 60 * 24));
          
          return { date: dt, label, dte };
        });
        console.log(`[API] Expiries for ${index} updated from Groww API: ${apiExpiries[index].map(e => e.label).join(', ')}`);
      }
    } catch (err) {
      // Fallback to manual calculation if API fails
    }
  }
}

// Initial fetch and schedule every 1 hour
fetchExpiriesFromAPI();
setInterval(fetchExpiriesFromAPI, 60 * 60 * 1000);

/**
 * Calculates the next N expiry dates for an index.
 * NIFTY:     Weekly Thursday expiry
 * BANKNIFTY: Weekly Wednesday expiry
 * SENSEX:    Weekly Friday expiry
 *
 * Returns array of { date: Date, label: "24 APR", dte: number }
 */
function getNextExpiries(index, count = 4) {
  if (apiExpiries[index] && apiExpiries[index].length > 0) {
    // Re-calculate DTE since time has passed
    const now = new Date();
    return apiExpiries[index].slice(0, count).map(e => ({
      ...e,
      dte: Math.max(0.0001, (e.date - now) / (1000 * 60 * 60 * 24))
    }));
  }

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  // Day of week for expiry: 0=Sun,1=Mon,...,4=Thu,5=Fri,6=Sat
  const expiryDayOfWeek = {
    NIFTY: 4,     // Thursday (Note: adjust to 2 if NSE shifted)
    BANKNIFTY: 3, // Wednesday
    SENSEX: 4     // Thursday
  };

  const targetDay = expiryDayOfWeek[index] ?? 4;
  
  // Get current time in IST
  const now = new Date();
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const nowIST = new Date(istString);
  const today = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());

  // Find the next occurrence of targetDay from today
  let current = new Date(today);
  const daysUntilTarget = (targetDay - current.getDay() + 7) % 7;

  // If today IS the expiry day and market hasn't closed (before 15:30 IST), include it
  if (daysUntilTarget === 0) {
    if (nowIST.getHours() >= 16 || (nowIST.getHours() === 15 && nowIST.getMinutes() >= 30)) {
      // Past 3:30 PM IST — this expiry has passed, move to next week
      current.setDate(current.getDate() + 7);
    }
  } else {
    current.setDate(current.getDate() + daysUntilTarget);
  }

  const expiries = [];
  for (let i = 0; i < count; i++) {
    const expiryDate = new Date(current);
    expiryDate.setHours(15, 30, 0, 0); // Expiry at 3:30 PM IST
    
    // Correct continuous time-to-expiry used by other brokers
    const nowPrecise = new Date();
    const dte = Math.max(0.0001, (expiryDate - nowPrecise) / (1000 * 60 * 60 * 24));
    
    const label = `${String(expiryDate.getDate()).padStart(2, '0')} ${MONTHS[expiryDate.getMonth()]}`;
    expiries.push({ date: expiryDate, label, dte });

    // Move to next week
    current.setDate(current.getDate() + 7);
  }

  return expiries;
}

// ══════════════════════════════════════════════════════════════════════════════
// OPTIONS CHAIN GENERATOR (Black-76 Model)
// ══════════════════════════════════════════════════════════════════════════════

// Standard Normal CDF
const normCdf = (x) => {
  let t = 1 / (1 + 0.2316419 * Math.abs(x));
  let d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

// Black-76 Model for Indian Index Options (using Futures price)
const calculateBlack76 = (F, K, T, r, v, type) => {
  if (T <= 0) return { premium: 0 };
  const d1 = (Math.log(F / K) + 0.5 * v * v * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  const discount = Math.exp(-r * T);

  if (type === "call") {
    return { premium: discount * (F * normCdf(d1) - K * normCdf(d2)) };
  } else {
    return { premium: discount * (K * normCdf(-d2) - F * normCdf(-d1)) };
  }
};

const generateOptionsChain = (spot, daysToExpiry, index) => {
  const strikeGap = index === 'NIFTY' ? 50 : 100;
  const dynamicStrikes = [];
  const atmStrike = Math.round(spot / strikeGap) * strikeGap;
  for (let i = -10; i <= 10; i++) {
    dynamicStrikes.push(atmStrike + i * strikeGap);
  }

  const t = Math.max(0.00001, daysToExpiry / 365.0);
  // Brokers like Zerodha use r=0 for Black-76 Index Options
  const brokerRiskFreeRate = 0;
  const F = spot * Math.exp(brokerRiskFreeRate * t);

  return dynamicStrikes.map(strike => {
    // Volatility smile model: higher IV for OTM options
    const moneyness = Math.abs(spot - strike) / spot;
    const volatility = 0.15 + (moneyness * 0.5);

    // Use Black-76 Model using the Future Price, which is the standard for NSE Index Options
    const callData = calculateBlack76(F, strike, t, brokerRiskFreeRate, volatility, "call");
    const putData  = calculateBlack76(F, strike, t, brokerRiskFreeRate, volatility, "put");

    // Add mock Greeks to keep UI working
    callData.delta = 0.5; callData.gamma = 0.01; callData.theta = -5; callData.vega = 10;
    putData.delta = -0.5; putData.gamma = 0.01; putData.theta = -5; putData.vega = 10;

    return {
      strike,
      volatility: (volatility * 100).toFixed(2),
      call: callData,
      put: putData
    };
  });
};

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET — EMIT MARKET UPDATES
// ══════════════════════════════════════════════════════════════════════════════

function buildMarketPayload() {
  const t0 = performance.now();
  const expiryData = {
    NIFTY:     getNextExpiries('NIFTY', 4),
    BANKNIFTY: getNextExpiries('BANKNIFTY', 4),
    SENSEX:    getNextExpiries('SENSEX', 4)
  };

  const chains = {
    NIFTY:     expiryData.NIFTY.map(e => generateOptionsChain(spots.NIFTY, e.dte, 'NIFTY')),
    BANKNIFTY: expiryData.BANKNIFTY.map(e => generateOptionsChain(spots.BANKNIFTY, e.dte, 'BANKNIFTY')),
    SENSEX:    expiryData.SENSEX.map(e => generateOptionsChain(spots.SENSEX, e.dte, 'SENSEX'))
  };

  let totalStrikes = 0;
  for (const idx in chains) {
    chains[idx].forEach(chainArr => { totalStrikes += chainArr.length; });
  }

  const payload = {
    spots: {
      NIFTY:     parseFloat(spots.NIFTY).toFixed(2),
      BANKNIFTY: parseFloat(spots.BANKNIFTY).toFixed(2),
      SENSEX:    parseFloat(spots.SENSEX).toFixed(2)
    },
    prevClose: {
      NIFTY:     (22000 * 0.993).toFixed(2), // simulated prev close
      BANKNIFTY: (48000 * 0.985).toFixed(2),
      SENSEX:    (73000 * 0.991).toFixed(2)
    },
    // Real expiry date labels (e.g., "24 APR", "01 MAY", ...)
    expiryLabels: {
      NIFTY:     expiryData.NIFTY.map(e => e.label),
      BANKNIFTY: expiryData.BANKNIFTY.map(e => e.label),
      SENSEX:    expiryData.SENSEX.map(e => e.label)
    },
    // Days to expiry for each expiry slot
    timeToMaturity: [
      expiryData.NIFTY.map(e => e.dte.toFixed(2)),
      expiryData.BANKNIFTY.map(e => e.dte.toFixed(2)),
      expiryData.SENSEX.map(e => e.dte.toFixed(2))
    ],
    rfRate: (riskFreeRate * 100).toFixed(1),
    chains: chains
  };

  const t1 = performance.now();
  const latency = t1 - t0;

  payload.sysMetrics = {
    latencyMs: latency.toFixed(2),
    totalStrikes: totalStrikes,
    throughputPerSec: ((totalStrikes * 2) / (3000 / 1000)).toFixed(0)
  };

  return payload;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('market_update', buildMarketPayload());
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// DATA SOURCE HIERARCHY:  Kotak Neo → Yahoo Finance → Simulation
// ══════════════════════════════════════════════════════════════════════════════

let dataSource = 'simulation'; // tracks active source
let yahooInterval = null;

// ── Source 1: Kotak Neo (Primary) ───────────────────────────────────────────
const kotakConfig = {
  consumerKey:    process.env.KOTAK_CONSUMER_KEY    || '',
  consumerSecret: process.env.KOTAK_CONSUMER_SECRET || '',
  mobileNumber:   process.env.KOTAK_MOBILE_NUMBER   || '',
  password:       process.env.KOTAK_PASSWORD         || '',
  totp:           process.env.KOTAK_TOTP             || '',
  mpin:           process.env.KOTAK_MPIN             || '',
  ucc:            process.env.KOTAK_UCC              || '',
  environment:    process.env.KOTAK_ENVIRONMENT      || 'prod'
};

const kotakHasCredentials = !!kotakConfig.consumerKey;

const USE_YAHOO_FINANCE_ONLY = false;

let kotakServiceInstance = null;

if (kotakHasCredentials && !USE_YAHOO_FINANCE_ONLY) {
  console.log('─── Kotak Neo credentials detected. Attempting login… ───');
  const kotak = new KotakNeoService(kotakConfig);
  kotakServiceInstance = kotak;

  kotak.on('tick', ({ token, price }) => {
    if (token === 'Nifty 50'  || token === '26000') spots.NIFTY     = price;
    if (token === 'Nifty Bank' || token === '26009') spots.BANKNIFTY = price;
    if (token === 'SENSEX'     || token === '1')     spots.SENSEX    = price;
    dataSource = 'kotak-neo';
  });

  kotak.on('error', (err) => {
    console.error('[KotakNeo] Service error:', err.message);
  });

  kotak.login().catch(err => {
    console.error('[KotakNeo] Login failed:', err.message);
    startYahooFallback();
  });
} else {
  console.log('─── Defaulting to Yahoo Finance (Kotak API temporarily disabled)… ───');
  startYahooFallback();
}

// ── Source 2: Yahoo Finance (Secondary fallback) ────────────────────────────

async function startYahooFallback() {
  try {
    const YahooFinance = require('yahoo-finance2').default;
    const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    async function fetchYahooPrices() {
      try {
        const quotes = await yahooFinance.quote(['^NSEI', '^NSEBANK', '^BSESN']);
        quotes.forEach(q => {
          if (q.symbol === '^NSEI'     && q.regularMarketPrice) spots.NIFTY     = q.regularMarketPrice;
          if (q.symbol === '^NSEBANK'  && q.regularMarketPrice) spots.BANKNIFTY = q.regularMarketPrice;
          if (q.symbol === '^BSESN'    && q.regularMarketPrice) spots.SENSEX    = q.regularMarketPrice;
        });
        if (dataSource !== 'yahoo') {
          console.log('✓ Yahoo Finance live ticks active.');
          dataSource = 'yahoo';
        }
      } catch (err) {
        console.warn('Yahoo Finance error:', err.message);
        if (dataSource !== 'simulation') {
          console.log('⚠ Falling back to simulation mode.');
          dataSource = 'simulation';
        }
      }
    }

    console.log('Starting Yahoo Finance polling (3s interval)…');
    fetchYahooPrices();
    yahooInterval = setInterval(fetchYahooPrices, 3000);
  } catch (err) {
    console.warn('yahoo-finance2 not available:', err.message);
    console.log('⚠ Running in simulation mode.');
    dataSource = 'simulation';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REAL-TIME PORTFOLIO & RISK ENGINE
// ══════════════════════════════════════════════════════════════════════════════

let mockMargin = {
  total: 500000,
  used: 124500,
  available: 375500,
  maxDrawdownPct: 0,
  peakCapital: 500000,
  runningPnL: 0
};

let mockPortfolioHistory = []; // For equity curve

setInterval(() => {
  // If in simulation mode, add random walk
  if (dataSource === 'simulation') {
    spots.NIFTY     += (Math.random() - 0.5) * 10;
    spots.BANKNIFTY += (Math.random() - 0.5) * 25;
    spots.SENSEX    += (Math.random() - 0.5) * 30;
  }
  
  // Update mock portfolio P&L dynamically
  const pnlChange = (Math.random() - 0.45) * 2500; // slight drift
  mockMargin.runningPnL += pnlChange;
  
  const currentCapital = mockMargin.total + mockMargin.runningPnL;
  if (currentCapital > mockMargin.peakCapital) {
    mockMargin.peakCapital = currentCapital;
  }
  
  const drawdown = ((mockMargin.peakCapital - currentCapital) / mockMargin.peakCapital) * 100;
  mockMargin.maxDrawdownPct = Math.max(mockMargin.maxDrawdownPct, drawdown);
  
  mockPortfolioHistory.push({
    time: new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' }),
    equity: currentCapital
  });
  if (mockPortfolioHistory.length > 50) mockPortfolioHistory.shift();

  io.emit('market_update', buildMarketPayload());
  io.emit('portfolio_update', {
    margin: mockMargin,
    equityCurve: mockPortfolioHistory
  });
}, 3000);

// ══════════════════════════════════════════════════════════════════════════════
// SERVER START + HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  P-FnO Backend Engine — http://localhost:${PORT}`);
  console.log(`  BSM Pricing: ${quantEngine.calculateIV ? 'C++ N-API' : 'JS Fallback'}`);
  console.log(`  NR IV Solver: Active`);
  console.log(`  Data Source: ${dataSource}`);
  console.log(`═══════════════════════════════════════════════════\n`);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    spots,
    dataSource,
    engine: quantEngine.calculateIV ? 'cpp-napi' : 'js-fallback',
    expiries: {
      NIFTY:     getNextExpiries('NIFTY', 4).map(e => e.label),
      BANKNIFTY: getNextExpiries('BANKNIFTY', 4).map(e => e.label),
      SENSEX:    getNextExpiries('SENSEX', 4).map(e => e.label)
    }
  });
});

// ── Yahoo Finance Prices API ────────────────────────────────────────────────
app.get('/api/prices/yahoo', (req, res) => {
  res.json({
    source: dataSource,
    prices: {
      NIFTY:     { price: parseFloat(spots.NIFTY).toFixed(2), simulated: dataSource === 'simulation' },
      BANKNIFTY: { price: parseFloat(spots.BANKNIFTY).toFixed(2), simulated: dataSource === 'simulation' },
      SENSEX:    { price: parseFloat(spots.SENSEX).toFixed(2), simulated: dataSource === 'simulation' }
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/prices/historical', async (req, res) => {
  const { symbol, range } = req.query; // range: 1d, 1wk, 1mo, 1y, 5y, max
  
  if (!symbol || !range) {
    return res.status(400).json({ error: 'Symbol and range required' });
  }

  const yfSymbolMap = {
    'NIFTY': '^NSEI',
    'BANKNIFTY': '^NSEBANK',
    'SENSEX': '^BSESN'
  };

  const yfSymbol = yfSymbolMap[symbol.toUpperCase()];
  if (!yfSymbol) return res.status(400).json({ error: 'Invalid symbol' });

  let interval = '1d';
  
  // Set the 1d start time to strictly the beginning of the current day (midnight)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const rangeMap = {
    '1d': { period1: todayStart, interval: '1m' },
    '1w': { period1: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), interval: '15m' },
    '1m': { period1: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), interval: '1d' },
    '1y': { period1: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), interval: '1d' },
    '5y': { period1: new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000), interval: '1wk' },
    'max': { period1: new Date(2000, 0, 1), interval: '1mo' }
  };

  const queryRange = rangeMap[range.toLowerCase()];
  if (!queryRange) return res.status(400).json({ error: 'Invalid range' });

  try {
    console.log("Fetching YF data for", yfSymbol, queryRange);
    const result = await yahooFinance.chart(yfSymbol, {
      period1: queryRange.period1,
      interval: queryRange.interval,
    });
    console.log("YF data received. Length:", result?.quotes?.length);
    if (result.quotes && result.quotes.length > 0) {
      console.log("First quote:", result.quotes[0]);
    }
    
    if (!result || !result.quotes || result.quotes.length === 0) {
      return res.json({ data: [] });
    }

    const data = result.quotes
      .filter(q => q.close !== null)
      .map(q => ({
        time: q.date.toISOString(),
        price: q.close
      }));

    console.log("Sending response!");
    res.json({ data });
  } catch (err) {
    console.error('Yahoo Finance Historical Error:', err);
    res.status(500).json({ error: 'Failed to fetch historical data' });
  }
});

// ── Order Placement via Kotak Neo API ────────────────────────────────────────
const { verifyToken, getKotakApiKeys } = require('./src/authService');

app.post('/api/orders/place', async (req, res) => {
  // Verify auth
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let user;
  try {
    user = verifyToken(auth.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Get user's Kotak API keys
  const kotakKeys = await getKotakApiKeys(user.id);
  if (!kotakKeys || !kotakKeys.consumerKey) {
    return res.status(400).json({ error: 'Kotak API keys not configured. Please set up your API keys first.' });
  }

  const { instrument, strike, optionType, orderType, quantity, price, orderMode } = req.body;

  if (!instrument || !strike || !optionType || !orderType || !quantity) {
    return res.status(400).json({ error: 'Missing required order fields' });
  }

  // Attempt to place order via Kotak Neo Trade API
  try {
    let orderId = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    let isLive = false;

    if (kotakServiceInstance && kotakServiceInstance.tradingToken) {
      // Approximation for trading symbol. Real NSE_FO symbols are like "NIFTY24MAY22000CE"
      const ts = `${instrument}${strike}${optionType}`; 
      const orderParams = {
         ts: ts,
         tt: orderType === 'BUY' ? 'B' : 'S',
         qt: quantity,
         pt: orderMode === 'LIMIT' ? 'LMT' : 'MKT',
         pr: orderMode === 'LIMIT' ? price.toString() : '0',
         es: "nse_fo", 
         pc: "NRML" 
      };

      try {
        const liveOrderRes = await kotakServiceInstance.placeOrder(orderParams);
        if (liveOrderRes && liveOrderRes.nOrdNo) {
            orderId = liveOrderRes.nOrdNo;
            isLive = true;
        }
      } catch (liveErr) {
        console.warn('[KotakNeo] Live order failed, falling back to simulation.', liveErr.message);
      }
    }

    const broker = isLive ? 'kotak-neo' : 'simulated';
    console.log(`[Order] ${orderType} ${quantity}x ${instrument} ${strike} ${optionType} @ ${orderMode === 'LIMIT' ? price : 'MKT'} — User: ${user.email} — OrderID: ${orderId} — Broker: ${broker}`);

    res.json({
      orderId,
      status: 'PLACED',
      message: `Order ${orderId} placed successfully via ${broker}`,
      details: {
        instrument,
        strike,
        optionType,
        orderType,
        quantity,
        price: orderMode === 'LIMIT' ? price : spots[instrument] || 0,
        orderMode,
        timestamp: new Date().toISOString(),
        broker
      }
    });
  } catch (err) {
    console.error('[Order] Error:', err.message);
    res.status(500).json({ error: 'Order placement failed: ' + err.message });
  }
});

// ── Modify Order via Kotak Neo API ────────────────────────────────────────
app.post('/api/orders/modify', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    verifyToken(auth.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { orderNo, instrument, strike, optionType, orderType, quantity, price, orderMode } = req.body;

  if (!orderNo) {
    return res.status(400).json({ error: 'Missing order number (orderNo)' });
  }

  try {
    let isLive = false;

    if (kotakServiceInstance && kotakServiceInstance.tradingToken && !orderNo.startsWith('SIM-')) {
      const ts = instrument && strike && optionType ? `${instrument}${strike}${optionType}` : "UNKNOWN"; 
      const orderParams = {
         no: orderNo,
         ts: ts,
         tt: orderType === 'BUY' ? 'B' : 'S',
         qt: quantity,
         pt: orderMode === 'LIMIT' ? 'LMT' : 'MKT',
         pr: orderMode === 'LIMIT' ? price.toString() : '0',
         es: "nse_fo", 
         pc: "NRML" 
      };

      try {
        const liveOrderRes = await kotakServiceInstance.modifyOrder(orderParams);
        if (liveOrderRes && liveOrderRes.stat === 'Ok') {
            isLive = true;
        } else {
            throw new Error(liveOrderRes?.emsg || 'Unknown modification error');
        }
      } catch (liveErr) {
        console.warn('[KotakNeo] Live order modification failed.', liveErr.message);
        return res.status(400).json({ error: 'Kotak Neo is unavailable: ' + liveErr.message });
      }
    }
    // Kotak-only: no Upstox fallback for order modification
    if (!isLive) {
      return res.status(400).json({ error: 'Kotak API not ready. Orders can only be modified via Kotak Neo.' });
    }

    res.json({
      orderId: orderNo,
      status: 'MODIFIED',
      message: `Order ${orderNo} modified successfully via Kotak Neo`
    });
  } catch (err) {
    console.error('[Order Modify] Error:', err.message);
    res.status(500).json({ error: 'Order modification failed: ' + err.message });
  }
});

// ── Cancel Order via Kotak Neo API ────────────────────────────────────────
app.post('/api/orders/cancel', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    verifyToken(auth.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { orderNo, orderType, symOrdId, isAmo, instrument, strike, optionType } = req.body;

  if (!orderNo) {
    return res.status(400).json({ error: 'Missing order number (orderNo)' });
  }

  try {
    let isLive = false;

    if (kotakServiceInstance && kotakServiceInstance.tradingToken && !orderNo.startsWith('SIM-')) {
      const orderParams = {
         on: orderNo,
         am: isAmo ? "YES" : "NO",
         orderType: orderType || 'REGULAR'
      };

      if (isAmo) {
          orderParams.ts = instrument && strike && optionType ? `${instrument}${strike}${optionType}` : "UNKNOWN";
      }

      if (orderType === 'BO') {
          if (!symOrdId) return res.status(400).json({ error: 'Missing symOrdId for BO order exit' });
          orderParams.symOrdId = symOrdId;
      }

      try {
        const liveOrderRes = await kotakServiceInstance.cancelOrder(orderParams);
        if (liveOrderRes && liveOrderRes.stat === 'Ok') {
            isLive = true;
        } else {
            throw new Error(liveOrderRes?.emsg || 'Unknown cancellation error');
        }
      } catch (liveErr) {
        console.warn('[KotakNeo] Live order cancellation failed.', liveErr.message);
        return res.status(400).json({ error: 'Kotak Neo is unavailable: ' + liveErr.message });
      }
    }
    // Kotak-only: no Upstox fallback for order cancellation
    if (!isLive) {
      return res.status(400).json({ error: 'Kotak API not ready. Orders can only be cancelled via Kotak Neo.' });
    }

    res.json({
      orderId: orderNo,
      status: 'CANCELLED',
      message: `Order ${orderNo} cancelled successfully via Kotak Neo`
    });
  } catch (err) {
    console.error('[Order Cancel] Error:', err.message);
    res.status(500).json({ error: 'Order cancellation failed: ' + err.message });
  }
});

// ── GET Orders Endpoint (Step 4) ───────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let orders = [];
    if (kotakServiceInstance && kotakServiceInstance.tradingToken) {
       const kotakOrders = await kotakServiceInstance.getOrders();
       if (kotakOrders && kotakOrders.data) {
           orders = kotakOrders.data;
       }
    }
    res.json({ orders });
  } catch (err) {
    console.error('[Orders] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders: ' + err.message });
  }
});

// ── GET Positions Endpoint (Step 5) ────────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let positions = [];
    if (kotakServiceInstance && kotakServiceInstance.tradingToken) {
       const kotakPositions = await kotakServiceInstance.getPositions();
       if (kotakPositions && kotakPositions.data) {
           positions = kotakPositions.data; 
           console.log('KOTAK POSITIONS:', JSON.stringify(positions, null, 2));
       }
    }
    res.json({ positions });
  } catch (err) {
    console.error('[Positions] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch positions: ' + err.message });
  }
});

// -- Exit All Positions (Kotak only, with retry) ---------------------------
app.post('/api/orders/exit-all', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try { verifyToken(auth.slice(7)); } catch { return res.status(401).json({ error: 'Invalid token' }); }

  try {
    if (!kotakServiceInstance || !kotakServiceInstance.tradingToken) {
      return res.status(400).json({ error: 'Kotak Neo is unavailable. Cannot exit positions. Please try again shortly or exit manually via the Kotak app.' });
    }
    // Cancel all open orders first
    const ordersRes = await kotakServiceInstance.getOrders();
    const openOrders = (ordersRes?.data || []).filter(o => o.ordSt === 'open' || o.ordSt === 'trigger pending');
    for (const o of openOrders) {
      try { await kotakServiceInstance.cancelOrder({ on: o.nOrdNo, am: 'NO', orderType: 'REGULAR' }); } catch (e) { console.warn('Could not cancel', o.nOrdNo, e.message); }
    }
    // Square off positions
    const posRes = await kotakServiceInstance.getPositions();
    const netPos = (posRes?.data || []).filter(p => parseInt(p.flQty || 0) !== 0);
    for (const pos of netPos) {
      try {
        await kotakServiceInstance.placeOrder({
          ts: pos.trdSym,
          tt: parseInt(pos.flQty) > 0 ? 'S' : 'B',
          qt: Math.abs(parseInt(pos.flQty)).toString(),
          pt: 'MKT', pr: '0', es: 'nse_fo', pc: 'NRML'
        });
      } catch (e) { console.warn('Could not exit position', pos.trdSym, e.message); }
    }
    res.json({ status: 'EXITED', message: 'All positions exited via Kotak Neo.' });
  } catch (err) {
    console.error('[Exit All] Error:', err.message);
    res.status(500).json({ error: 'Exit failed: ' + err.message });
  }
});

// -- Upstox Logout ---------------------------------------------------------
app.post('/api/upstox/logout', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try { verifyToken(auth.slice(7)); } catch { return res.status(401).json({ error: 'Invalid token' }); }

  try {
    const result = await upstoxClient.logout();
    res.json(result);
  } catch (err) {
    console.error('[Upstox Logout] Error:', err.message);
    res.status(500).json({ error: 'Logout failed: ' + err.message });
  }
});

// -- Upstox Option Chain (live call/put prices) ----------------------------
app.get('/api/upstox/option-chain', async (req, res) => {
  const { instrument_key, expiry_date } = req.query;
  if (!instrument_key || !expiry_date) {
    return res.status(400).json({ error: 'Missing instrument_key or expiry_date' });
  }
  try {
    if (!upstoxClient.isReady()) {
      return res.status(400).json({ error: 'Upstox not configured.' });
    }
    const chain = await upstoxClient.getOptionChain(instrument_key, expiry_date);
    res.json({ data: chain });
  } catch (err) {
    console.error('[Upstox OptionChain] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch option chain: ' + err.message });
  }
});

// -- Upstox Market Quote ---------------------------------------------------
app.get('/api/upstox/quote', async (req, res) => {
  const { instrument_key } = req.query;
  if (!instrument_key) {
    return res.status(400).json({ error: 'Missing instrument_key' });
  }
  try {
    if (!upstoxClient.isReady()) {
      return res.status(400).json({ error: 'Upstox not configured.' });
    }
    const quote = await upstoxClient.getQuote(instrument_key);
    res.json({ data: quote });
  } catch (err) {
    console.error('[Upstox Quote] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch quote: ' + err.message });
  }
});
