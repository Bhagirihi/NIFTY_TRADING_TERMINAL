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
const { istParts, istDateKey, istTimeStr, istFullStr, istToEpoch } = require('./time');
const { openingRead } = require('./predict');

// Engine: keeps warm candles per symbol, runs the strategy on finished bars
// plus the candle that is still trading, and locks a signal at the moment it
// fires so a later tick cannot take it back. Live LTP updates that candle.

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

function snapshotLevels(position) {
  if (!position) return null;
  return {
    initialStop: position.initialStop ?? null,
    stopLoss: position.stopLoss ?? null,
    trailingStop: position.trailingStop ?? null,
    target: position.target ?? null,
    trailingTarget: position.trailingTarget ?? null,
    peak: position.peak,
    trailOn: !!position.trailOn,
  };
}

function contractPremium(book, strike, right) {
  if (!book || strike == null || !right) return null;
  const key = book.instruments[`${strike}|${right}`];
  const px = key && book.ltp ? Number(book.ltp[key]) : NaN;
  return round2(px);
}

// Start of the bar that is trading now, labeled by its open.
// At 11:24 on a 15-minute book that bar opened at 11:15. Null outside 09:15–15:30.
function liveBarStart(now, tfMin) {
  const p = istParts(now);
  const mins = p.hour * 60 + p.minute;
  if (mins < 9 * 60 + 15 || mins >= 15 * 60 + 30) return null;
  const slot = Math.floor(mins / tfMin) * tfMin;
  return istToEpoch(istDateKey(now), Math.floor(slot / 60), slot % 60);
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
    this.moments = {}; // symbolId -> decisions taken on a live candle
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
    const now = Date.now();
    const tfMs = config.timeframeMinutes * 60000;
    for (const c of rows) {
      const prev = map.get(c.t);
      // The bar still trading keeps the higher high and lower low already
      // seen on the feed. Its close is the latest price.
      if (prev && c.t + tfMs > now) {
        const ltp = this.ltp[symbol.id];
        map.set(c.t, {
          t: c.t,
          open: c.open,
          high: Math.max(prev.high, c.high),
          low: Math.min(prev.low, c.low),
          close: Number.isFinite(ltp) ? ltp : c.close,
          volume: c.volume || 0,
        });
      } else {
        map.set(c.t, c);
      }
    }
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

        const { run } = this.evaluate(symbol, Date.now());
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

  // The bar that is open now. Its close is the latest price, and its high and
  // low only widen. A tick before the poll arrives starts the bar.
  touchLiveCandle(symbolId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const start = liveBarStart(now, config.timeframeMinutes);
    const map = this.candles[symbolId];
    if (start == null || !map) return;
    let bar = map.get(start);
    if (!bar) {
      map.set(start, { t: start, open: price, high: price, low: price, close: price, volume: 0, provisional: true });
      return;
    }
    bar.close = price;
    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
  }

  // Finished bars, plus the one bar still trading. A provisional bar that has
  // reached its close becomes a normal bar so a decision taken on it remains.
  candlesNow(symbolId, now) {
    const tfMs = config.timeframeMinutes * 60000;
    const map = this.candles[symbolId];
    const start = liveBarStart(now, config.timeframeMinutes);
    for (const bar of map.values()) {
      if (bar.provisional && bar.t + tfMs <= now) delete bar.provisional;
    }
    const all = [...map.values()].sort((a, b) => a.t - b.t);
    const forming = start != null ? map.get(start) || null : null;
    const closed = all.filter((c) => c !== forming && c.t + tfMs <= now);
    const series = forming ? closed.concat([forming]) : closed;
    return { closed, forming, series };
  }

  evaluate(symbol, now) {
    const pack = this.candlesNow(symbol.id, now);
    const day = istDateKey(now);
    const locks = (this.moments[symbol.id] || []).filter((m) => m.dateKey === day);
    const run = runStrategy(pack.series, symbol.lotSize, {
      locks,
      liveBarT: pack.forming ? pack.forming.t : null,
      now,
    });
    this.commitLiveMoment(symbol, run, pack.forming, now);
    return { ...pack, run };
  }

  // The first time the live candle breaks a level, keep that price, that
  // clock time, and the option premium. Later ticks replay the lock.
  commitLiveMoment(symbol, run, forming, now) {
    if (!forming) return;
    const book = this.optionBooks[symbol.id];
    const day = istDateKey(now);
    const locks = (this.moments[symbol.id] || []).filter((m) => m.dateKey === day);
    const map = new Map(locks.map((m) => [`${m.barT}|${m.type}`, m]));
    let held = null;
    run.signals = run.signals.map((s) => {
      const entry = s.type === 'BUY CE' || s.type === 'BUY PE';
      const barT = s.barT != null ? s.barT : s.t;
      if (barT !== forming.t) {
        held = entry ? { price: s.price, right: s.type === 'BUY CE' ? 'CE' : 'PE' } : null;
        return s;
      }
      const key = `${barT}|${s.type}`;
      let lock = map.get(key);
      const right = entry ? (s.type === 'BUY CE' ? 'CE' : 'PE') : (held ? held.right : (s.side === 'LONG' ? 'CE' : 'PE'));
      const strike = pickStrike(entry || !held ? (lock ? lock.price : s.price) : held.price, symbol, book);
      if (!lock) {
        lock = {
          dateKey: day,
          barT,
          t: s.t,
          timeIST: s.timeIST,
          type: s.type,
          side: s.side,
          price: s.price,
          qty: s.qty,
          reason: s.reason,
          premium: contractPremium(book, strike, right),
          levels: entry ? snapshotLevels(run.position) : null,
        };
        map.set(key, lock);
      } else if (lock.premium == null) {
        lock.premium = contractPremium(book, strike, right);
      }
      held = entry ? { price: lock.price, right: s.type === 'BUY CE' ? 'CE' : 'PE' } : null;
      const row = { ...s, barT, t: lock.t, timeIST: lock.timeIST, price: lock.price, reason: lock.reason };
      if (lock.premium != null) row.premium = lock.premium;
      return row;
    });
    if (run.position) {
      const entryLock = [...map.values()].find((m) => (m.type === 'BUY CE' || m.type === 'BUY PE') && m.t === run.position.entryTime);
      if (entryLock && entryLock.barT === forming.t) entryLock.levels = snapshotLevels(run.position);
    }
    this.moments[symbol.id] = [...map.values()];
  }

  liveCandleView(ltp, now, forming) {
    const start = liveBarStart(now, config.timeframeMinutes);
    if (start == null || !Number.isFinite(ltp)) return null;
    const same = forming && forming.t === start ? forming : null;
    return {
      timeIST: istTimeStr(start),
      open: same ? round2(same.open) : null,
      high: same ? round2(Math.max(same.high, ltp)) : null,
      low: same ? round2(Math.min(same.low, ltp)) : null,
      close: round2(ltp),
    };
  }

  onFeedTick(tick) {
    const symbol = SYMBOLS.find((s) => s.upstoxKey === tick.instrumentKey);
    if (symbol) {
      this.ltp[symbol.id] = tick.ltp;
      this.touchLiveCandle(symbol.id, tick.ltp);
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
    const todayKey = istDateKey(now);
    const out = {
      status: 'live',
      source: this.active ? this.active.name : null,
      feed: this.feed && this.feed.connected ? 'upstox' : null,
      updatedAt: istFullStr(now),
      symbols: {},
    };

    for (const symbol of SYMBOLS) {
      const { closed, forming, series, run } = this.evaluate(symbol, now);
      const last = series.length - 1;

      const todayCandles = closed.filter((c) => istDateKey(c.t) === todayKey);
      const prevDayCandles = closed.filter((c) => istDateKey(c.t) !== todayKey);
      const prevClose = prevDayCandles.length ? prevDayCandles[prevDayCandles.length - 1].close : null;
      const ltp = Number.isFinite(this.ltp[symbol.id])
        ? this.ltp[symbol.id]
        : forming
          ? forming.close
          : closed.length
            ? closed[closed.length - 1].close
            : null;

      const book = this.optionBooks[symbol.id];
      const struck = withStrikes(this.stampEarlyPremium(symbol, run.signals, book), series, run, symbol, book, this.optionCandles);
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
        lastCandleTimeIST: closed.length ? istTimeStr(closed[closed.length - 1].t) : null,
        liveCandle: this.liveCandleView(ltp, now, forming),
        supertrend: last >= 0 ? Math.round(run.stValue[last] * 100) / 100 : null,
        direction: last >= 0 ? run.direction[last] : null, // -1 bullish, +1 bearish
        ema13: last >= 0 && Number.isFinite(run.ema[last]) ? Math.round(run.ema[last] * 100) / 100 : null,
        support: last >= 0 && Number.isFinite(run.supAt[last]) ? run.supAt[last] : null,
        resistance: last >= 0 && Number.isFinite(run.resAt[last]) ? run.resAt[last] : null,
        position,
        signalsToday: todaySignals,
        dayPoints: Math.round(dayPoints * 100) / 100,
        prediction: openingRead([...(this.fastCandles[symbol.id] || new Map()).values()], ltp, now),
        chart: series.slice(-100).map((c, k, arr) => {
          const gi = series.length - arr.length + k;
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
      this.moments = saved.moments || {};
    } catch (_) {
      this.earlyMarks = {};
      this.moments = {};
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
      JSON.stringify({ date: day, ...paper, earlyMarks: this.earlyMarks, moments: this.moments, savedAt: new Date().toISOString() }, null, 2)
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
