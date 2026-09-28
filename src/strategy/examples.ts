// Starter Python strategies. Each one is a complete, runnable file: users
// can click "Load example" and hit Run immediately.
//
// Every example uses the bundled `ta` module (sma, ema, rsi, bbands, atr,
// vwap, cross_up, cross_down, ...) — no user install ever needed — and the
// convenience OHLC accessors on ctx (ctx.close, ctx.closes, ctx.highs, etc.).

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
# Longs only, one position at a time. Fixed 0.1 lots.

FAST = 20
SLOW = 50

def on_bar(ctx):
    fast = sma(ctx.closes, FAST)
    slow = sma(ctx.closes, SLOW)
    if cross_up(fast, slow) and ctx.position is None:
        ctx.buy(0.1)
    elif cross_down(fast, slow) and ctx.position is not None:
        ctx.exit()
`,
  },
  {
    name: 'RSI mean reversion',
    description: 'Buy oversold RSI < 30, sell overbought > 70. Simple mean reversion.',
    code: `# RSI(14) mean reversion.
# Long when RSI dips below 30; exit when it climbs above 55.

def on_bar(ctx):
    v = rsi(ctx.closes, 14)
    if not is_finite(v[-1]):
        return
    if ctx.position is None and v[-1] < 30:
        entry = ctx.ask
        ctx.buy(0.1, sl=entry * 0.995, tp=entry * 1.015)
    elif ctx.position is not None and v[-1] > 55:
        ctx.exit()
`,
  },
  {
    name: 'Bollinger breakout',
    description: 'Long a close above the upper band, short a close below the lower band.',
    code: `# Bollinger breakout — trades continuation, not reversion.
# 20-period basis, 2 sigma. Uses a fixed R:R of 2 with SL at the basis.

def on_bar(ctx):
    upper, basis, lower = bbands(ctx.closes, 20, 2.0)
    if not is_finite(basis[-1]):
        return
    if ctx.position is not None:
        return
    if ctx.close > upper[-1]:
        entry = ctx.ask
        dist = entry - basis[-1]
        ctx.buy(0.1, sl=basis[-1], tp=entry + 2 * dist)
    elif ctx.close < lower[-1]:
        entry = ctx.bid
        dist = basis[-1] - entry
        ctx.sell(0.1, sl=basis[-1], tp=entry - 2 * dist)
`,
  },
  {
    name: 'ATR-based pullback',
    description: 'Only trades London (08–12 UTC). Buys pullbacks with an ATR-scaled stop.',
    code: `# London-session pullback with ATR-based risk sizing.

def on_bar(ctx):
    from datetime import datetime, timezone
    hour = datetime.fromtimestamp(ctx.now, tz=timezone.utc).hour
    in_session = 8 <= hour < 12

    if ctx.position is not None and not in_session:
        ctx.exit()
        return

    if not in_session or len(ctx.bars) < 200:
        return

    e20  = ema(ctx.closes, 20)
    e200 = ema(ctx.closes, 200)
    a    = atr(ctx.bars, 14)
    if not (is_finite(e20[-1]) and is_finite(e200[-1]) and is_finite(a[-1])):
        return

    # Uptrend + wick down through EMA20 while close stays above.
    if ctx.close > e200[-1] and ctx.low <= e20[-1] <= ctx.close:
        entry = ctx.ask
        sl = entry - 1.2 * a[-1]
        tp = entry + 2.4 * a[-1]
        ctx.buy(0.1, sl=sl, tp=tp)
`,
  },
  {
    name: 'Multi-TF trend + entry',
    description: 'Take entries on 5m only when the 1h and 4h EMAs both agree with the trade direction.',
    code: `# Multi-timeframe trend filter.
# Entry timeframe: 5m EMA 21 pullbacks in the direction of a stacked EMA trend.
# Trend filter:    1h EMA 50 above/below 4h EMA 200 → direction bias.

def on_bar(ctx):
    # Aggregate the underlying 1m into higher timeframes on demand.
    m5 = ctx.tf('5m')
    h1 = ctx.tf('1h')
    h4 = ctx.tf('4h')

    # Need enough history on the slowest tf.
    if len(h4.bars) < 200 or len(h1.bars) < 50 or len(m5.bars) < 21:
        return

    trend_up   = h1.closes[-2] > ema(h1.closes, 50)[-2] and h4.closes[-2] > ema(h4.closes, 200)[-2]
    trend_down = h1.closes[-2] < ema(h1.closes, 50)[-2] and h4.closes[-2] < ema(h4.closes, 200)[-2]

    e21 = ema(m5.closes, 21)
    if not is_finite(e21[-1]):
        return

    if ctx.position is None:
        # Long a wick down through the 5m EMA21 while the higher-tf trend is up.
        if trend_up and m5.low <= e21[-1] <= m5.close:
            entry = ctx.ask
            ctx.buy(0.1, sl=entry * 0.997, tp=entry * 1.006)
        elif trend_down and m5.high >= e21[-1] >= m5.close:
            entry = ctx.bid
            ctx.sell(0.1, sl=entry * 1.003, tp=entry * 0.994)
`,
  },
  {
    name: 'MACD momentum',
    description: 'MACD-line crossing above signal in a positive-histogram regime.',
    code: `# MACD momentum entry, TP/SL scaled by the histogram magnitude.

def on_bar(ctx):
    line, sig, hist = macd(ctx.closes)  # defaults 12/26/9
    if not (is_finite(line[-1]) and is_finite(sig[-1])):
        return
    # Long: fresh cross and expanding positive histogram.
    if ctx.position is None and cross_up(line, sig) and hist[-1] > 0:
        entry = ctx.ask
        ctx.buy(0.1, sl=entry * 0.997, tp=entry * 1.008)
    # Exit on the opposite cross.
    elif ctx.position is not None and cross_down(line, sig):
        ctx.exit()
`,
  },
]
