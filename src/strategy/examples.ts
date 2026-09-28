// Starter Python strategies. Each one is a complete, runnable file: users
// can click "Load example" and hit Run immediately. The contract is
// documented at the top of src/strategy/runner.ts.

export interface StrategyExample {
  name: string
  code: string
  description: string
}

export const STRATEGY_EXAMPLES: StrategyExample[] = [
  {
    name: 'SMA crossover',
    description: 'Long when fast SMA crosses above slow SMA, close on the opposite cross.',
    code: `# SMA crossover — the "hello world" of algo trading.
# Longs only, one position at a time. Fixed 0.1 lots. No SL/TP.

FAST = 20
SLOW = 50

def sma(bars, length):
    if len(bars) < length:
        return None
    total = 0.0
    for b in bars[-length:]:
        total += b["close"]
    return total / length

def on_bar(ctx):
    fast = sma(ctx.bars, FAST)
    slow = sma(ctx.bars, SLOW)
    if fast is None or slow is None:
        return

    # Need two consecutive values to detect a cross.
    prev_fast = sma(ctx.bars[:-1], FAST) if len(ctx.bars) > FAST else None
    prev_slow = sma(ctx.bars[:-1], SLOW) if len(ctx.bars) > SLOW else None
    if prev_fast is None or prev_slow is None:
        return

    crossed_up = prev_fast <= prev_slow and fast > slow
    crossed_dn = prev_fast >= prev_slow and fast < slow

    if crossed_up and ctx.position is None:
        ctx.buy(0.1)
    elif crossed_dn and ctx.position is not None:
        ctx.close()
`,
  },
  {
    name: 'RSI mean reversion',
    description: 'Buy oversold RSI < 30, sell overbought > 70. Simple mean reversion.',
    code: `# RSI(14) mean reversion.
# Long when RSI dips below 30; exit when it climbs above 55.

LENGTH = 14
OVERSOLD = 30
EXIT_LEVEL = 55

def rsi(bars, length):
    if len(bars) < length + 1:
        return None
    gains = 0.0
    losses = 0.0
    for i in range(-length, 0):
        diff = bars[i]["close"] - bars[i - 1]["close"]
        if diff > 0: gains += diff
        else: losses -= diff
    if losses == 0:
        return 100.0
    rs = (gains / length) / (losses / length)
    return 100 - (100 / (1 + rs))

def on_bar(ctx):
    v = rsi(ctx.bars, LENGTH)
    if v is None:
        return
    if ctx.position is None and v < OVERSOLD:
        # 1% risk stop at 0.5% below entry (rough example — tune to your instrument).
        entry = ctx.ask
        ctx.buy(0.1, sl=entry * 0.995, tp=entry * 1.015)
    elif ctx.position is not None and v > EXIT_LEVEL:
        ctx.close()
`,
  },
  {
    name: 'Bollinger breakout',
    description: 'Long a close above the upper band, short a close below the lower band.',
    code: `# Bollinger breakout — trades continuation, not reversion.
# 20-period basis, 2 sigma. Uses a fixed R:R of 2 with SL at the basis.

LENGTH = 20
MULT = 2.0

def basis_and_sd(bars, length):
    if len(bars) < length:
        return None, None
    window = bars[-length:]
    m = sum(b["close"] for b in window) / length
    v = sum((b["close"] - m) ** 2 for b in window) / length
    return m, v ** 0.5

def on_bar(ctx):
    m, sd = basis_and_sd(ctx.bars, LENGTH)
    if m is None:
        return
    upper = m + MULT * sd
    lower = m - MULT * sd
    c = ctx.bars[-1]["close"]

    if ctx.position is None:
        if c > upper:
            entry = ctx.ask
            dist = entry - m
            ctx.buy(0.1, sl=m, tp=entry + 2 * dist)
        elif c < lower:
            entry = ctx.bid
            dist = m - entry
            ctx.sell(0.1, sl=m, tp=entry - 2 * dist)
`,
  },
  {
    name: 'London-only pullback',
    description: 'Only trades 08:00-12:00 UTC (London open). Buys pullbacks to the 20 EMA in an uptrend.',
    code: `# London-session pullback. Only opens between 08:00 and 12:00 UTC.
# Long when close is above EMA200 (uptrend) AND price touches EMA20.

import math

def ema(bars, length):
    if len(bars) < length:
        return None
    k = 2 / (length + 1)
    # Seed with SMA over the first \`length\` bars, then EMA forward.
    seed = sum(b["close"] for b in bars[:length]) / length
    e = seed
    for b in bars[length:]:
        e = b["close"] * k + e * (1 - k)
    return e

def on_bar(ctx):
    from datetime import datetime, timezone
    hour = datetime.fromtimestamp(ctx.now, tz=timezone.utc).hour
    in_session = 8 <= hour < 12

    if ctx.position is not None:
        # Time-based exit: close before session ends.
        if not in_session:
            ctx.close()
        return

    if not in_session:
        return
    if len(ctx.bars) < 200:
        return

    e20 = ema(ctx.bars, 20)
    e200 = ema(ctx.bars, 200)
    if e20 is None or e200 is None:
        return

    c = ctx.bars[-1]["close"]
    low = ctx.bars[-1]["low"]

    # Uptrend + wick down through EMA20 while close is still above it.
    if c > e200 and low <= e20 <= c:
        entry = ctx.ask
        sl = min(low, e20) * 0.999
        risk = entry - sl
        if risk > 0:
            ctx.buy(0.1, sl=sl, tp=entry + 2 * risk)
`,
  },
]
