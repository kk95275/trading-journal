# Trading Journal — XAUUSD backtester & journal

A local-first trading journal + TradingView-style bar-replay backtester (TradeZella/Edgewonk-style),
running entirely on this machine. No accounts, no cloud — all trade data lives in your browser's
IndexedDB, chart data in `public/data/`.

## Run it

```bash
cd trading-journal
npm install
npm run dev
```

Open http://localhost:5173

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
- **Settings** — accounts, session defaults, JSON backup/restore.

## Data

See `DATA-NOTES.txt`. Source files: `../instruments-data/<SYMBOL>.txt` — a sibling folder next to
this project (1-min OHLCV, GMT no DST, **bid** prices). Converted once into binary chunks via:

```bash
npm run convert-data   # only needed again if a source txt changes; default: XAUUSD EURUSD GBPUSD
```

Simulation details: buys fill at bid + spread (configurable per session); if SL and TP are both
touched within the same 1-min bar, SL wins (conservative). Commission is charged per lot,
round-turn. Fills are checked on every 1-minute bar regardless of the viewing timeframe.

## Adding your own instrument

The app ships with XAUUSD/EURUSD/GBPUSD, but it isn't limited to them — any instrument with
1-minute OHLCV history can be added. Raw instrument data is *not* stored in this repo (it's
hundreds of MB per symbol); instead it lives in a sibling `instruments-data/` folder that you
provide yourself:

```
trading/                    (any parent folder)
├── trading-journal/        (this repo)
└── instruments-data/       (your raw data — not part of this repo, not committed)
    ├── XAUUSD.txt
    └── NZDUSD.txt           <- your new instrument
```

**1. Format your raw file.** `scripts/convert-data.mjs` expects a comma-separated `<SYMBOL>.txt`
file: one header line (starts with `<`, ignored), then one row per 1-minute bar sorted ascending
by time:

```
<TICKER>,<DTYYYYMMDD>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>
XAUUSD,20030506,000100,341.534,341.95,341.453,341.695,9920
```

- `DTYYYYMMDD` — 8-digit date (`YYYYMMDD`)
- `TIME` — `HHMMSS`, zero-padded to 6 digits
- `OPEN`/`HIGH`/`LOW`/`CLOSE` — floats
- `VOL` — integer (tick volume is fine)
- Timestamps must be **GMT, no DST**; prices should be **bid** basis to stay consistent with the
  app's spread/fill simulation
- Name the file `<SYMBOL>.txt` in uppercase (e.g. `NZDUSD.txt`) and drop it directly in
  `instruments-data/`

**2. Convert it:**

```bash
npm run convert-data NZDUSD
```

This reads `../instruments-data/NZDUSD.txt` and writes `public/data/NZDUSD/manifest.json` plus
chunked `.bin` files — the format the app actually reads from at runtime. Re-run this any time the
source `.txt` changes.

**3. Register its contract spec.** Edit `src/lib/symbols.ts` and add an entry to `SYMBOLS` so the
app computes P&L and formats prices correctly:

```ts
NZDUSD: { symbol: 'NZDUSD', name: 'NZ Dollar / USD', contractSize: 100000, decimals: 5, inputStep: 0.0001, defaultSpread: 0.00015 },
```

- `contractSize` — units per lot (P&L = price move × `contractSize` × lots); e.g. 100,000 for a
  standard FX lot, 100 for XAUUSD (1 lot = 100oz)
- `decimals` — price display precision
- `inputStep` — step size for SL/TP number inputs
- `defaultSpread` — default bid/ask spread applied to fills

This step isn't strictly required — unregistered symbols fall back to generic defaults via
`specFor()` — but P&L math and price formatting will be wrong for anything that isn't FX-like.

**4. Run it.** `npm run dev`, then pick the new symbol from the app's symbol selector.

## Backups

The working database is the browser's IndexedDB, but every change is auto-mirrored (debounced
~2.5s) to `data-journal/journal.json` plus a daily copy (last 14 kept), via dev-server endpoints
in `vite.config.ts` (`/api/journal`). On startup, if the browser DB is empty, the app restores
from that file — so cleared browser data or switching browsers is recoverable. **Settings →
Export backup** additionally produces a portable one-file JSON (e.g. for another machine).
