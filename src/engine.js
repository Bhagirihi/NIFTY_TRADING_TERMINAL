'use strict';

const fs = require('fs');
const path = require('path');
const { config, SYMBOLS, angelConfigured } = require('./config');
const { UpstoxProvider } = require('./data/upstox');
const { UpstoxFeed } = require('./data/upstox-feed');
const { AngelProvider } = require('./data/angelone');
const { FixtureProvider } = require('./data/fixture');
const { runStrategy } = require('./strategy');
const { nearestListedStrike, nearestStepStrike } = require('./strikes');
const { buildPaperTrades, summarizePaper } = require('./paper');
const { istParts, istDateKey, istTimeStr, istFullStr } = require('./time');
const { openingRead } = require('./predict');
const { earlyTrigger, priorSessionSide } = require('./early');

// Engine: keeps warm candles per symbol, runs the strategy over CLOSED candles
// only (bar-close convention, same as the paper log), tracks live LTP, and
// exposes a plain state object for the dashboard / API.

function recentDateKeys(days) {
  const keys = [];
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) keys.push(istDateKey(now - d * 86400000));
  return keys;
}

function isWeekend(dateKey) {
  const wd = new Date(`${dateKey}T12:00:00+05:30`).getUTCDay();
  return wd === 0 || wd === 6;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function pickStrike(price, symbol, book) {
  if (book && book.strikes && book.strikes.length) return nearestListedStrike(price, book.strikes);
  return nearestStepStrike(price, symbol.strikeStep);
}

function indexAtOrBefore(closed, t) {
  let idx = -1;
  for (let i = 0; i < closed.length; i++) {
    if (closed[i].t <= t) idx = i;
    else break;
  }
  return idx;
}

function premiumAt(candles, t) {
  if (!candles) return null;
  const bar = candles.find((c) => c.t === t);
  return bar ? round2(bar.close) : null;
}

// Walk the day's signals in order so an exit keeps the strike that was bought.
// Stop is the Supertrend at entry. Target is the pivot beyond the entry
// (resistance for a call, support for a put).
function withStrikes(signals, closed, run, symbol, book, optionCandles) {
  const indexOf = new Map(closed.map((c, i) => [c.t, i]));
  let held = null;
  return signals.map((s) => {
    const entry = s.type === 'BUY CE' || s.type === 'BUY PE';
    if (entry) {
      const i = indexOf.has(s.t) ? indexOf.get(s.t) : indexAtOrBefore(closed, s.t);
      if (i >= 0) {
        const right = s.type === 'BUY CE' ? 'CE' : 'PE';
        const strike = pickStrike(s.price, symbol, book);
        const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
        const stopLoss = round2(run.stValue[i]);
        const rawTarget = right === 'CE' ? run.resAt[i] : run.supAt[i];
        const targetOk = right === 'CE' ? rawTarget > s.price : rawTarget < s.price;
        held = { strike, right, key, stopLoss, target: targetOk ? round2(rawTarget) : null };
      }
    }
    const row = {
      ...s,
      strike: held ? held.strike : null,
      right: held ? held.right : null,
      premium: held ? (Number.isFinite(Number(s.premium)) ? round2(Number(s.premium)) : premiumAt(optionCandles[held.key], s.t)) : null,
      stopLoss: entry && held ? held.stopLoss : null,
      target: entry && held ? held.target : null,
    };
    if (!entry) held = null;
    return row;
  });
}

class Engine {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {});
    this.providers = [];
    this.active = null;
    this.candles = {}; // symbolId -> Map<t, candle>
    this.fastCandles = {}; // symbolId -> Map<t, today's 1-minute candle>
    this.ltp = {}; // symbolId -> number
    this.state = { status: 'starting', source: null, feed: null, updatedAt: null, symbols: {} };
    this.lastFingerprint = '';
    this.feed = null;
    this.publishSoon = null;
    this.optionBooks = {}; // symbolId -> { expiry, strikes, instruments, ltp }
    this.optionCandles = {}; // option instrument key -> today's 15m candles
    this.trackedOptionKeys = new Set();
    this.paperFp = '';
    this.earlyMarks = {};
    for (const s of SYMBOLS) {
      this.candles[s.id] = new Map();
      this.fastCandles[s.id] = new Map();
    }
  }

  buildProviders() {
    const want = config.dataSource;
    const list = [];
    if (want === 'fixture') {
      if (!config.fixtureDir) throw new Error('DATA_SOURCE=fixture but FIXTURE_DIR is not set');
      list.push(new FixtureProvider(config.fixtureDir));
      return list;
    }
    const upstox = config.upstox.accessToken ? new UpstoxProvider(config.upstox.accessToken) : null;
    const angel = angelConfigured() ? new AngelProvider(config.angel) : null;
    if (want === 'upstox') {
      if (!upstox) throw new Error('DATA_SOURCE=upstox but UPSTOX_ACCESS_TOKEN is missing in .env');
      list.push(upstox);
    } else if (want === 'angelone') {
      if (!angel) throw new Error('DATA_SOURCE=angelone but Angel credentials are incomplete in .env');
      list.push(angel);
    } else {
      // auto: Upstox first, Angel One as failover (both are realtime).
      if (upstox) list.push(upstox);
      if (angel) list.push(angel);
    }
    if (!list.length) {
      throw new Error(
        'No data source configured. Add UPSTOX_ACCESS_TOKEN (Upstox) or the ANGEL_* values (Angel One SmartAPI) to .env - see README.'
      );
    }
    return list;
  }

  async fetchDay(provider, symbol, dateKey) {
    const isToday = dateKey === istDateKey(Date.now());
    const rows = await provider.getCandlesForDate(symbol, dateKey, config.timeframeMinutes, isToday);
    const map = this.candles[symbol.id];
    for (const c of rows) map.set(c.t, c);
  }

  async loadWarmup(provider) {
    const keys = recentDateKeys(config.warmupDays).filter((k) => !isWeekend(k));
    for (const symbol of SYMBOLS) {
      for (const k of keys) {
        try {
          await this.fetchDay(provider, symbol, k);
        } catch (e) {
          console.error(`[engine] warmup ${symbol.id} ${k} via ${provider.name}: ${e.message}`);
        }
      }
    }
  }

  async refreshFast(provider) {
    const today = istDateKey(Date.now());
    for (const symbol of SYMBOLS) {
      try {
        const rows = await provider.getCandlesForDate(symbol, today, 1, true);
        const map = this.fastCandles[symbol.id];
        for (const c of rows) {
          if (istDateKey(c.t) === today) map.set(c.t, c);
        }
      } catch (e) {
        console.error(`[engine] 1m ${symbol.id} via ${provider.name}: ${e.message}`);
      }
    }
  }

  async refreshToday(provider) {
    const today = istDateKey(Date.now());
    const streaming = provider.name === 'UPSTOX' && this.feed && this.feed.connected;
    for (const symbol of SYMBOLS) {
      await this.fetchDay(provider, symbol, today);
      if (streaming) continue;
      try {
        const ltp = await provider.getLTP(symbol);
        if (Number.isFinite(ltp)) this.ltp[symbol.id] = ltp;
      } catch (e) {
        console.error(`[engine] LTP ${symbol.id} via ${provider.name}: ${e.message}`);
      }
    }
  }

  async refreshOptions(provider) {
    if (!provider || provider.name !== 'UPSTOX') return;
    const today = istDateKey(Date.now());
    const now = Date.now();
    const tfMs = config.timeframeMinutes * 60000;
    for (const symbol of SYMBOLS) {
      try {
        let book = this.optionBooks[symbol.id];
        if (!book || book.day !== today) {
          const contracts = await provider.getOptionContracts(symbol.upstoxKey);
          const expiries = [...new Set(contracts.map((c) => c.expiry))].filter((e) => e >= today).sort();
          const expiry = expiries[0];
          if (!expiry) continue;
          const listed = contracts.filter((c) => c.expiry === expiry);
          const instruments = {};
          for (const c of listed) instruments[`${c.strike_price}|${c.instrument_type}`] = c.instrument_key;
          book = {
            day: today,
            expiry,
            strikes: [...new Set(listed.map((c) => c.strike_price))].sort((a, b) => a - b),
            instruments,
            ltp: {},
          };
          this.optionBooks[symbol.id] = book;
        }
        const chain = await provider.getOptionChain(symbol.upstoxKey, book.expiry);
        const ltp = {};
        for (const row of chain) {
          for (const side of ['call_options', 'put_options']) {
            const opt = row[side];
            const px = opt && opt.market_data && opt.market_data.ltp;
            if (opt && opt.instrument_key && Number.isFinite(px)) ltp[opt.instrument_key] = px;
          }
        }
        book.ltp = ltp;

        const closed = [...this.candles[symbol.id].values()].filter((c) => c.t + tfMs <= now).sort((a, b) => a.t - b.t);
        const scout = runStrategy(closed, symbol.lotSize);
        const early = this.earlyEntryFor(symbol, closed, scout, now);
        const run = early ? runStrategy(closed, symbol.lotSize, { earlyEntry: early }) : scout;
        const keys = new Set();
        for (const s of run.signals) {
          if (s.dateKey !== today || (s.type !== 'BUY CE' && s.type !== 'BUY PE')) continue;
          const right = s.type === 'BUY CE' ? 'CE' : 'PE';
          const strike = pickStrike(s.price, symbol, book);
          const key = book.instruments[`${strike}|${right}`];
          if (key) keys.add(key);
        }
        if (run.position) {
          const right = run.position.side === 'LONG' ? 'CE' : 'PE';
          const strike = pickStrike(run.position.entryPrice, symbol, book);
          const key = book.instruments[`${strike}|${right}`];
          if (key) keys.add(key);
        }
        for (const key of keys) this.trackedOptionKeys.add(key);
        for (const key of keys) {
          this.optionCandles[key] = await provider.getCandlesForDate(
            { upstoxKey: key },
            today,
            config.timeframeMinutes,
            true
          );
        }
      } catch (e) {
        console.error(`[engine] options ${symbol.id}: ${e.message}`);
      }
    }
  }

  syncOptionFeed() {
    if (this.feed && this.trackedOptionKeys.size) this.feed.subscribe([...this.trackedOptionKeys]);
  }

  onFeedTick(tick) {
    const symbol = SYMBOLS.find((s) => s.upstoxKey === tick.instrumentKey);
    if (symbol) {
      this.ltp[symbol.id] = tick.ltp;
    } else if (this.trackedOptionKeys.has(tick.instrumentKey)) {
      for (const book of Object.values(this.optionBooks)) {
        if (book && book.ltp) book.ltp[tick.instrumentKey] = tick.ltp;
      }
    } else {
      return;
    }
    if (this.publishSoon) return;
    // Index ticks arrive many times a second. Publish at most once a second so
    // the dashboard price settles instead of repainting on every print.
    this.publishSoon = setTimeout(() => {
      this.publishSoon = null;
      try {
        this.publish();
      } catch (e) {
        console.error(`[engine] publish: ${e.message}`);
      }
    }, 1000);
  }

  syncFeed() {
    const upstox = this.active && this.active.name === 'UPSTOX' ? this.active : null;
    if (upstox && !this.feed) {
      this.feed = new UpstoxFeed(upstox.token, SYMBOLS.map((s) => s.upstoxKey), (tick) => this.onFeedTick(tick));
      this.feed.start();
    } else if (!upstox && this.feed) {
      this.feed.stop();
      this.feed = null;
    }
  }

  computeState() {
    const now = Date.now();
    const tfMs = config.timeframeMinutes * 60000;
    const todayKey = istDateKey(now);
    const out = {
      status: 'live',
      source: this.active ? this.active.name : null,
      feed: this.feed && this.feed.connected ? 'upstox' : null,
      updatedAt: istFullStr(now),
      symbols: {},
    };

    for (const symbol of SYMBOLS) {
      const all = [...this.candles[symbol.id].values()].sort((a, b) => a.t - b.t);
      const closed = all.filter((c) => c.t + tfMs <= now);
      const forming = all.length && all[all.length - 1].t + tfMs > now ? all[all.length - 1] : null;
      const scout = runStrategy(closed, symbol.lotSize);
      const early = this.earlyEntryFor(symbol, closed, scout, now);
      const run = this.ensureEarlyVisible(
        early ? runStrategy(closed, symbol.lotSize, { earlyEntry: early }) : scout,
        early,
        symbol.lotSize,
        closed
      );
      const last = closed.length - 1;

      const todayCandles = closed.filter((c) => istDateKey(c.t) === todayKey);
      const prevDayCandles = closed.filter((c) => istDateKey(c.t) !== todayKey);
      const prevClose = prevDayCandles.length ? prevDayCandles[prevDayCandles.length - 1].close : null;
      const ltp = Number.isFinite(this.ltp[symbol.id])
        ? this.ltp[symbol.id]
        : forming
          ? forming.close
          : last >= 0
            ? closed[last].close
            : null;

      const book = this.optionBooks[symbol.id];
      const struck = withStrikes(this.stampEarlyPremium(symbol, run.signals, book), closed, run, symbol, book, this.optionCandles);
      const todaySignals = struck.filter((s) => s.dateKey === todayKey);
      const closedToday = todaySignals.filter((s) => s.points !== undefined);
      const dayPoints = closedToday.reduce((a, s) => a + s.points, 0);
      const entryRow = [...struck].reverse().find((s) => s.type === 'BUY CE' || s.type === 'BUY PE');

      let position = null;
      if (run.position) {
        const p = run.position;
        const openPoints = ltp != null ? (p.side === 'LONG' ? ltp - p.entryPrice : p.entryPrice - ltp) : null;
        const right = p.side === 'LONG' ? 'CE' : 'PE';
        const strike = entryRow && entryRow.right === right ? entryRow.strike : pickStrike(p.entryPrice, symbol, book);
        const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
        const livePremium = key && book && book.ltp ? book.ltp[key] : null;
        position = {
          side: p.side,
          label: p.side === 'LONG' ? 'BUY CE' : 'BUY PE',
          entryPrice: p.entryPrice,
          entryTimeIST: istTimeStr(p.entryTime),
          qty: p.qty,
          openPoints: openPoints != null ? Math.round(openPoints * 100) / 100 : null,
          strike,
          right,
          premium: round2(livePremium),
          stopLoss: round2(p.stopLoss),
          trailingStop: round2(p.trailingStop),
          target: round2(p.target),
          trailingTarget: round2(p.trailingTarget),
        };
      }

      out.symbols[symbol.id] = {
        name: symbol.name,
        lotSize: symbol.lotSize,
        ltp,
        prevClose,
        change: ltp != null && prevClose != null ? Math.round((ltp - prevClose) * 100) / 100 : null,
        changePct: ltp != null && prevClose ? Math.round(((ltp - prevClose) / prevClose) * 10000) / 100 : null,
        lastCandleTimeIST: last >= 0 ? istTimeStr(closed[last].t) : null,
        supertrend: last >= 0 ? Math.round(run.stValue[last] * 100) / 100 : null,
        direction: last >= 0 ? run.direction[last] : null, // -1 bullish, +1 bearish
        ema13: last >= 0 && Number.isFinite(run.ema[last]) ? Math.round(run.ema[last] * 100) / 100 : null,
        support: last >= 0 && Number.isFinite(run.supAt[last]) ? run.supAt[last] : null,
        resistance: last >= 0 && Number.isFinite(run.resAt[last]) ? run.resAt[last] : null,
        position,
        signalsToday: todaySignals,
        dayPoints: Math.round(dayPoints * 100) / 100,
        prediction: openingRead([...(this.fastCandles[symbol.id] || new Map()).values()], ltp, now),
        chart: closed.slice(-100).map((c, k, arr) => {
          const gi = closed.length - arr.length + k;
          return {
            timeIST: istTimeStr(c.t),
            close: c.close,
            st: Number.isFinite(run.stValue[gi]) && run.stValue[gi] > 0 ? Math.round(run.stValue[gi] * 100) / 100 : null,
            dir: run.direction[gi],
            ema: Number.isFinite(run.ema[gi]) ? Math.round(run.ema[gi] * 100) / 100 : null,
          };
        }),
      };
    }

    const trades = [];
    for (const symbol of SYMBOLS) {
      const s = out.symbols[symbol.id];
      if (!s) continue;
      trades.push(
        ...buildPaperTrades({
          index: symbol.name,
          indexId: symbol.id,
          signals: s.signalsToday,
          lotSize: symbol.lotSize,
          markPremium: s.position ? s.position.premium : null,
        })
      );
    }
    trades.sort((a, b) => a.entryT - b.entryT || a.indexId.localeCompare(b.indexId));
    out.paper = summarizePaper(trades);
    return out;
  }

  earlyEntryFor(symbol, closed, run, now) {
    const side = priorSessionSide(closed, run.direction, now);
    const minutes = [...(this.fastCandles[symbol.id] || new Map()).values()];
    return earlyTrigger(minutes, side, now);
  }

  ensureEarlyVisible(run, early, lotSize, closed) {
    if (!early) return run;
    const present = run.signals.some((s) => s.t === early.t && (s.type === 'BUY CE' || s.type === 'BUY PE'));
    if (present) return run;
    const type = early.side === 'LONG' ? 'BUY CE' : 'BUY PE';
    const i = closed.length - 1;
    const st = i >= 0 ? run.stValue[i] : null;
    const stop = early.side === 'LONG' && st < early.price ? st : early.side === 'SHORT' && st > early.price ? st : null;
    const pivot = i >= 0 ? (early.side === 'LONG' ? run.resAt[i] : run.supAt[i]) : null;
    const targetOk = Number.isFinite(pivot) && (early.side === 'LONG' ? pivot > early.price : pivot < early.price);
    return {
      ...run,
      signals: run.signals.concat({
        t: early.t,
        timeIST: early.timeIST,
        dateKey: early.dateKey,
        type,
        side: early.side,
        price: early.price,
        qty: lotSize,
        reason: early.reason,
      }),
      position: run.position || {
        side: early.side,
        entryPrice: early.price,
        entryTime: early.t,
        entryIndex: closed.length,
        qty: lotSize,
        initialStop: stop,
        stopLoss: stop,
        trailingStop: stop,
        target: targetOk ? pivot : null,
        trailingTarget: null,
      },
    };
  }

  stampEarlyPremium(symbol, signals, book) {
    const day = istDateKey(Date.now());
    return signals.map((s) => {
      if (s.dateKey !== day || (s.type !== 'BUY CE' && s.type !== 'BUY PE')) return s;
      if (!String(s.reason || '').startsWith('5-minute close')) return s;
      const prev = this.earlyMarks[symbol.id];
      if (prev && prev.day === day && prev.t === s.t && Number.isFinite(prev.premium)) {
        return { ...s, premium: prev.premium };
      }
      const right = s.type === 'BUY CE' ? 'CE' : 'PE';
      const strike = pickStrike(s.price, symbol, book);
      const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
      const premium = key && book && book.ltp ? round2(book.ltp[key]) : null;
      if (premium == null) return s;
      this.earlyMarks[symbol.id] = { day, t: s.t, premium, strike, right };
      return { ...s, premium };
    });
  }

  loadEarlyMarks() {
    const day = istDateKey(Date.now());
    const file = path.join(__dirname, '..', 'paper', `${day}.json`);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.earlyMarks = saved.earlyMarks || {};
    } catch (_) {
      this.earlyMarks = {};
    }
  }

  savePaper() {
    const paper = this.state && this.state.paper;
    if (!paper) return;
    const fp = JSON.stringify(
      (paper.trades || []).map((t) => [t.indexId, t.entryT, t.status, t.entryPremium, t.exitPremium])
    );
    if (fp === this.paperFp) return;
    this.paperFp = fp;
    const day = istDateKey(Date.now());
    const dir = path.join(__dirname, '..', 'paper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${day}.json`),
      JSON.stringify({ date: day, ...paper, earlyMarks: this.earlyMarks, savedAt: new Date().toISOString() }, null, 2)
    );
  }

  publish() {
    this.state = this.computeState();
    const fp = `${this.state.feed}|${JSON.stringify(this.state.symbols)}`;
    this.savePaper();
    if (fp !== this.lastFingerprint) {
      this.lastFingerprint = fp;
      this.onUpdate(this.state);
    }
  }

  async tick() {
    // Try the active provider; on failure, fail over to the next configured one.
    const order = this.active ? [this.active, ...this.providers.filter((p) => p !== this.active)] : this.providers;
    let lastErr = null;
    for (const provider of order) {
      try {
        if (provider !== this.active) {
          console.log(`[engine] using data source: ${provider.name}`);
          this.active = provider;
          await this.loadWarmup(provider);
        }
        await this.refreshToday(provider);
        await this.refreshFast(provider);
        await this.refreshOptions(provider);
        this.syncFeed();
        this.syncOptionFeed();
        this.publish();
        return;
      } catch (e) {
        lastErr = e;
        console.error(`[engine] ${provider.name} failed: ${e.message}`);
        if (this.active === provider) this.active = null;
      }
    }
    this.state = { ...this.state, status: 'error', error: lastErr ? lastErr.message : 'all providers failed' };
    this.onUpdate(this.state);
  }

  async start() {
    this.providers = this.buildProviders();
    this.active = this.providers[0];
    console.log(`[engine] warming up with ${this.active.name} ...`);
    this.loadEarlyMarks();
    await this.loadWarmup(this.active);
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[engine] tick error:', e.message)), config.pollSeconds * 1000);
    console.log(`[engine] live. Upstox prices stream on the market feed. ${config.timeframeMinutes}m candles refresh every ${config.pollSeconds}s.`);
  }
}

module.exports = { Engine };
