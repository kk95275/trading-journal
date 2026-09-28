// Bundled Python helper library that ships with every strategy — no user
// install needed. Written to Pyodide's virtual FS the first time the runtime
// boots and pre-imported into the strategy's globals so `sma`, `ema`, `rsi`,
// `macd`, `atr`, `bbands`, `vwap`, `cross_up`, `cross_down`, etc. are all
// available without a single import line.
//
// Functions accept plain Python lists (or the ctx.opens/closes proxies) and
// return lists the same length as the input, with NaN in warmup positions —
// matches the semantics of the built-in JS custom-indicator helpers.

export const TA_MODULE_SOURCE = String.raw`"""
Bundled trading-journal helpers. Available in every strategy without imports:

    sma, ema, rma, wma, stdev, highest, lowest, change,
    rsi, macd, bbands, atr, vwap, roc, momentum,
    cross_up, cross_down, is_finite

All take a Python list of numbers (closes) or bars (list of dicts with the
usual OHLC keys), and return a list of length == input, with float('nan')
for warmup / undefined positions. That way returned arrays line up 1:1 with
the input bars, so result[-1] is always the current bar's value.
"""

from math import nan, isfinite, sqrt

def is_finite(x):
    """True if x is a real, finite number (not NaN, not inf)."""
    try:
        return isfinite(x)
    except (TypeError, ValueError):
        return False

# ---------- basic reductions ----------

def sma(values, length):
    """Simple moving average. NaN for i < length - 1."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    running = 0.0
    for i in range(n):
        running += values[i]
        if i >= length:
            running -= values[i - length]
        if i >= length - 1:
            out[i] = running / length
    return out

def ema(values, length):
    """Exponential MA. Seeded with SMA of the first 'length' values."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    k = 2 / (length + 1)
    seed = 0.0
    e = nan
    for i in range(n):
        v = values[i]
        if i < length - 1:
            seed += v
            continue
        if i == length - 1:
            seed += v
            e = seed / length
        else:
            e = v * k + e * (1 - k)
        out[i] = e
    return out

def rma(values, length):
    """Wilder's smoothing (aka RMA). Used by RSI/ATR."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    alpha = 1 / length
    seed = 0.0
    r = nan
    for i in range(n):
        v = values[i]
        if i < length - 1:
            seed += v
            continue
        if i == length - 1:
            seed += v
            r = seed / length
        else:
            r = alpha * v + (1 - alpha) * r
        out[i] = r
    return out

def wma(values, length):
    """Linearly-weighted moving average (older bars weighted less)."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    denom = length * (length + 1) / 2
    for i in range(length - 1, n):
        s = 0.0
        for j in range(length):
            s += values[i - j] * (length - j)
        out[i] = s / denom
    return out

def stdev(values, length):
    """Population standard deviation over rolling window of 'length'."""
    n = len(values)
    out = [nan] * n
    if length <= 1 or length > n:
        return out
    for i in range(length - 1, n):
        m = sum(values[i - length + 1:i + 1]) / length
        v = sum((values[j] - m) ** 2 for j in range(i - length + 1, i + 1)) / length
        out[i] = sqrt(v)
    return out

def highest(values, length):
    """Rolling maximum. NaN for i < length - 1."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    for i in range(length - 1, n):
        out[i] = max(values[i - length + 1:i + 1])
    return out

def lowest(values, length):
    """Rolling minimum. NaN for i < length - 1."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length > n:
        return out
    for i in range(length - 1, n):
        out[i] = min(values[i - length + 1:i + 1])
    return out

def change(values, length=1):
    """First (or Nth) differences. NaN for i < length."""
    n = len(values)
    out = [nan] * n
    if length < 1 or length >= n:
        return out
    for i in range(length, n):
        out[i] = values[i] - values[i - length]
    return out

# ---------- classic indicators ----------

def rsi(values, length=14):
    """Relative Strength Index (Wilder's smoothing)."""
    n = len(values)
    out = [nan] * n
    if length <= 0 or length + 1 > n:
        return out
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        d = values[i] - values[i - 1]
        gains[i]  = d if d > 0 else 0.0
        losses[i] = -d if d < 0 else 0.0
    ag = rma(gains, length)
    al = rma(losses, length)
    for i in range(n):
        g, l = ag[i], al[i]
        if not (is_finite(g) and is_finite(l)):
            continue
        if l == 0:
            out[i] = 100.0
        else:
            rs = g / l
            out[i] = 100 - (100 / (1 + rs))
    return out

def macd(values, fast=12, slow=26, signal=9):
    """MACD: returns (line, signal, histogram) tuple of same-length lists."""
    line_fast = ema(values, fast)
    line_slow = ema(values, slow)
    line = [line_fast[i] - line_slow[i] if is_finite(line_fast[i]) and is_finite(line_slow[i]) else nan
            for i in range(len(values))]
    finite_line = [x if is_finite(x) else 0.0 for x in line]
    sig = ema(finite_line, signal)
    # Only expose sig where the underlying line is defined.
    for i in range(len(sig)):
        if not is_finite(line[i]):
            sig[i] = nan
    hist = [line[i] - sig[i] if is_finite(line[i]) and is_finite(sig[i]) else nan
            for i in range(len(values))]
    return line, sig, hist

def bbands(values, length=20, mult=2.0):
    """Bollinger Bands: (upper, mid, lower) as three same-length lists."""
    basis = sma(values, length)
    sd = stdev(values, length)
    upper = [basis[i] + mult * sd[i] if is_finite(basis[i]) else nan for i in range(len(values))]
    lower = [basis[i] - mult * sd[i] if is_finite(basis[i]) else nan for i in range(len(values))]
    return upper, basis, lower

def _true_range(bars):
    n = len(bars)
    out = [nan] * n
    if n == 0:
        return out
    out[0] = bars[0]["high"] - bars[0]["low"]
    for i in range(1, n):
        b = bars[i]
        pc = bars[i - 1]["close"]
        out[i] = max(b["high"] - b["low"], abs(b["high"] - pc), abs(b["low"] - pc))
    return out

def atr(bars, length=14):
    """Average True Range. Pass a list of bar dicts (or ctx.bars)."""
    return rma(_true_range(bars), length)

def vwap(bars):
    """Volume-weighted average price, anchored to each UTC day."""
    n = len(bars)
    out = [nan] * n
    if n == 0:
        return out
    day = -1
    pv = 0.0
    vv = 0.0
    for i in range(n):
        b = bars[i]
        d = int(b["time"] // 86400)
        if d != day:
            day = d
            pv = 0.0
            vv = 0.0
        vol = b["volume"] if b["volume"] > 0 else 1
        typical = (b["high"] + b["low"] + b["close"]) / 3
        pv += typical * vol
        vv += vol
        out[i] = pv / vv
    return out

def roc(values, length):
    """Rate of change (percent), NaN until enough history."""
    n = len(values)
    out = [nan] * n
    if length < 1 or length >= n:
        return out
    for i in range(length, n):
        prev = values[i - length]
        if prev != 0:
            out[i] = (values[i] / prev - 1.0) * 100
    return out

def momentum(values, length):
    """Momentum = values[i] - values[i - length]."""
    return change(values, length)

# ---------- crossover helpers ----------

def cross_up(a, b):
    """True on the bar where series 'a' just crossed above series 'b'."""
    if len(a) < 2 or len(b) < 2:
        return False
    return is_finite(a[-2]) and is_finite(b[-2]) and is_finite(a[-1]) and is_finite(b[-1]) \
        and a[-2] <= b[-2] and a[-1] > b[-1]

def cross_down(a, b):
    """True on the bar where series 'a' just crossed below series 'b'."""
    if len(a) < 2 or len(b) < 2:
        return False
    return is_finite(a[-2]) and is_finite(b[-2]) and is_finite(a[-1]) and is_finite(b[-1]) \
        and a[-2] >= b[-2] and a[-1] < b[-1]

# Also allow single-number forms for convenience:  cross_up(sma5[-1], sma20[-1])
# doesn't make sense (we need two values), so we accept lists only above.
`
