'use strict';

const { emaSeries, pivotLevels } = require('./indicators');
const { supertrendSeries } = require('./supertrend');
const { istParts, istDateKey, istTimeStr } = require('./time');

// Port of the strategy logic from the Pine v6 script
// "Nifty/BankNifty Multi-Index Strategy" (signals only - nothing here places orders):
//
//   Entry (only when flat):
//     BUY CE (long)  : Supertrend flips bullish (direction < 0), OR the 09:15 bar
//                      opens with direction already bullish.
//     BUY PE (short) : Supertrend flips bearish (direction > 0), OR the 09:15 bar
//                      opens with direction already bearish.
//   Dynamic exit, all from the market on each closed bar:
//     Stop loss        : Supertrend at entry. A later close through it exits.
//     Trailing stop    : the Supertrend ratcheted in the trade's favor. A close
//                        through the tighter level exits.
//     Target           : the latest confirmed pivot beyond price (resistance for
//                        a call, support for a put). A close through it exits.
//     Trailing target  : after the trade has earned the initial stop distance,
//                        a pullback of one current ATR from the best close exits.
//     EMA 13           : a close through EMA 13 still exits if none of the above did.
//   Square-off: any open position is closed on the first bar at/after 15:10 IST,
//               and no new entries are taken at/after 15:10 (the Pine block's intent).
//   Paper convention (same as the nightly paper log): entries/exits are booked at
//   the signal bar's CLOSE. Exits are evaluated from the bar after entry.
//
// Pine defaults kept: ST period 10, multiplier 3.0, EMA length 13,
// pivot left/right 15/15. Lot size is passed in (Nifty 65, Bank Nifty 30).

const DEFAULTS = {
  stPeriod: 10,
  stMultiplier: 3.0,
  emaLength: 13,
  srLeft: 15,
  srRight: 15,
};

function isSquareOffBar(p) {
  return p.hour > 15 || (p.hour === 15 && p.minute >= 10);
}

function protectiveStop(side, price, stValue) {
  if (!Number.isFinite(stValue) || stValue <= 0 || !Number.isFinite(price)) return null;
  if (side === 'LONG' && stValue < price) return stValue;
  if (side === 'SHORT' && stValue > price) return stValue;
  return null;
}

function tighten(side, current, candidate) {
  if (candidate == null) return current;
  if (current == null) return candidate;
  return side === 'LONG' ? Math.max(current, candidate) : Math.min(current, candidate);
}

// Levels carried on an open position. Stop and target come from the Supertrend
// and the confirmed pivots, and both only move with the market.
function seedLevels(side, entry, i, st, sr) {
  const stop = protectiveStop(side, entry, st.value[i]);
  const pivot = side === 'LONG' ? sr.resAt[i] : sr.supAt[i];
  const target = Number.isFinite(pivot) && (side === 'LONG' ? pivot > entry : pivot < entry) ? pivot : null;
  return {
    initialStop: stop,
    stopLoss: stop,
    trailingStop: stop,
    target,
    trailingTarget: null,
    peak: entry,
    trailOn: false,
  };
}

function refreshLevels(position, close, i, st, sr) {
  const long = position.side === 'LONG';
  const pivot = long ? sr.resAt[i] : sr.supAt[i];
  if (Number.isFinite(pivot) && (long ? pivot > close : pivot < close)) position.target = pivot;

  const liveStop = protectiveStop(position.side, close, st.value[i]);
  position.trailingStop = tighten(position.side, position.trailingStop, liveStop);

  position.peak = long ? Math.max(position.peak, close) : Math.min(position.peak, close);
  const risk = position.initialStop == null ? null : Math.abs(position.entryPrice - position.initialStop);
  const reward = long ? position.peak - position.entryPrice : position.entryPrice - position.peak;
  if (!position.trailOn && risk != null && risk > 0 && reward >= risk) position.trailOn = true;
  const atr = st.atr[i];
  if (position.trailOn && Number.isFinite(atr) && atr > 0) {
    position.trailingTarget = long ? position.peak - atr : position.peak + atr;
  }
}

// First matching rule wins. Capital protection comes before taking profit.
function marketExitReason(position, close) {
  const long = position.side === 'LONG';
  const stop = position.trailingStop != null ? position.trailingStop : position.stopLoss;
  if (stop != null && (long ? close < stop : close > stop)) {
    const moved = position.initialStop != null && (long ? stop > position.initialStop : stop < position.initialStop);
    return moved ? 'Trailing stop' : 'Stop loss';
  }
  if (position.target != null && (long ? close >= position.target : close <= position.target)) return 'Target';
  if (position.trailOn && position.trailingTarget != null) {
    const giveback = long
      ? close <= position.trailingTarget && close > position.entryPrice
      : close >= position.trailingTarget && close < position.entryPrice;
    if (giveback) return 'Trailing target';
  }
  return null;
}

