# Trading Journal — bar-replay backtester

A local-first trading journal + TradingView-style bar-replay backtester (TradeZella/Edgewonk-style).
Runs entirely on your machine — no accounts, no cloud. Available as a downloadable desktop app for
macOS, Windows, and Linux, or runnable from source. Ships with no chart data pre-loaded; works with
any instrument you have 1-minute OHLCV history for, added right from the app.

## Install

Download the latest build for your OS from the **[Releases page](https://github.com/kk95275/trading-journal/releases)**:

- **macOS** — `.dmg` (pick `arm64` for Apple Silicon, or the plain one for Intel)
- **Windows** — `.exe` installer
- **Linux** — `.AppImage` (make it executable first: `chmod +x Trading*.AppImage`) or `.deb`

### First run — unsigned app warnings

This build isn't code-signed (no Apple Developer / Windows certificate behind it), so your OS will
warn you the first time you open it. That's expected, not a sign of a problem — here's how to get past it:

- **macOS**: Gatekeeper will say the app "is damaged and can't be opened" or is from an
  "unidentified developer." Right-click (or Control-click) the app in Finder → **Open** → **Open**
  again in the confirmation dialog. If it still says "damaged," run this once in Terminal, then try
  again: `xattr -cr "/Applications/Trading Journal.app"`
- **Windows**: SmartScreen will say "Windows protected your PC." Click **More info** → **Run anyway**.
- **Linux**: no special dialog, just make sure the AppImage is executable (see above).

The app opens with **no chart data** — raw instrument files are hundreds of MB each, far too large
to ship in an installer. Add your first instrument from **Settings → Instruments** (below).

## Adding an instrument

From **Settings → Instruments**, click **+ Add instrument**:

1. Enter a **symbol** (e.g. `NZDUSD`), a **display name**, and its **contract spec** — two quick-fill
   buttons prefill sensible defaults for a metal-like instrument (XAUUSD-style) or an FX pair
   (EURUSD-style) as a starting point.
2. Choose your raw `<SYMBOL>.txt` file (native file picker in the desktop app; a file input if
   you're running from source in a browser).
3. Click **Import** — a progress readout shows rows converted as it works through the file.
4. Done. The new symbol is immediately selectable in Backtest/Trades, no restart needed.

**Raw file format** — one header line (ignored), then one comma-separated row per 1-minute bar,
sorted ascending by time:

```
<TICKER>,<DTYYYYMMDD>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>
XAUUSD,20030506,000100,341.534,341.95,341.453,341.695,9920
```

- `DTYYYYMMDD` — 8-digit date (`YYYYMMDD`)
- `TIME` — `HHMMSS`, zero-padded to 6 digits
- `OPEN`/`HIGH`/`LOW`/`CLOSE` — floats, `VOL` — integer (tick volume is fine)
- Timestamps must be **GMT, no DST**; prices should be **bid** basis to stay consistent with the
  app's spread/fill simulation

Delete an instrument's chart data any time from the same Instruments screen — this can't be undone,
but re-importing the same file restores it.

## Backtesting against funded-challenge rules

The backtester can hold you to a prop firm's evaluation rules while you replay, so a session answers
"would this have passed?" and not just "was it profitable?". Two presets ship with the app:
**IC Funded — 2-Step Professional 25K** and **FTMO — 2-Step Challenge 25K**.

### Picking a rule set

On the Backtest setup screen the **Rules** dropdown starts on `Normal backtesting — no rules`. Pick a
firm and three stage tabs appear — Step 1 / Step 2 / Funded for IC, FTMO Challenge / Verification /
FTMO Account for FTMO. Each stage has its own profit target, max drawdown and minimum trading days,
so switching tab changes what you're held to; the funded stage has no target and just runs until you
stop or breach. A summary underneath shows what you picked — target, daily loss, max drawdown, min
trading days, margin cap, commission — plus that stage's own conditions.

Where a firm's own pages disagree, the setup screen offers the choice rather than picking silently,
and defaults to the stricter reading. IC's Step 1 max drawdown is 10% on its rules page and 8% in its
Help Centre — 8% is the default, 10% is one click away. Its 5% daily loss can read as a fixed $1,250
or as 5% of day-start equity, and you can switch which applies.

### What gets enforced while you trade

A strip above the chart tracks daily loss left, max drawdown left, progress to target, equity,
trading days, margin use, risk flags, and a countdown to Friday close where the stage wants you flat
for the weekend. Each rule is applied only where that firm actually imposes it:

- **Daily loss floor**, rebased at the firm's own reset time and timezone
- **Static max drawdown** off the starting balance — it never moves up with profit
- **Margin exposure cap** (IC: 75% of equity) — an order that would exceed it is refused
- **Hedging ban** (IC) — an opposite position is refused until you close the first one
- **Weekend-flat deadline** — still holding at Friday close is a breach
- **Minimum trading days** (days you opened at least one trade, in server time) before hitting the
  target counts as a pass
- **Soft per-idea risk warning** (IC: 1.5% of equity) — warns and counts a flag, never breaches

The one thing worth understanding: **every limit is measured on equity — balance plus floating P&L —
because that's how the firms measure it.** A trade that's deep underwater can breach the account
before you ever close it. And the floors are tested against each bar's worst-case equity (longs
marked to the bar's low, shorts to its high), so a wick through a floor breaches even if the bar
closes back above it.

A breach closes your open positions at market the way the firm would, names what broke, and refuses
further orders. **Keep trading anyway** lets you carry on over the same data for practice — the run
stays marked failed.

### Saved sessions resume

Every backtest session is saved, plain ones included. The setup screen lists in-progress sessions
with a **Resume** button and finished ones in a history table. Resuming restores the bar you were on,
the balance, and for a challenge run the floors, trading-day count and profitable days.

A resumed session **starts flat** — a position open when you stopped is not carried, and the balance
you get back is the realized one. Progress is saved roughly every 1.5s, so closing the app
mid-playback can cost a couple of seconds of simulated time; trades and the breach-or-pass verdict
are written immediately.

### Check vs rules

Any saved session has a **Check vs rules** button. Pick a firm and it replays that session's closed
trades against every stage at once, reporting each as survived, breached or target-not-reached, with
peak profit, worst drawdown, trading days, and how close the worst moment came to each floor.

Two things keep that answer honest:

- It **rebuilds equity minute by minute from your 1-minute bars** instead of trusting closed P&L, and
  feeds it to the same rule tracker the live replay uses. A session that sat 6% underwater at lunch
  and closed the day green has already breached; a closed-P&L check would call it a pass.
- It **scales position sizes by challenge balance / session balance**, so a strategy tested on
  $10,000 is judged at the challenge's size with proportional risk (2.50x for a $25K preset). P&L,
  fees and risk are all linear in lots, so the scaling is exact.

A stage that can't be computed — no closed trades, no 1-minute data for the symbol, or too long a
span to walk minute by minute — says so instead of guessing.

### Where the two presets differ

Both run a 5% daily loss, a 10% then 5% profit target, and a static (non-trailing) max drawdown of
10% — except IC's Step 1, which defaults to the stricter 8% reading. The rest isn't obvious:

| | IC Funded 25K | FTMO 25K |
|---|---|---|
| Daily floor measured from | end-of-day equity | the balance at the reset, so a floating loss held over midnight doesn't drag the next day's floor down |
| Daily reset timezone | EET (UTC+2/+3) | CE(S)T (UTC+1/+2) |
| Min trading days | 3 | 4 |
| Hedging | not allowed | allowed |
| Margin cap | 75% of equity | none |
| News and weekend limits | flat before Friday close at every stage; news blackout once funded | only once funded — Challenge and Verification may hold over a weekend and trade through news |
| Commission | $4/lot round-turn | varies by instrument — set it per session |

### What isn't simulated

Only the rules that can be checked from price data are enforced. The setup panel lists the rest per
firm (**Show N rules this simulator can't check**) rather than dropping them silently:

- **Overnight swaps** — FTMO counts them in equity, and they add up when you hold for days
- **Margin requirements and broker stop-out** — the firm's margin cap is enforced, the broker's isn't
- **News blackouts** on the funded stage — the app has no economic calendar
- **Consistency clauses** — lot size, frequency and risk exposure staying comparable, and the profit
  concentration that can trigger a manual review
- **Forbidden practices** — martingale and grid averaging, copy trading, rented EAs, HFT, tick
  scalping, latency arbitrage, opposite positions across accounts
- **Account-level terms** like inactivity termination and payout eligibility

These presets are one reading of each firm's published rules, not legal or financial advice. Rules
change and the firms' own terms govern — read the current ones yourself before you rely on a number
in here.

**Adding a firm or account size** (if you're reading the source): a rule set is plain data — one
object in `RULE_SETS` in `src/lib/propRules.ts`, picked up by both the setup screen and the engine
with no new engine or UI code. The live tracker is `RuleRuntime` in the same file; the retroactive
check is `src/replay/challengeCheck.ts`.

## Running from source (for developers)

**1. Prerequisites** — Node.js 20.11+ and npm (`node -v` to check).

**2. Clone and install:**

```bash
git clone https://github.com/kk95275/trading-journal.git
cd trading-journal
npm install
```

**3. Run it:**

```bash
npm run dev            # browser, http://localhost:5173
npm run electron:dev   # same app in an Electron window, for testing desktop-specific behavior
```

Chart data still isn't bundled — use **Settings → Instruments** in the running app exactly as
above, or the equivalent CLI, which reads raw `.txt` files from a sibling `instruments-data/` folder
(one level up from this repo) and is handy for scripting/bulk conversion:

```bash
npm run convert-data            # converts XAUUSD, EURUSD, GBPUSD — whichever files exist there
npm run convert-data NZDUSD     # or convert one symbol by name
```

**4. Build your own installer** (optional): `npm run electron:build` produces an unsigned installer
for your current OS/arch under `release/`. The `.github/workflows/release.yml` workflow does the
same for all three OSes and publishes them to GitHub Releases automatically — push a `v*.*.*` tag
(e.g. `v1.0.0`) or trigger it manually from the Actions tab.

## Pages

- **Backtest** — pick a start date within your converted data's range (GMT), replay 1m/5m/15m/1h/4h/1d candles,
  trade on the chart (draggable SL/TP), tick setup confirmations, write notes. Closed trades are
  auto-saved to the journal with a chart screenshot. Sessions are saved and resumable, and can be
  run under a funded-challenge rule set (above).
  Hotkeys: `space` play/pause · `→` step one bar · `↑`/`↓` speed.
- **Dashboard** — equity curve, win rate, profit factor, expectancy, R totals, drawdown, streaks,
  P&L by day-of-week / hour / setup.
- **Trades** — filterable trade log, per-trade detail (screenshot, confirmations, notes, mistake
  tags), manual entry, CSV import.
- **Calendar** — TradeZella-style monthly P&L grid with weekly totals.
- **Journal** — daily notes with a mood/discipline rating.
- **Playbook** — define setups + confirmation checklists (used by the Backtest order ticket),
  see which setups have edge and what mistakes cost you.
- **Strategies** — write algorithmic strategies in Python and backtest them over your 1m data.
  Multi-timeframe OHLC, a bundled indicator library, equity curve + hour/day-of-week breakdowns,
  and an optional AI review of when the strategy actually has edge.
  **→ See [STRATEGY-GUIDE.md](STRATEGY-GUIDE.md) for the full API and worked examples.**
- **AI Chat** — bring-your-own-key chat (OpenAI / Anthropic / Gemini / OpenRouter / Ollama) that can
  read your trade history for context. Keys are encrypted with your OS keychain.
- **Settings** — accounts, instruments (add/delete chart data), custom indicators, AI models,
  session defaults, JSON backup/restore.

## Data & simulation notes

See `DATA-NOTES.txt` for a full data-quality audit of the original XAUUSD/EURUSD/GBPUSD source
files this project was built against (bar density by year, gap/holiday analysis) — useful context
if you're sourcing your own data and want to sanity-check it against a known-good baseline.

Simulation details: buys fill at bid + spread (configurable per session); if SL and TP are both
touched within the same 1-min bar, SL wins (conservative). Commission is charged per lot,
round-turn. Fills are checked on every 1-minute bar regardless of the viewing timeframe.

## Backups

The working database is the browser's IndexedDB, but every change is auto-mirrored (debounced
~2.5s) to a `journal.json` file plus a daily copy (last 14 kept), and restored from there
automatically if that storage is ever empty (cleared data, or a fresh install). Where that file
lives depends on how you're running the app:

- **Downloaded app**: your OS's standard per-app data folder — e.g. on macOS,
  `~/Library/Application Support/trading-journal/data-journal/`; the Windows/Linux equivalents are
  `%APPDATA%\trading-journal\data-journal\` and `~/.config/trading-journal/data-journal/`.
- **Running from source**: `trading-journal/data-journal/journal.json`, right in the repo folder.

**Settings → Export backup** additionally produces a portable one-file JSON any time (e.g. to move
to another computer), independent of where the automatic folder sync lives.
