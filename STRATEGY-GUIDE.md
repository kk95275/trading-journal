# Writing & Backtesting Strategies

A complete reference for the **Strategies** page. You write Python, the app runs it
bar-by-bar over your imported 1-minute data, and gives you stats, an equity curve,
hour/day breakdowns, and an optional AI review.

No Python install needed — Python runs in the app via Pyodide (CPython compiled to
WebAssembly). The first Run downloads ~10 MB of runtime; after that it boots in a
second or two.

---

## Contents

1. [Quick start](#quick-start)
2. [The contract](#the-contract)
3. [Market data (OHLC)](#market-data-ohlc)
4. [Multi-timeframe](#multi-timeframe)
5. [Indicators — the bundled `ta` library](#indicators--the-bundled-ta-library)
6. [Orders & positions](#orders--positions)
7. [How fills actually work](#how-fills-actually-work)
8. [Keeping state between bars](#keeping-state-between-bars)
9. [Sessions & time filtering](#sessions--time-filtering)
10. [Logging & debugging](#logging--debugging)
11. [Splitting across multiple files](#splitting-across-multiple-files)
12. [Full worked example](#full-worked-example)
13. [Reading the results](#reading-the-results)
14. [Performance](#performance)
15. [Common mistakes](#common-mistakes)
16. [API cheat sheet](#api-cheat-sheet)

---

## Quick start

**Strategies → + New strategy**, paste this, **Save**, **▶ Run backtest**:

```python
def on_bar(ctx):
    fast = ema(ctx.closes, 20)
    slow = ema(ctx.closes, 50)

    if cross_up(fast, slow) and ctx.is_flat:
        entry = ctx.ask
        ctx.buy(0.1, entry * 0.998, entry * 1.004)

    elif cross_down(fast, slow) and ctx.has_position:
        ctx.exit()
```

That's a complete strategy. `ema` and `cross_up` come bundled — no imports needed.

Before running, set the header fields: **symbol**, **spread**, **commission per lot**,
**starting balance**, and optionally a **From/To** date range. Leave the dates blank to
use everything you've imported.

---

## The contract

Your file must define exactly one function:

```python
def on_bar(ctx):
    ...
```

It is called **once per 1-minute bar**, in order, from the start of your date range to
the end. `ctx` is your window into the market and your order book.

You never loop over bars yourself — the runner does that. Your job is to answer
"given everything up to right now, what should I do?"

Anything at module level (imports, constants, state dicts) runs **once** before the
first bar.

---

## Market data (OHLC)

### Current bar

```python
ctx.open     # this bar's open
ctx.high     # this bar's high
ctx.low      # this bar's low
ctx.close    # this bar's close
ctx.volume   # this bar's volume
ctx.now      # bar timestamp, epoch seconds UTC
```

### History arrays

```python
ctx.opens     ctx.highs     ctx.lows     ctx.closes     ctx.volumes
```

Each behaves like a Python list ending at the current bar:

```python
ctx.closes[-1]      # current close (same as ctx.close)
ctx.closes[-2]      # previous bar's close
ctx.closes[-50]     # 50 bars ago
len(ctx.closes)     # how many bars so far
```

### Getting a window

Two equivalent ways to grab the last N values:

```python
last20 = ctx.recent_closes(20)      # returns a plain list
last20 = list(ctx.closes)[-20:]     # slicing also works
```

`recent_*(n)` exists for every field: `recent_opens`, `recent_highs`, `recent_lows`,
`recent_closes`, `recent_volumes`, `recent_bars`.

### Full bars

```python
ctx.bars[-1]            # {'time':…, 'open':…, 'high':…, 'low':…, 'close':…, 'volume':…}
ctx.bars[-1]["high"]
ctx.recent_bars(20)     # last 20 as a list of dicts
```

### No look-ahead, guaranteed

Every array is **capped at the current bar**. `ctx.closes[-1]` is always "now", and
there is no way to index into the future — the data simply isn't exposed. You cannot
accidentally peek ahead.

---

## Multi-timeframe

`ctx.tf(...)` gives you the same OHLC surface aggregated to any higher timeframe,
built on the fly from the underlying 1-minute bars.

```python
m5  = ctx.tf('5m')
m15 = ctx.tf('15m')
h1  = ctx.tf('1h')
h4  = ctx.tf('4h')
d1  = ctx.tf('1d')
```

Accepts `'1m' '5m' '15m' '30m' '1h' '4h' '1d' '1w'`, or raw seconds: `ctx.tf(900)`.

Each view has **everything `ctx` has** for market data:

```python
h1.open  h1.high  h1.low  h1.close  h1.volume  h1.time
h1.opens h1.highs h1.lows h1.closes h1.volumes h1.bars
h1.recent_closes(50)
len(h1.bars)
```

### The one rule that matters: `[-1]` is still forming

The last element of every higher-timeframe array is the **current, incomplete** bar.
At 09:17 on a 1-hour view, `h1.closes[-1]` is the close-so-far of the 09:00 candle,
which will keep changing until 10:00.

```python
h1.closes[-1]    # the 09:00 candle, still forming — changes every minute
h1.closes[-2]    # the 08:00 candle, CLOSED and final
```

**For signals based on completed candles, use `[-2]`.** For "where is price right
now relative to a higher-timeframe level", `[-1]` is what you want.

```python
# Trend filter off the last CLOSED 4h candle — stable, won't flip mid-candle
trend_up = h4.closes[-2] > ema(h4.closes, 50)[-2]

# But compare live price to it
if trend_up and ctx.close > h4.lows[-1]:
    ...
```

### Cost

Aggregation is incremental and cached — `ctx.tf('1h')` returns the same object every
call, and only timeframes you actually touch get built. Calling it at the top of
`on_bar` is fine.

### Example

```python
def on_bar(ctx):
    h4 = ctx.tf('4h')
    h1 = ctx.tf('1h')
    m5 = ctx.tf('5m')

    # Need history on the slowest timeframe first
    if len(h4.bars) < 52 or len(m5.bars) < 22:
        return

    # Bias from closed higher-TF candles
    bias_up = h4.closes[-2] > ema(h4.closes, 50)[-2] and h1.closes[-2] > ema(h1.closes, 20)[-2]

    # Timing from the fast timeframe
    e21 = ema(m5.closes, 21)
    if bias_up and ctx.is_flat and m5.low <= e21[-1] <= m5.close:
        entry = ctx.ask
        ctx.buy(0.1, entry * 0.997, entry * 1.006)
```

---

## Indicators — the bundled `ta` library

Available in every strategy **with no import line**. Also reachable as `ta.sma(...)`
if you prefer the namespace.

### Moving averages & stats

| Function | Returns |
|---|---|
| `sma(values, length)` | Simple moving average |
| `ema(values, length)` | Exponential MA, seeded with SMA |
| `rma(values, length)` | Wilder's smoothing (used by RSI/ATR) |
| `wma(values, length)` | Linearly-weighted MA |
| `stdev(values, length)` | Rolling standard deviation |
| `highest(values, length)` | Rolling max |
| `lowest(values, length)` | Rolling min |
| `change(values, length=1)` | Differences |

### Classic indicators

| Function | Returns |
|---|---|
| `rsi(values, length=14)` | 0–100 |
| `macd(values, fast=12, slow=26, signal=9)` | tuple `(line, signal, histogram)` |
| `bbands(values, length=20, mult=2.0)` | tuple `(upper, basis, lower)` |
| `atr(bars, length=14)` | Average True Range — **takes bars, not closes** |
| `vwap(bars)` | Daily-anchored VWAP — **takes bars** |
| `roc(values, length)` | Rate of change, percent |
| `momentum(values, length)` | `values[i] - values[i-length]` |

### Helpers

| Function | Returns |
|---|---|
| `cross_up(a, b)` | `True` on the bar where series `a` crossed above `b` |
| `cross_down(a, b)` | `True` on the bar where `a` crossed below `b` |
| `is_finite(x)` | `True` if `x` is a real number (not NaN/inf) |

### Warmup returns NaN

Every function returns a list **the same length as its input**, with `nan` in
positions where there isn't enough history. So `result[-1]` is always the current
bar's value — but it may be `nan` early in the run.

**Always guard before comparing:**

```python
r = rsi(ctx.closes, 14)
if not is_finite(r[-1]):
    return          # not enough bars yet
if r[-1] < 30:
    ...
```

Multi-value functions unpack naturally:

```python
line, signal, hist = macd(ctx.closes)
upper, basis, lower = bbands(ctx.closes, 20, 2.0)
```

---

## Orders & positions

**One position at a time.** `buy()` / `sell()` return `False` and do nothing if you
already have one.

```python
ctx.buy(lots, sl, tp)      # long — fills at ask
ctx.sell(lots, sl, tp)     # short — fills at bid
ctx.exit()                 # flatten at market
ctx.close_position()       # alias for exit()
```

`sl` and `tp` are **prices, not distances**, and both are optional:

```python
ctx.buy(0.1)                                  # no stop, no target
ctx.buy(0.1, entry - 0.0020, entry + 0.0040)  # positional
ctx.buy(0.1, sl=entry - 0.0020, tp=entry + 0.0040)   # keyword — also fine
```

Modify a live position:

```python
ctx.set_sl(new_price)
ctx.set_tp(new_price)
```

### Checking whether you're in a trade

Three equivalent ways — use whichever reads best:

```python
if ctx.is_flat:             # clearest
if not ctx.has_position:
if ctx.position is None:
```

### The position dict

```python
p = ctx.position
if p is not None:
    p["direction"]    # 'long' or 'short'
    p["entry"]        # fill price
    p["lots"]
    p["sl"]           # price, or None
    p["tp"]           # price, or None
    p["entry_time"]   # epoch seconds
```

### Trailing stop example

```python
def on_bar(ctx):
    p = ctx.position
    if p is not None and p["direction"] == "long":
        a = atr(ctx.bars, 14)
        if is_finite(a[-1]):
            trail = ctx.close - 2 * a[-1]
            if p["sl"] is None or trail > p["sl"]:
                ctx.set_sl(trail)     # only ever ratchet up
```

---

## How fills actually work

Understanding this is the difference between a backtest you can trust and one you
can't.

**Prices are bid.** Your data is the bid series.

- **Buy** fills at `ask` = `bid + spread`
- **Sell** (short) fills at `bid`
- **Long exit** fills at `bid`
- **Short exit** fills at `ask`

So the spread is paid on entry for longs and on exit for shorts — you're charged it
exactly once per round trip, same as live.

**Stops and targets are checked every 1-minute bar**, regardless of what timeframe
your logic uses. A strategy that only reasons about 4h candles still gets its stop
checked 240 times per candle.

**If both SL and TP are touched inside the same 1-minute bar, the stop wins.** This
is deliberately pessimistic — within one bar there's no way to know which came first,
so the sim assumes the bad one.

**Commission is round-turn per lot**, charged once when the trade closes.

**Any position still open at the end of the data is closed at market**, so the equity
curve and final balance are always consistent.

**P&L uses the symbol's contract spec** (contract size, and a quote→USD conversion for
pairs like GBPJPY where the quote currency isn't USD). Check
**Settings → Instruments** if the numbers look off by a constant factor.

---

## Keeping state between bars

Module-level variables persist across bars **within one run**, and reset at the start
of every run.

Use a mutable container (dict or list) so you can write to it from inside `on_bar`
without needing `global`:

```python
state = {"day": None, "trades_today": 0}

def on_bar(ctx):
    state["trades_today"] += 1      # works — mutating, not rebinding
```

A plain `counter = 0` then `counter += 1` inside the function will fail with
`UnboundLocalError` — Python treats it as a local. Either use a dict/list, or declare
`global counter`.

---

## Sessions & time filtering

`ctx.now` is epoch seconds UTC. Convert with the standard library:

```python
from datetime import datetime, timezone

def on_bar(ctx):
    dt = datetime.fromtimestamp(ctx.now, tz=timezone.utc)
    hour    = dt.hour           # 0–23 UTC
    minute  = dt.minute
    weekday = dt.weekday()      # 0 = Monday, 4 = Friday
    day_key = dt.strftime("%Y-%m-%d")
```

Common session windows (UTC):

| Session | Hours |
|---|---|
| Sydney / early Asia | 22:00 – 00:00 |
| Tokyo | 00:00 – 07:00 |
| London | 07:00 – 15:00 |
| London/NY overlap | 13:00 – 16:00 |
| New York | 13:00 – 21:00 |

A reusable pattern — trade only in-session, force flat outside:

```python
SESSIONS = [(7, 11), (13, 16)]     # UTC hour ranges
FLAT_BEFORE_END_MIN = 30           # stop holding this long before session end

def minutes_left(hour, minute):
    for start, end in SESSIONS:
        if start <= hour < end:
            return (end - hour) * 60 - minute
    return -1                       # outside every session

def on_bar(ctx):
    dt = datetime.fromtimestamp(ctx.now, tz=timezone.utc)
    left = minutes_left(dt.hour, dt.minute)

    if left <= FLAT_BEFORE_END_MIN:
        if ctx.has_position:
            ctx.exit()
        return

    # ... in-session logic here
```

> **Note on gaps.** FX data is not a continuous minute stream. Weekends are missing
> entirely, and quiet minutes are often absent or padded with the previous close.
> Never assume bar N+1 is exactly one minute after bar N — always derive time from
> `ctx.now`.

---

## Logging & debugging

```python
ctx.log("anything you want")
```

Output appears under **Logs** at the bottom of the results, timestamped with the bar
time. Capped at 500 lines, so log selectively.

The runner always appends a final summary line so you can confirm the run did what
you think:

```
[runner] done — 93,215 bars simulated, 18 trade(s) recorded, final balance 10214.50
```

### When a strategy does nothing

Log the branch conditions and count how often each one blocks:

```python
diag = {"n": 0, "sig": 0, "flat": 0}

def on_bar(ctx):
    diag["n"] += 1
    fast, slow = ema(ctx.closes, 20), ema(ctx.closes, 50)

    signal = cross_up(fast, slow)
    if signal:
        diag["sig"] += 1
    if ctx.is_flat:
        diag["flat"] += 1

    if signal and ctx.is_flat:
        ctx.buy(0.1)

    if diag["n"] % 20000 == 0:
        ctx.log("bars=" + str(diag["n"]) + " signals=" + str(diag["sig"]) + " flat=" + str(diag["flat"]))
```

If `signals=0`, your condition is wrong. If `signals` is healthy but no trades, look
at what else is in the `if`.

### When a strategy errors

Errors show as a red banner at the top of the results with the failing bar and the
Python message. The run keeps going and reports partial results, aborting only if
essentially every bar fails.

To catch and inspect errors yourself without stopping the run:

```python
errs = [0]

def on_bar(ctx):
    try:
        my_logic(ctx)
    except Exception as e:
        if errs[0] < 5:
            errs[0] += 1
            ctx.log("ERROR: " + repr(e))
```

---

## Splitting across multiple files

The tab bar above the editor holds multiple `.py` files.

- **+** adds a file
- **double-click** a tab to rename it
- **★** marks the entry point — the file that must define `on_bar`
- **☆** on another tab promotes it to entry point
- **×** deletes (the ★ file can't be deleted)

Files sit in the same directory at runtime, so plain imports work:

```python
# indicators.py
def donchian(highs, lows, length):
    return highest(highs, length), lowest(lows, length)
```

```python
# main.py  (★)
import indicators

def on_bar(ctx):
    if len(ctx.bars) < 21:
        return
    upper, lower = indicators.donchian(ctx.highs, ctx.lows, 20)
    ...
```

File names must be a valid Python identifier plus `.py` — letters, digits,
underscores, starting with a letter.

> Bundled `ta` functions are injected into the entry file's globals. In a library
> file, `import ta` explicitly and call `ta.sma(...)`.

---

## Full worked example

**Asian Range Breakout — London session.** The Asian session builds a range; London
opens and breaks it. One trade per day, stop at the far side of the range, target at
1.5× the range width, flat by 15:00 UTC.

```python
from datetime import datetime, timezone

ASIAN_START, ASIAN_END, LONDON_END = 22, 7, 15    # UTC hours
LOTS, TP_R = 0.1, 1.5
MIN_RANGE_PIPS, MAX_RANGE_PIPS = 8, 45            # skip dead & blown-out days
PIP = 0.0001                                       # EURUSD

state = {"hi": None, "lo": None, "was_asian": False,
         "day": None, "traded": False, "checked": False}

def on_bar(ctx):
    dt = datetime.fromtimestamp(ctx.now, tz=timezone.utc)
    hour, minute = dt.hour, dt.minute
    today = dt.strftime("%Y-%m-%d")

    in_asian  = (hour >= ASIAN_START or hour < ASIAN_END)
    in_london = (ASIAN_END <= hour < LONDON_END)

    # Entering a fresh Asian window → clear the range
    if in_asian and not state["was_asian"]:
        state["hi"] = None
        state["lo"] = None
    state["was_asian"] = in_asian

    # Entering a fresh London day → clear per-day flags
    if in_london and state["day"] != today:
        state["day"] = today
        state["traded"] = False
        state["checked"] = False

    # Outside London: build the range, or make sure we're flat
    if not in_london:
        if in_asian:
            h, l = state["hi"], state["lo"]
            state["hi"] = ctx.high if h is None else max(h, ctx.high)
            state["lo"] = ctx.low  if l is None else min(l, ctx.low)
        elif ctx.has_position:
            ctx.exit()
        return

    # London window — one trade per day, needs a completed range
    if state["hi"] is None or state["traded"] or ctx.has_position:
        return

    rng  = state["hi"] - state["lo"]
    pips = rng / PIP

    # Range-quality filter, evaluated once per day
    if not state["checked"]:
        state["checked"] = True
        if pips < MIN_RANGE_PIPS or pips > MAX_RANGE_PIPS:
            state["traded"] = True
            ctx.log(today + " SKIP range " + str(round(pips, 1)) + " pips")
            return
        ctx.log(today + " range " + str(round(pips, 1)) + " pips")

    # First close outside the range triggers
    if ctx.close > state["hi"]:
        entry = ctx.ask
        ctx.buy(LOTS, state["lo"], entry + TP_R * rng)
        state["traded"] = True
        ctx.log(today + " LONG @ " + str(entry))

    elif ctx.close < state["lo"]:
        entry = ctx.bid
        ctx.sell(LOTS, state["hi"], entry - TP_R * rng)
        state["traded"] = True
        ctx.log(today + " SHORT @ " + str(entry))
```

Worth noticing in this example:

- **Edge-triggered resets.** `was_asian` detects the *transition* into the Asian
  window rather than checking for an exact timestamp, so a missing 22:00 bar doesn't
  break the reset.
- **`traded` doubles as a skip flag.** Setting it when the range filter rejects a day
  cleanly prevents any trade that day.
- **Risk is defined by structure**, not a fixed number — the stop is the other side
  of the range, so wide days risk more and get a proportionally bigger target.

---

## Reading the results

**Stat cards** — net P&L, win rate, profit factor, expectancy, average R, max
drawdown, trade count, best/worst, streaks, average duration, final balance, runtime.

**Equity curve** — balance over time. Downsampled for display on long runs; the stats
above use every point.

**By hour (UTC)** and **By day of week** — P&L per bucket, green/red, faded where
there were no trades. Best and worst hour are called out under the chart. This is
usually the most actionable panel: if 80% of your profit comes from two hours, that's
a filter worth adding.

**Trades table** — most recent 500, with entry/exit time, direction, prices, P&L, R,
and exit reason (`sl`, `tp`, `manual`, `other`).

**AI analysis** — press **Analyze** to send the stats, hourly/DOW breakdowns, and
your strategy code to your configured AI provider. It reports where the edge
concentrates by time of day and suggests specific changes. Configure a provider first
in **Settings → AI models**.

### Sanity checks before trusting a result

- **Trade count.** Under ~30 trades, the stats are noise. Widen the date range.
- **Exit reasons.** All `other` means your stops and targets never triggered — check
  they're on the right side of price.
- **Max drawdown vs net P&L.** A curve that makes $500 with a $2,000 drawdown isn't
  a strategy you can trade.
- **The hour chart.** If P&L comes from a session you didn't intend to trade, your
  time filter has a bug.

---

## Performance

Every bar crosses the JavaScript↔Python boundary several times, so runs are measured
in minutes, not seconds. A 90k-bar multi-timeframe run can take 10–25 minutes.

**Work on a short window.** Iterate on 2–4 weeks, then run the full range once you're
happy with the logic. This is by far the biggest time saver.

**Recompute less.** Indicator helpers rebuild the whole series each call. If you call
`ema(ctx.closes, 200)` three times in one bar, that's three full passes:

```python
# Slower
if ema(ctx.closes, 200)[-1] > ctx.close and ema(ctx.closes, 200)[-2] < ctx.close:

# Faster
e200 = ema(ctx.closes, 200)
if e200[-1] > ctx.close and e200[-2] < ctx.close:
```

**Return early.** Put your cheapest rejection first — time-of-day checks and
`ctx.has_position` before any indicator math.

```python
def on_bar(ctx):
    if ctx.has_position:        # cheap
        return
    if not in_session(ctx):     # cheap
        return
    h4 = ctx.tf('4h')           # only now do the expensive work
```

**Stop is available.** The **■ Stop** button aborts a run and shows partial results.

---

## Common mistakes

**Forgetting the NaN guard.** Indicators return `nan` during warmup. Comparing
against `nan` is always `False`, so your strategy silently never fires.

```python
r = rsi(ctx.closes, 14)
if is_finite(r[-1]) and r[-1] < 30:     # correct
```

**Using `[-1]` on a higher timeframe for a signal.** That candle is still forming and
changes every minute. Use `[-2]` for anything that should be based on a closed candle.

**Not checking for enough history.** `ema(closes, 200)` on 50 bars returns all `nan`.

```python
if len(ctx.bars) < 200:
    return
```

**Expecting `sl`/`tp` to be distances.** They're absolute prices.

```python
ctx.buy(0.1, 0.0020, 0.0040)              # wrong — stop at price 0.0020
ctx.buy(0.1, entry - 0.0020, entry + 0.0040)   # right
```

**Rebinding a module-level variable inside `on_bar`.** Use a dict or list.

**Assuming consecutive bars are consecutive minutes.** Weekends and quiet minutes are
missing. Derive time from `ctx.now`.

**Trying to pyramid.** One position at a time; a second `buy()` returns `False`. To
scale, exit and re-enter with a different size.

**Reading too much into a handful of trades.** Check the trade count before the P&L.

---

## API cheat sheet

```python
# ── Time ──────────────────────────────────────────────
ctx.now                  # epoch seconds, UTC

# ── Current bar ───────────────────────────────────────
ctx.open  ctx.high  ctx.low  ctx.close  ctx.volume
ctx.bid                  # = close
ctx.ask                  # = close + spread
ctx.price                # = bid
ctx.spread

# ── History (ends at current bar, no look-ahead) ──────
ctx.opens  ctx.highs  ctx.lows  ctx.closes  ctx.volumes
ctx.bars                 # list of dicts
ctx.recent_opens(n)  ctx.recent_highs(n)  ctx.recent_lows(n)
ctx.recent_closes(n) ctx.recent_volumes(n) ctx.recent_bars(n)

# ── Higher timeframes ─────────────────────────────────
ctx.tf('5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | seconds)
#   → same OHLC surface; [-1] is forming, [-2] is last closed

# ── Account & position ────────────────────────────────
ctx.balance
ctx.is_flat              # bool
ctx.has_position         # bool
ctx.position             # dict or None
#   keys: direction, entry, lots, sl, tp, entry_time

# ── Orders ────────────────────────────────────────────
ctx.buy(lots, sl=None, tp=None)      # fills at ask
ctx.sell(lots, sl=None, tp=None)     # fills at bid
ctx.exit()                           # flatten at market
ctx.set_sl(price)   ctx.set_tp(price)

# ── Output ────────────────────────────────────────────
ctx.log(text)

# ── Indicators (no import needed) ─────────────────────
sma(values, length)          ema(values, length)
rma(values, length)          wma(values, length)
stdev(values, length)        change(values, length=1)
highest(values, length)      lowest(values, length)
rsi(values, length=14)       roc(values, length)
momentum(values, length)
macd(values, 12, 26, 9)      # → (line, signal, hist)
bbands(values, 20, 2.0)      # → (upper, basis, lower)
atr(bars, length=14)         # takes BARS
vwap(bars)                   # takes BARS
cross_up(a, b)   cross_down(a, b)   is_finite(x)
```

---

## Editor reference

| Feature | How |
|---|---|
| Save | **Save** button or `Ctrl/⌘+S` |
| Find | `Ctrl/⌘+F` |
| Fullscreen editor | **⛶ Expand** — `Esc` to restore |
| Format current file | **Format** |
| Auto-format on save | **Auto-fix on save** checkbox |
| Load a template | Buttons next to "Load into main.py" |
| Live errors | Red squiggles + the **Problems** strip below the editor |

Live syntax checking runs 400ms after you stop typing, using Python's own compiler —
so the errors are real CPython messages at the exact line and column.
