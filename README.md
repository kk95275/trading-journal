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
  auto-saved to the journal with a chart screenshot.
  Hotkeys: `space` play/pause · `→` step one bar · `↑`/`↓` speed.
- **Dashboard** — equity curve, win rate, profit factor, expectancy, R totals, drawdown, streaks,
  P&L by day-of-week / hour / setup.
- **Trades** — filterable trade log, per-trade detail (screenshot, confirmations, notes, mistake
  tags), manual entry, CSV import.
- **Calendar** — TradeZella-style monthly P&L grid with weekly totals.
- **Journal** — daily notes with a mood/discipline rating.
- **Playbook** — define setups + confirmation checklists (used by the Backtest order ticket),
  see which setups have edge and what mistakes cost you.
- **Settings** — accounts, instruments (add/delete chart data), session defaults, JSON backup/restore.

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