// candles: [{ t (epoch ms, bar START), open, high, low, close }] in IST order.
// Returns per-bar computed series plus the signal list and the final open position.
function runStrategy(candles, lotSize, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const closes = candles.map((c) => c.close);
  const st = supertrendSeries(candles, cfg.stPeriod, cfg.stMultiplier);
  const ema = emaSeries(closes, cfg.emaLength);
  const sr = pivotLevels(candles, cfg.srLeft, cfg.srRight);

  const signals = [];
  let position = null; // { side:'LONG'|'SHORT', entryPrice, entryTime, entryIndex, qty }
  let entryIndex = -1;
  let squaredOffDate = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = istParts(c.t);
    const dateKey = istDateKey(c.t);
    const dir = st.direction[i];
    const timeIST = istTimeStr(c.t);

    const isMarketOpenBar = p.hour === 9 && p.minute === 15;
    const longCond = (st.flipped[i] && dir < 0) || (isMarketOpenBar && dir < 0);
    const shortCond = (st.flipped[i] && dir > 0) || (isMarketOpenBar && dir > 0);

    // A 5-minute close between 09:15 and 09:30 can open the trade before this
    // 15-minute bar exists. Once the 09:15 bar closes, that entry is kept and
    // the open-bar rule does not fire a second time. Exits still start on the
    // next 15-minute bar.
    const early = cfg.earlyEntry;
    if (!position && early && early.dateKey === dateKey && isMarketOpenBar) {
      position = {
        side: early.side,
        entryPrice: early.price,
        entryTime: early.t,
        entryIndex: i,
        qty: lotSize,
        ...seedLevels(early.side, early.price, i, st, sr),
      };
      entryIndex = i;
      const type = early.side === 'LONG' ? 'BUY CE' : 'BUY PE';
      signals.push({
        t: early.t,
        timeIST: early.timeIST,
        dateKey,
        type,
        side: early.side,
        price: early.price,
        qty: lotSize,
        reason: early.reason,
      });
    }

    // --- Entries (Pine section 3) ---
    if (!position && !isSquareOffBar(p) && squaredOffDate !== dateKey) {
      if (longCond) {
        position = {
          side: 'LONG',
          entryPrice: c.close,
          entryTime: c.t,
          entryIndex: i,
          qty: lotSize,
          ...seedLevels('LONG', c.close, i, st, sr),
        };
        entryIndex = i;
        signals.push({ t: c.t, timeIST, dateKey, type: 'BUY CE', side: 'LONG', price: c.close, qty: lotSize, reason: st.flipped[i] ? 'Supertrend flip to bullish' : 'Market open, trend bullish' });
      } else if (shortCond) {
        position = {
          side: 'SHORT',
          entryPrice: c.close,
          entryTime: c.t,
          entryIndex: i,
          qty: lotSize,
          ...seedLevels('SHORT', c.close, i, st, sr),
        };
        entryIndex = i;
        signals.push({ t: c.t, timeIST, dateKey, type: 'BUY PE', side: 'SHORT', price: c.close, qty: lotSize, reason: st.flipped[i] ? 'Supertrend flip to bearish' : 'Market open, trend bearish' });
      }
    }

    // Exits use the levels from previous bars, then the survivors are refreshed.
    if (position && i > entryIndex) {
      const long = position.side === 'LONG';
      let reason = marketExitReason(position, c.close);
      if (!reason && ((long && c.close < ema[i]) || (!long && c.close > ema[i]))) reason = 'Close crossed EMA 13';
      if (reason) {
        const type = long ? 'EXIT CE' : 'EXIT PE';
        const pts = long ? c.close - position.entryPrice : position.entryPrice - c.close;
        signals.push({ t: c.t, timeIST, dateKey, type, side: position.side, price: c.close, qty: position.qty, points: round2(pts), reason });
        position = null;
      } else {
        refreshLevels(position, c.close, i, st, sr);
      }
    }

    // --- End-of-day square-off (Pine section 5) ---
    if (position && isSquareOffBar(p)) {
      const pts = position.side === 'LONG' ? c.close - position.entryPrice : position.entryPrice - c.close;
      signals.push({ t: c.t, timeIST, dateKey, type: 'SQOFF', side: position.side, price: c.close, qty: position.qty, points: round2(pts), reason: '15:10 square-off' });
      position = null;
      squaredOffDate = dateKey;
    }
  }

  const last = candles.length - 1;
  return {
    stValue: st.value,
    direction: st.direction,
    flipped: st.flipped,
    ema,
    resAt: sr.resAt,
    supAt: sr.supAt,
    signals,
    position,
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { runStrategy, DEFAULTS, marketExitReason, refreshLevels };
