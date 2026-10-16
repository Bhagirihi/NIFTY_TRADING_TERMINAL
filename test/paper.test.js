'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPaperTrades, summarizePaper } = require('../src/paper');

test('paper: a bought put closes at the exit premium', () => {
  const trades = buildPaperTrades({
    index: 'BANKNIFTY',
    indexId: 'BANKNIFTY',
    lotSize: 15,
    signals: [
      { t: 1, timeIST: '09:15', type: 'BUY PE', strike: 55400, right: 'PE', premium: 527, reason: 'Market open, trend bearish' },
      { t: 2, timeIST: '09:30', type: 'EXIT PE', strike: 55400, right: 'PE', premium: 516.5, reason: 'Close crossed EMA 13' },
    ],
  });
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].status, 'CLOSED');
  assert.strictEqual(trades[0].qty, 15);
  assert.strictEqual(trades[0].investment, 7905);
  assert.strictEqual(trades[0].premiumPoints, -10.5);
  assert.strictEqual(trades[0].pnl, -157.5);
});

test('paper: an open call is marked at the live premium', () => {
  const trades = buildPaperTrades({
    index: 'NIFTY 50',
    indexId: 'NIFTY',
    lotSize: 25,
    markPremium: 180,
    signals: [
      { t: 1, timeIST: '09:15', type: 'BUY CE', strike: 22750, right: 'CE', premium: 129.8, stopLoss: 22552.61, target: 22757.95, reason: 'Supertrend flip to bullish' },
    ],
  });
  assert.strictEqual(trades[0].status, 'OPEN');
  assert.strictEqual(trades[0].qty, 25);
  assert.strictEqual(trades[0].investment, 3245);
  assert.strictEqual(trades[0].premiumPoints, 50.2);
  assert.strictEqual(trades[0].pnl, 1255);
  const book = summarizePaper(trades);
  assert.strictEqual(book.realized, 0);
  assert.strictEqual(book.unrealized, 1255);
  assert.strictEqual(book.total, 1255);
});

test('paper: realized and open trades add up across a re-entry', () => {
  const trades = buildPaperTrades({
    index: 'BANKNIFTY',
    indexId: 'BANKNIFTY',
    lotSize: 15,
    markPremium: 700,
    signals: [
      { t: 1, timeIST: '09:15', type: 'BUY PE', premium: 500 },
      { t: 2, timeIST: '09:30', type: 'EXIT PE', premium: 490 },
      { t: 3, timeIST: '09:45', type: 'BUY CE', strike: 55600, right: 'CE', premium: 680 },
    ],
  });
  const book = summarizePaper(trades);
  assert.strictEqual(trades[0].pnl, -150);
  assert.strictEqual(trades[1].status, 'OPEN');
  assert.strictEqual(trades[1].pnl, 300);
  assert.strictEqual(book.realized, -150);
  assert.strictEqual(book.unrealized, 300);
  assert.strictEqual(book.total, 150);
});
