/**
 * Upstox Service – Market Data ONLY
 *
 * Upstox is used exclusively for:
 *   • Live market quotes (call/put prices)
 *   • Option chain data
 *   • Portfolio tracking & P&L
 *
 * All order management (place, modify, cancel, exit) goes through Kotak Neo ONLY.
 *
 * Docs: https://upstox.com/developer/api-documentation
 */
const axios = require('axios');

const BASE_URL = 'https://api.upstox.com/v2';

class UpstoxService {
  constructor() {
    this.accessToken = process.env.UPSTOX_ACCESS_TOKEN || null;
    this.apiKey = process.env.UPSTOX_API_KEY || null;
    this.apiSecret = process.env.UPSTOX_API_SECRET || null;
  }

  /** Build authorization headers */
  _headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Check whether we have a valid access token */
  isReady() {
    return !!this.accessToken;
  }

  // ── Market Data ───────────────────────────────────────────────────────────

  /**
   * Get live market quote for one or more instrument tokens.
   * @param {string|string[]} instrumentTokens  e.g. "NSE_FO|54819"
   * @returns {Promise<Object>}
   */
  async getQuote(instrumentTokens) {
    const tokens = Array.isArray(instrumentTokens)
      ? instrumentTokens.join(',')
      : instrumentTokens;
    const { data } = await axios.get(`${BASE_URL}/market-quote/quotes`, {
      headers: this._headers(),
      params: { instrument_key: tokens },
    });
    return data.data;
  }

  /**
   * Get option chain for an instrument.
   * Returns full call & put prices for all strikes at a given expiry.
   * @param {string} instrumentKey  e.g. "NSE_INDEX|Nifty 50"
   * @param {string} expiryDate     e.g. "2026-06-26"
   */
  async getOptionChain(instrumentKey, expiryDate) {
    const { data } = await axios.get(`${BASE_URL}/option/chain`, {
      headers: this._headers(),
      params: { instrument_key: instrumentKey, expiry_date: expiryDate },
    });
    return data.data;
  }

  /**
   * Get OHLC data for instruments.
   * @param {string} instrumentKey
   * @param {string} interval  e.g. "1minute", "1day"
   */
  async getOHLC(instrumentKey, interval = '1day') {
    const { data } = await axios.get(`${BASE_URL}/market-quote/ohlc`, {
      headers: this._headers(),
      params: { instrument_key: instrumentKey, interval },
    });
    return data.data;
  }

  /**
   * Get LTP (Last Traded Price) for instruments.
   * @param {string|string[]} instrumentTokens
   */
  async getLTP(instrumentTokens) {
    const tokens = Array.isArray(instrumentTokens)
      ? instrumentTokens.join(',')
      : instrumentTokens;
    const { data } = await axios.get(`${BASE_URL}/market-quote/ltp`, {
      headers: this._headers(),
      params: { instrument_key: tokens },
    });
    return data.data;
  }

  // ── Portfolio Tracking (read-only, for P&L display) ───────────────────────

  /** Fetch net positions (for P&L tracking display) */
  async getPositions() {
    const { data } = await axios.get(`${BASE_URL}/portfolio/short-term-positions`, {
      headers: this._headers(),
    });
    return data.data;
  }

  /** Fetch holdings (for portfolio display) */
  async getHoldings() {
    const { data } = await axios.get(`${BASE_URL}/portfolio/long-term-holdings`, {
      headers: this._headers(),
    });
    return data.data;
  }

  /** Fetch the order book (read-only, for display) */
  async getOrderBook() {
    const { data } = await axios.get(`${BASE_URL}/order/retrieve-all`, {
      headers: this._headers(),
    });
    return data.data;
  }

  /** Revoke the access token (logout) */
  async logout() {
    try {
      await axios.delete(`${BASE_URL}/logout`, { headers: this._headers() });
    } catch (e) {
      console.warn('[Upstox] Logout API error (token may already be expired):', e.message);
    }
    this.accessToken = null;
    console.log('[Upstox] Session cleared.');
    return { message: 'Upstox session cleared' };
  }
}

module.exports = UpstoxService;
