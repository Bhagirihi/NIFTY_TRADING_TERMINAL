'use strict';

// Indicator helpers matching TradingView Pine semantics:
// - ta.rma : Wilder smoothing, seeded with the SMA of the first `length` values
//            (Pine seeds ta.rma/ta.ema with sma when the previous value is na).
// - ta.ema : alpha = 2/(length+1), same SMA seeding.
// - pivots : a pivot at bar j is only *confirmed* `right` bars later, exactly
//            like ta.pivothigh / ta.pivotlow (the value is known at bar j+right).

function trueRanges(candles) {
  const out = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
    } else {
      const pc = candles[i - 1].close;
      out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  return out;
}

function smaSeed(values, i, length) {
  let s = 0;
  for (let k = i - length + 1; k <= i; k++) s += values[k];
  return s / length;
}

function rmaSeries(values, length) {
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === length - 1) {
      prev = smaSeed(values, i, length);
      out[i] = prev;
    } else if (i >= length) {
      prev = (prev * (length - 1) + values[i]) / length;
      out[i] = prev;
    }
  }
  return out;
}

function emaSeries(values, length) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (length + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === length - 1) {
      prev = smaSeed(values, i, length);
      out[i] = prev;
    } else if (i >= length) {
      prev = alpha * values[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

// Returns arrays resAt/supAt where resAt[i] is the resistance level *known at bar i*
// (latest confirmed pivot high), same for support. NaN until the first confirmation.
function pivotLevels(candles, left, right) {
  const n = candles.length;
  const resAt = new Array(n).fill(NaN);
  const supAt = new Array(n).fill(NaN);
  let res = NaN;
  let sup = NaN;
  for (let i = 0; i < n; i++) {
    const j = i - right; // pivot candidate whose confirmation lands on bar i
    if (j >= left) {
      let isHigh = true;
      let isLow = true;
      for (let k = j - left; k <= j + right; k++) {
        if (k === j) continue;
        if (candles[k].high >= candles[j].high) isHigh = false;
        if (candles[k].low <= candles[j].low) isLow = false;
      }
      if (isHigh) res = candles[j].high;
      if (isLow) sup = candles[j].low;
    }
    resAt[i] = res;
    supAt[i] = sup;
  }
  return { resAt, supAt };
}

module.exports = { trueRanges, rmaSeries, emaSeries, pivotLevels };
