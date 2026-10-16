'use strict';

// Upstox API provider (realtime, uses YOUR access token from .env).
// - Candles: v3 historical-candle API (supports 15minute; v2 did not).
// - LTP:     v2 market-quote/ltp, used when the V3 market-data websocket is down.
// Docs shapes verified 2026-10-15: candles come back as
// [isoTimestamp, open, high, low, close, volume, oi], newest first.

const BASE = 'https://api.upstox.com';

class UpstoxProvider {
  constructor(accessToken) {
    this.name = 'UPSTOX';
    this.token = accessToken;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
  }

  async fetchJson(url) {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Upstox ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    return res.json();
  }

  parseCandles(json) {
    const rows = (json && json.data && json.data.candles) || [];
    return rows
      .map((r) => ({ t: Date.parse(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] || 0 }))
      .filter((c) => Number.isFinite(c.t))
      .sort((a, b) => a.t - b.t);
  }

  // Candles for one IST date ('YYYY-MM-DD'). Uses the intraday endpoint for
  // today (freshest), historical for any other day.
  async getCandlesForDate(symbol, dateKey, intervalMinutes, isToday) {
    const key = encodeURIComponent(symbol.upstoxKey);
    if (isToday) {
      try {
        const j = await this.fetchJson(`${BASE}/v3/historical-candle/intraday/${key}/minutes/${intervalMinutes}`);
        const candles = this.parseCandles(j);
        if (candles.length) return candles;
      } catch (_) {
        /* fall through to historical */
      }
    }
    const j = await this.fetchJson(
      `${BASE}/v3/historical-candle/${key}/minutes/${intervalMinutes}/${dateKey}/${dateKey}`
    );
    return this.parseCandles(j);
  }

  async getOptionContracts(instrumentKey) {
    const j = await this.fetchJson(`${BASE}/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
    return (j && j.data) || [];
  }

  async getOptionChain(instrumentKey, expiry) {
    const j = await this.fetchJson(
      `${BASE}/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`
    );
    return (j && j.data) || [];
  }

  async getLTP(symbol) {
    const key = encodeURIComponent(symbol.upstoxKey);
    const j = await this.fetchJson(`${BASE}/v2/market-quote/ltp?instrument_key=${key}`);
    const values = Object.values((j && j.data) || {});
    if (!values.length || !Number.isFinite(values[0].last_price)) throw new Error('Upstox LTP: empty response');
    return values[0].last_price;
  }
}

module.exports = { UpstoxProvider };
