# NIFTY / BANKNIFTY Live Strategy Dashboard (Node.js)

Realtime NIFTY 50 + BANKNIFTY data with your Pine v6 strategy
**"Nifty/BankNifty Multi-Index Strategy"** ported line-by-line to JavaScript:

- Supertrend **ATR 10 / multiplier 3.0** (exact band math from your script, Wilder RMA)
- **BUY CE / BUY PE** on a Supertrend flip, or at the **09:15** bar if the trend is already set
- **Dynamic exit**: close crosses **EMA 13**, or the Supertrend flips against the position
- **15:10 square-off** (fires on the first bar at/after 15:10; no fresh entries after that)
- Pivot **Support / Resistance** (15 left / 15 right) — note the levels confirm 15 bars late,
  exactly like `ta.pivothigh/low` in Pine
- Lot sizes: **NIFTY 65, BANKNIFTY 30**

**Signals only.** There is no order-placement code anywhere in this project.

Data sources (both realtime, per your setup):

| Source | What you need | Cost |
|---|---|---|
| **Upstox API** | Your daily access token (same one your Mac app uses) | Free with your Upstox account |
| **Angel One SmartAPI** | API key + client code + password + TOTP secret (or a ready JWT) | Free with an Angel One account |

`DATA_SOURCE=auto` uses Upstox first and fails over to Angel One if Upstox errors.

## Run it

```bash
npm install
cp .env.example .env   # fill in Upstox token and/or Angel One values
npm start              # open http://localhost:3000
npm run terminal       # same dashboard, drawn in this terminal (browser still works)
```

Press `q` to leave the terminal view. The page at http://localhost:3000 stays available either way.
If the dashboard is already running, `npm run terminal` attaches to it instead of starting a second copy.

## Run the whole project on an Android phone

The phone runs Node, the Upstox feed, and the dashboard. The Mac does not have to stay on.
Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store build is too old). Copy `nifty-live-strategy-phone.zip` from Downloads onto the phone, then in Termux:

```bash
termux-setup-storage
pkg update -y && pkg install -y nodejs unzip
cd ~/storage/downloads
unzip -o nifty-live-strategy-phone.zip
cd nifty-live-strategy
bash tools/run-on-phone.sh
```

Open **http://127.0.0.1:3000** in the phone's browser. Leave Termux open during market hours. The zip includes your `.env`, so send it only to your own phone.

An iPhone cannot run this server. On an iPhone, keep the Mac running and open the `Phone (same Wi-Fi)` address.

Entries/exits are booked at the **signal bar's close** on **15-minute bars**
(the same bar-close convention as the nightly paper log; TradingView strategy
fills differ — labels are not fills). Set `TIMEFRAME_MINUTES` in `.env` to change
the candle timeframe.

## Files

- `src/supertrend.js` — the Pine Supertrend block, transcribed 1:1 (incl. the `nz()` warmup behaviour)
- `src/strategy.js` — entries, EMA/flip exits, square-off, position state
- `src/indicators.js` — RMA/EMA with Pine seeding, pivots
- `src/data/upstox.js` — Upstox v3 candles (15-min supported; v2 wasn't) + v2 LTP
- `src/data/angelone.js` — SmartAPI login (TOTP built in), `getCandleData`, LTP.
  Index tokens: NIFTY `99926000`, BANKNIFTY `99926009`
- `src/engine.js` — warmup (7 days), closed-candle polling, failover, live state
- `public/index.html` — browser dashboard (price, ST line chart, S/R, position, today's signals)
- `src/terminal.js` — the same dashboard in the terminal (`npm run terminal`)
- `tools/run-on-phone.sh` — runs the whole project on an Android phone (`bash tools/run-on-phone.sh`)

## Checks

```bash
npm test                 # unit tests: indicators, TOTP vector, Supertrend, strategy day
node tools/replay.js candles.csv 25   # replay the strategy over any candle CSV
```

Verified 2026-10-15: 8/8 unit tests pass; replay over the last 10 days of real
15-minute candles produced the expected open/flip entries, EMA exits and 15:15
square-offs, and the 2026-10-13 NIFTY entry matched the paper log's 22,471.4.

## Notes

- Upstox tokens expire at midnight IST — paste the fresh token into `.env` after
  your daily login and restart. Angel One auto-login (with TOTP secret) avoids that.
- `DATA_SOURCE=fixture` + `FIXTURE_DIR` (CSV files `NIFTY.csv` / `BANKNIFTY.csv`,
  header `t,open,high,low,close,volume`, `t` = epoch ms) runs the whole stack
  offline for testing; the dashboard labels it as test data.
- Your `.env` holds your own credentials on your own machine. Never share or commit it.
