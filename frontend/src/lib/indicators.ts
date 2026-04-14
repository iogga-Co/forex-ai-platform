/**
 * Client-side technical indicator library.
 *
 * Formulas match the backend (engine/indicators.py) and TradingView:
 *  - EMA  : ewm(span=N, adjust=False)  → alpha = 2/(N+1)
 *  - RMA  : ewm(alpha=1/N, adjust=False) — used for RSI / ATR / ADX
 *  - BB   : sample std (ddof=1)
 *  - STOCH: SMA-smoothed %K then %D
 *
 * All functions return (number | null)[] — null for the warm-up period.
 */

export type Series = (number | null)[];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Wilder's RMA: alpha = 1/period */
function rma(values: number[], period: number): Series {
  const alpha = 1 / period;
  const out: Series = new Array(values.length).fill(null);
  let val = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i > 0) val = alpha * values[i] + (1 - alpha) * val;
    if (i >= period - 1) out[i] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public indicator functions
// ---------------------------------------------------------------------------

export function ema(closes: number[], period: number): Series {
  const alpha = 2 / (period + 1);
  const out: Series = new Array(closes.length).fill(null);
  let val = closes[0];
  for (let i = 0; i < closes.length; i++) {
    if (i > 0) val = alpha * closes[i] + (1 - alpha) * val;
    if (i >= period - 1) out[i] = val;
  }
  return out;
}

export function sma(closes: number[], period: number): Series {
  const out: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out[i] = sum / period;
  }
  return out;
}

export function rsi(closes: number[], period = 14): Series {
  if (closes.length < 2) return new Array(closes.length).fill(null);
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return closes.map((_, i) => {
    if (ag[i] === null || al[i] === null) return null;
    const g = ag[i] as number, l = al[i] as number;
    if (l === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / l);
  });
}

export interface MacdResult { line: Series; signal: Series; hist: Series }

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line: Series = closes.map((_, i) => {
    if (fastEma[i] === null || slowEma[i] === null) return null;
    return (fastEma[i] as number) - (slowEma[i] as number);
  });

  // EMA of the MACD line (recursive, starting from first non-null value)
  const alpha = 2 / (signalPeriod + 1);
  const signal: Series = new Array(closes.length).fill(null);
  let sigVal: number | null = null;
  let count = 0;
  for (let i = 0; i < closes.length; i++) {
    if (line[i] === null) continue;
    const v = line[i] as number;
    sigVal = sigVal === null ? v : alpha * v + (1 - alpha) * sigVal;
    count++;
    if (count >= signalPeriod) signal[i] = sigVal;
  }

  const hist: Series = line.map((v, i) => {
    if (v === null || signal[i] === null) return null;
    return (v as number) - (signal[i] as number);
  });

  return { line, signal, hist };
}

export interface BBResult { upper: Series; middle: Series; lower: Series }

export function bollingerBands(closes: number[], period = 20, stdDev = 2.0): BBResult {
  const mid = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    // ddof=1 (sample std), matching TradingView and the Python backend
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (period - 1);
    const std = Math.sqrt(variance);
    upper[i] = (mid[i] as number) + stdDev * std;
    lower[i] = (mid[i] as number) - stdDev * std;
  }
  return { upper, middle: mid, lower };
}

export function atr(highs: number[], lows: number[], closes: number[], period = 14): Series {
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return rma(tr, period);
}

export function adx(highs: number[], lows: number[], closes: number[], period = 14): Series {
  const n = closes.length;
  const tr: number[] = [highs[0] - lows[0]];
  const posDM: number[] = [0];
  const negDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    posDM.push(up > dn && up > 0 ? up : 0);
    negDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const sTr = rma(tr, period);
  const sPos = rma(posDM, period);
  const sNeg = rma(negDM, period);
  const dx: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!sTr[i]) continue;
    const t = sTr[i] as number;
    const diP = 100 * (sPos[i] as number) / t;
    const diN = 100 * (sNeg[i] as number) / t;
    const sum = diP + diN;
    if (sum > 0) dx[i] = 100 * Math.abs(diP - diN) / sum;
  }
  return rma(dx, period);
}

export interface StochResult { k: Series; d: Series }

export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod = 14,
  kSmooth = 3,
  dPeriod = 3,
): StochResult {
  const n = closes.length;
  const rawK: Series = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    rawK[i] = hh === ll ? null : 100 * (closes[i] - ll) / (hh - ll);
  }
  // %K = SMA(rawK, kSmooth)
  const k: Series = new Array(n).fill(null);
  for (let i = kPeriod + kSmooth - 2; i < n; i++) {
    const slice = rawK.slice(i - kSmooth + 1, i + 1);
    if (slice.some(v => v === null)) continue;
    k[i] = (slice as number[]).reduce((a, b) => a + b, 0) / kSmooth;
  }
  // %D = SMA(k, dPeriod)
  const d: Series = new Array(n).fill(null);
  for (let i = kPeriod + kSmooth + dPeriod - 3; i < n; i++) {
    const slice = k.slice(i - dPeriod + 1, i + 1);
    if (slice.some(v => v === null)) continue;
    d[i] = (slice as number[]).reduce((a, b) => a + b, 0) / dPeriod;
  }
  return { k, d };
}

// ---------------------------------------------------------------------------
// Helper: convert a Series + timestamps array → lightweight-charts data array
// ---------------------------------------------------------------------------
export function toChartData(
  times: number[],
  series: Series,
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  for (let i = 0; i < times.length; i++) {
    if (series[i] !== null && !isNaN(series[i] as number)) {
      result.push({ time: times[i], value: series[i] as number });
    }
  }
  return result;
}
