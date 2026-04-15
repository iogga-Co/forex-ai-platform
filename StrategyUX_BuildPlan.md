# Strategy UX Enhancements — Detailed Build Plan

**Spec:** `StrategyUXSpecs.md`  
**Date:** April 2026  
**Branch convention:** `feat/strategy-ux`

---

## Pre-flight: what the code already has

Before touching anything, understand what exists:

| Existing piece | Location | Relevance |
|---|---|---|
| IR rendering (chips) | `BacktestResultPanel.tsx:508–628` | Feature 1 replaces/extends this |
| `condParams()` helper | `BacktestResultPanel.tsx:535–553` | Feature 1 reuses its logic |
| `condComparison()` helper | `BacktestResultPanel.tsx:555–561` | Feature 1 replaces this |
| `Chip` component | `BacktestResultPanel.tsx:568–573` | Feature 1 replaces with `ConditionCard` |
| `Metrics` interface | `BacktestResultPanel.tsx:27–35` | Feature 3 reads from this |
| `result.trades` | `BacktestResultPanel.tsx:151` | Feature 3 needs trades to compute profit factor |
| `POST /api/strategies` | `backend/routers/strategy.py:44` | Feature 2 calls this to save fix variant |
| `get_full_response()` | `backend/ai/claude_client.py:143` | Feature 2 reuses this for Claude call |
| Router registration | `backend/main.py:14,82–91` | Feature 2 adds new `diagnosis` router here |

**Critical gap — profit factor missing from `Metrics`:**  
`BacktestResultPanel.tsx:27–35` — the `Metrics` interface has no `profit_factor` field.  
The Edge Quality badge needs it. **Do not add it to the backend** — compute it from `result.trades` on the frontend:
```ts
const winners = result.trades.filter(t => t.pnl > 0);
const losers  = result.trades.filter(t => t.pnl < 0);
const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
```

---

## Feature 1 — Visual Strategy Story (Condition Cards)

### Step 1-A: Create `src/lib/strategyLabels.ts`

New file. No dependencies on anything existing. Can be written and tested in isolation.

Define the IR types that this file operates on (copy from `BacktestResultPanel.tsx:509–522`):

```ts
export interface EntryCondition {
  indicator: string;
  period?: number;
  operator: string;
  value?: number | null;
  component?: string | null;
  fast?: number | null;
  slow?: number | null;
  signal_period?: number | null;
  std_dev?: number | null;
  k_smooth?: number | null;
  d_period?: number | null;
}

export interface ExitCondition {
  type: string;
  period?: number | null;
  multiplier?: number | null;
  pips?: number | null;
  percent?: number | null;
}
```

Implement `conditionToLabel(c: EntryCondition): string`:

```ts
export function conditionToLabel(c: EntryCondition): string {
  const p = c.period;

  switch (c.indicator) {
    case "RSI": {
      const dir = c.operator === ">" || c.operator === ">=" ? "above" : "below";
      const hint = c.value != null && c.value >= 50
        ? "momentum positive"
        : c.value != null && c.value < 50 ? "momentum negative" : "";
      return `RSI (${p}) ${dir} ${c.value}${hint ? ` — ${hint}` : ""}`;
    }
    case "EMA":
      if (c.operator === "price_above") return `Price above EMA (${p})`;
      if (c.operator === "price_below") return `Price below EMA (${p})`;
      if (c.operator === "crossed_above") return `Price crosses above EMA (${p})`;
      if (c.operator === "crossed_below") return `Price crosses below EMA (${p})`;
      return `EMA (${p}) ${c.operator} ${c.value}`;
    case "SMA":
      if (c.operator === "price_above") return `Price above SMA (${p})`;
      if (c.operator === "price_below") return `Price below SMA (${p})`;
      return `SMA (${p}) ${c.operator} ${c.value}`;
    case "MACD":
      if (c.operator === "crossed_above" || c.operator === "cross_above")
        return `MACD crosses above signal (${c.fast}/${c.slow}/${c.signal_period})`;
      if (c.operator === "crossed_below" || c.operator === "cross_below")
        return `MACD crosses below signal (${c.fast}/${c.slow}/${c.signal_period})`;
      return `MACD (${c.fast}/${c.slow}/${c.signal_period}) ${c.operator} ${c.value}`;
    case "BB": {
      const comp = c.component ?? "middle";
      const band = comp === "upper" ? "upper" : comp === "lower" ? "lower" : "middle";
      if (c.operator === "price_above") return `Price above ${band} Bollinger Band (${p}, ${c.std_dev}σ)`;
      if (c.operator === "price_below") return `Price below ${band} Bollinger Band (${p}, ${c.std_dev}σ)`;
      return `BB ${band} (${p}, ${c.std_dev}σ) ${c.operator} ${c.value}`;
    }
    case "ATR":
      return `ATR (${p}) ${c.operator} ${c.value}`;
    case "ADX": {
      const hint = c.value != null && c.value >= 25 ? "trend strong" : "trend weak";
      return `ADX (${p}) ${c.operator === ">" || c.operator === ">=" ? "above" : "below"} ${c.value} — ${hint}`;
    }
    case "STOCH": {
      const dir = c.operator === "<" || c.operator === "<=" ? "below" : "above";
      const hint = c.value != null && c.value <= 20 ? "oversold" : c.value != null && c.value >= 80 ? "overbought" : "";
      return `Stochastic (K) ${dir} ${c.value}${hint ? ` — ${hint}` : ""}`;
    }
    default:
      return `${c.indicator} ${c.operator} ${c.value ?? ""}`.trim();
  }
}
```

Implement `exitConditionToLabel(label: "Stop Loss" | "Take Profit", ex: ExitCondition): string`:

```ts
export function exitConditionToLabel(
  label: "Stop Loss" | "Take Profit",
  ex: ExitCondition
): string {
  if (ex.type === "atr")        return `${label}: ATR (${ex.period}) × ${ex.multiplier}`;
  if (ex.type === "fixed_pips") return `${label}: ${ex.pips} pips`;
  if (ex.type === "percent")    return `${label}: ${((ex.percent ?? 0) * 100).toFixed(2)}%`;
  return `${label}: ${ex.type}`;
}
```

Implement `filterToLabels(filters: { exclude_days?: string[]; session?: string }): string[]`:

```ts
export function filterToLabels(filters: {
  exclude_days?: string[];
  session?: string;
}): string[] {
  const labels: string[] = [];
  if (filters.session && filters.session !== "all") {
    const map: Record<string, string> = {
      london_open: "London session only",
      new_york_open: "New York session only",
      asian_session: "Asian session only",
    };
    labels.push(map[filters.session] ?? `Session: ${filters.session}`);
  }
  if (filters.exclude_days && filters.exclude_days.length > 0) {
    labels.push(`Excludes ${filters.exclude_days.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ")}`);
  }
  return labels;
}
```

### Step 1-B: Update `BacktestResultPanel.tsx` — add toggle state and ConditionCard

**Add import** at top of file:
```ts
import { conditionToLabel, exitConditionToLabel, filterToLabels } from "@/lib/strategyLabels";
```

**Add toggle state** inside `BacktestResultPanel` component, after the existing state declarations (around line 161):
```ts
const [irView, setIrView] = useState<"story" | "json">("story");
```

**Add `ConditionCard` component** as a local function just above the strategy info block render (before line 508). This lives inside the IIFE that already wraps the strategy render — move it up as a named helper instead:

```tsx
function ConditionCard({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 leading-snug">
      {text}
    </div>
  );
}
```

**Replace the strategy info block** (lines 508–628) with a new version:

The outer container (`<div className="bg-gray-800 rounded-lg px-3 py-2.5 space-y-2">`) stays the same.

Replace the header row (lines 578–583) with the header + Story/JSON toggle:
```tsx
<div className="flex items-baseline justify-between gap-3">
  <p className="text-xs font-medium text-gray-200 truncate">{strategy.description}</p>
  <div className="flex items-center gap-3 shrink-0">
    <div className="flex text-[10px]">
      {(["story", "json"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setIrView(v)}
          className={`px-2 py-0.5 capitalize transition-colors ${
            irView === v
              ? "text-blue-400 border-b border-blue-500"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          {v}
        </button>
      ))}
    </div>
    <p className="text-[10px] text-gray-500 font-mono">
      {strategy.pair} · {strategy.timeframe} · v{strategy.version}
    </p>
  </div>
</div>
```

Below the header, replace the entry conditions grid (lines 586–603) with a conditional:

```tsx
{ir.entry_conditions && ir.entry_conditions.length > 0 && (() => {
  const n = ir.entry_conditions!.length;
  const cols = n <= 2 ? "grid-cols-1" : n <= 4 ? "grid-cols-2" : "grid-cols-3";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Entry</p>
      {irView === "story" ? (
        <div className={`grid ${cols} gap-2`}>
          {ir.entry_conditions!.map((c, i) => (
            <ConditionCard key={i} text={conditionToLabel(c)} />
          ))}
        </div>
      ) : (
        /* existing chip rendering — keep the original code verbatim */
        <div className={`grid ${cols} gap-x-4 gap-y-1`}>
          {ir.entry_conditions!.map((c, i) => {
            const params = condParams(c);
            return (
              <div key={i} className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold text-blue-400 font-mono w-10 shrink-0">{c.indicator}</span>
                {params.map(({ key, val }) => <Chip key={key} label={key} value={val} />)}
                <span className="text-[10px] text-gray-600 italic">{condComparison(c)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
})()}
```

Replace the exit/filter row (lines 606–626) with:

```tsx
{irView === "story" ? (
  <div className="flex flex-wrap gap-2 border-t border-gray-700/60 pt-1.5">
    {sl && <ConditionCard text={exitConditionToLabel("Stop Loss", sl)} />}
    {tp && <ConditionCard text={exitConditionToLabel("Take Profit", tp)} />}
    {filters && filterToLabels(filters).map((lbl, i) => (
      <ConditionCard key={i} text={lbl} />
    ))}
  </div>
) : (
  /* keep original exit/filter chip row verbatim */
  <div className="flex items-center gap-1.5 flex-wrap border-t border-gray-700/60 pt-1.5">
    {/* ... original lines 607–625 unchanged ... */}
  </div>
)}
```

### Step 1-C: Reuse in Optimization page

In `frontend/src/app/optimization/page.tsx` — find wherever `ir_json` / `strategy_ir` fields are displayed as chips and import `conditionToLabel` from `@/lib/strategyLabels` to render story-mode cards there too. (Read that file first before editing to locate the exact render.)

---

## Feature 3 — Strategy Health Badges

> Build this second — it's pure frontend, no backend, and tests the `BacktestResultPanel` props pipeline before adding the more complex Feature 2.

### Step 3-A: Create `src/lib/strategyHealth.ts`

```ts
export type BadgeRating = "positive" | "neutral" | "negative";

export interface HealthBadge {
  label: string;
  value: string;
  rating: BadgeRating;
}

export function computeHealthBadges(
  metrics: {
    win_rate: number | null;
    max_dd: number | null;
    sharpe: number | null;
  },
  profitFactor: number | null,
  avgWinDuration: number | null,   // minutes
  avgLossDuration: number | null,  // minutes
): HealthBadge[] {
  const badges: HealthBadge[] = [];

  // Consistency — win rate
  if (metrics.win_rate !== null) {
    const wr = metrics.win_rate * 100;
    badges.push({
      label: "Consistency",
      value: wr >= 55 ? "High" : wr >= 45 ? "Medium" : "Low",
      rating: wr >= 55 ? "positive" : wr >= 45 ? "neutral" : "negative",
    });
  }

  // Risk Level — max drawdown
  if (metrics.max_dd !== null) {
    const dd = Math.abs(metrics.max_dd) * 100;
    badges.push({
      label: "Risk Level",
      value: dd < 5 ? "Low" : dd <= 15 ? "Medium" : "High",
      rating: dd < 5 ? "positive" : dd <= 15 ? "neutral" : "negative",
    });
  }

  // Recovery Speed — ratio of avg loser duration to avg winner duration
  if (avgWinDuration !== null && avgLossDuration !== null && avgWinDuration > 0) {
    const ratio = avgLossDuration / avgWinDuration;
    badges.push({
      label: "Recovery Speed",
      value: ratio < 1.5 ? "Fast" : ratio <= 3 ? "Moderate" : "Slow",
      rating: ratio < 1.5 ? "positive" : ratio <= 3 ? "neutral" : "negative",
    });
  }

  // Edge Quality — profit factor
  if (profitFactor !== null) {
    badges.push({
      label: "Edge Quality",
      value: profitFactor > 1.8 ? "Strong" : profitFactor >= 1.2 ? "Moderate" : "Weak",
      rating: profitFactor > 1.8 ? "positive" : profitFactor >= 1.2 ? "neutral" : "negative",
    });
  }

  return badges;
}
```

### Step 3-B: Update `BacktestResultPanel.tsx` — add badge strip

**Add import:**
```ts
import { computeHealthBadges, type HealthBadge } from "@/lib/strategyHealth";
```

**Compute badges** in the render body, after `const m = result.metrics;` (line 442):

```ts
// Profit factor — computed from trades (not in Metrics interface)
const winners = result.trades.filter(t => t.pnl > 0);
const losers  = result.trades.filter(t => t.pnl < 0);
const grossProfit  = winners.reduce((s, t) => s + t.pnl, 0);
const grossLoss    = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

// Avg duration per outcome (minutes)
function durationMin(t: Trade) {
  return (new Date(t.exit_time).getTime() - new Date(t.entry_time).getTime()) / 60000;
}
const avgWinDuration  = winners.length > 0
  ? winners.reduce((s, t) => s + durationMin(t), 0) / winners.length : null;
const avgLossDuration = losers.length > 0
  ? losers.reduce((s, t) => s + durationMin(t), 0) / losers.length : null;

const healthBadges = computeHealthBadges(m, profitFactor, avgWinDuration, avgLossDuration);
```

**Render the badge strip** inside the JSX, immediately before the metric cards grid (before line 631):

```tsx
{healthBadges.length > 0 && (
  <div className="flex flex-wrap gap-2">
    {healthBadges.map((b) => {
      const colours: Record<string, string> = {
        positive: "text-emerald-400 border-emerald-800 bg-emerald-900/20",
        neutral:  "text-yellow-400 border-yellow-800 bg-yellow-900/20",
        negative: "text-red-400 border-red-800 bg-red-900/20",
      };
      return (
        <span
          key={b.label}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${colours[b.rating]}`}
        >
          <span className="text-slate-400">{b.label}:</span>
          <span>{b.value}</span>
        </span>
      );
    })}
  </div>
)}
```

---

## Feature 2 — AI-Suggested Improvements (Diagnose Strategy)

> Build last — depends on backend work and is the most complex.

### Step 2-A: Create `backend/ai/strategy_diagnosis.py`

New file. Pattern follows `claude_client.py` closely — imports `get_full_response` from there.

```python
"""
Strategy diagnosis — AI-powered weakness identification.

Given pre-computed trade statistics for a backtest run, calls Claude
and returns up to 3 structured fix suggestions with ir_patch objects.
"""

import json
import logging
from typing import Any

from ai.claude_client import get_full_response

logger = logging.getLogger(__name__)


async def diagnose_strategy(
    strategy_name: str,
    pair: str,
    timeframe: str,
    metrics: dict[str, Any],
    trade_stats: dict[str, Any],   # pre-computed — see router
) -> dict[str, Any]:
    """
    Call Claude to identify the top 3 weaknesses in a backtest result
    and return structured fix suggestions with ir_patch objects.
    """
    prompt = _build_prompt(strategy_name, pair, timeframe, metrics, trade_stats)
    raw = await get_full_response([{"role": "user", "content": prompt}])
    return _parse_response(raw)


def _build_prompt(
    strategy_name: str,
    pair: str,
    timeframe: str,
    metrics: dict[str, Any],
    stats: dict[str, Any],
) -> str:
    dow   = stats.get("by_dow", {})
    hour  = stats.get("by_hour", {})
    worst_days  = sorted(dow.items(),  key=lambda x: x[1]["win_rate"])[:3]
    worst_hours = sorted(hour.items(), key=lambda x: x[1]["win_rate"])[:3]

    return f"""You are a quantitative trading analyst reviewing a forex strategy backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {timeframe}

Metrics:
- Win rate: {metrics.get("win_rate", 0)*100:.1f}%
- Max drawdown: {abs(metrics.get("max_dd") or 0)*100:.1f}%
- Sharpe ratio: {metrics.get("sharpe") or "N/A"}
- Profit factor: {stats.get("profit_factor") or "N/A"}
- Total trades: {metrics.get("trade_count")}
- Stop-out rate (stopped before MFE > 0): {stats.get("stop_out_rate_pct", 0):.1f}%

Day-of-week breakdown (worst performing):
{chr(10).join(f"  {d}: win rate {v['win_rate']*100:.0f}% ({v['count']} trades)" for d, v in worst_days)}

Hour-of-day breakdown (worst performing, UTC):
{chr(10).join(f"  {h}:00 UTC: win rate {v['win_rate']*100:.0f}% ({v['count']} trades)" for h, v in worst_hours)}

Direction breakdown:
  Longs:  {stats.get("long_win_rate", 0)*100:.1f}% win rate ({stats.get("long_count", 0)} trades)
  Shorts: {stats.get("short_win_rate", 0)*100:.1f}% win rate ({stats.get("short_count", 0)} trades)

Avg loss R-multiple: {stats.get("avg_loss_r") or "N/A"}
Avg win R-multiple:  {stats.get("avg_win_r") or "N/A"}

Identify exactly 3 concrete improvements. For each, provide:
1. A plain-English finding (1 sentence, specific numbers)
2. An action label (short button text, e.g. "Apply Monday Filter")
3. An ir_patch: a partial SIR JSON object that applies the fix

Valid ir_patch structures:
- Add day filter: {{"filters": {{"exclude_days": ["monday"]}}}}
- Change session: {{"filters": {{"session": "london_open"}}}}
- Increase ATR SL multiplier: {{"exit_conditions": {{"stop_loss": {{"type": "atr", "period": 14, "multiplier": 2.0}}}}}}
- Raise RSI threshold: update entry_conditions array with new value

Respond ONLY with a JSON object in this exact schema:
{{
  "findings": [
    {{
      "id": "snake_case_id",
      "finding": "plain English finding with specific numbers",
      "action_label": "Short button label",
      "ir_patch": {{ ... partial SIR ... }},
      "confidence": "high" | "medium" | "low"
    }}
  ]
}}
"""


def _parse_response(raw: str) -> dict[str, Any]:
    """Extract and validate the JSON findings from Claude's response."""
    # Strip markdown fences if present
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    try:
        data = json.loads(text)
        findings = data.get("findings", [])
        # Validate each finding has required fields
        valid = [
            f for f in findings
            if all(k in f for k in ("id", "finding", "action_label", "ir_patch"))
        ]
        return {"findings": valid[:3]}   # cap at 3
    except Exception as exc:
        logger.warning("Strategy diagnosis parse failed: %s | raw: %.200s", exc, raw)
        return {"findings": []}
```

### Step 2-B: Create `backend/routers/diagnosis.py`

```python
"""
Diagnosis endpoints.

POST /api/diagnosis/strategy — AI-powered strategy weakness analysis
"""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ai.strategy_diagnosis import diagnose_strategy
from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/diagnosis", tags=["Diagnosis"])


def _f(v):
    return float(v) if v is not None else None


class DiagnoseStrategyRequest(BaseModel):
    backtest_run_id: UUID


@router.post("/strategy")
async def diagnose_strategy_endpoint(
    payload: DiagnoseStrategyRequest,
    user: Annotated[TokenData | None, Depends(get_current_user)] = None,
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Fetch run metrics + strategy info
        run = await conn.fetchrow(
            """
            SELECT br.pair, br.timeframe, br.strategy_id,
                   br.sharpe, br.max_dd, br.win_rate, br.trade_count,
                   s.description
            FROM backtest_results br
            JOIN strategies s ON s.id = br.strategy_id
            WHERE br.id = $1
            """,
            payload.backtest_run_id,
        )
        if not run:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        # Fetch all trades for the run
        trades = await conn.fetch(
            """
            SELECT direction, pnl, r_multiple, mae, mfe,
                   entry_time, exit_time
            FROM trades
            WHERE backtest_run_id = $1
            """,
            payload.backtest_run_id,
        )

    # Pre-compute statistics (no AI involved)
    stats = _compute_stats(trades)

    metrics = {
        "sharpe":      _f(run["sharpe"]),
        "max_dd":      _f(run["max_dd"]),
        "win_rate":    _f(run["win_rate"]),
        "trade_count": run["trade_count"],
    }

    result = await diagnose_strategy(
        strategy_name=run["description"],
        pair=run["pair"],
        timeframe=run["timeframe"],
        metrics=metrics,
        trade_stats=stats,
    )
    return result


def _compute_stats(trades) -> dict:
    if not trades:
        return {}

    winners = [t for t in trades if t["pnl"] and float(t["pnl"]) > 0]
    losers  = [t for t in trades if t["pnl"] and float(t["pnl"]) <= 0]

    gross_profit = sum(float(t["pnl"]) for t in winners)
    gross_loss   = abs(sum(float(t["pnl"]) for t in losers))
    profit_factor = round(gross_profit / gross_loss, 3) if gross_loss > 0 else None

    # Stop-out rate: trades where exit_price hit SL before MFE went positive
    stop_outs = [t for t in losers if t["mfe"] is not None and float(t["mfe"]) <= 0]
    stop_out_rate = len(stop_outs) / len(trades) * 100 if trades else 0

    # Direction breakdown
    longs  = [t for t in trades if t["direction"] == "long"]
    shorts = [t for t in trades if t["direction"] == "short"]
    long_winners  = [t for t in longs  if t["pnl"] and float(t["pnl"]) > 0]
    short_winners = [t for t in shorts if t["pnl"] and float(t["pnl"]) > 0]

    # Day-of-week breakdown
    by_dow: dict[str, dict] = {}
    for t in trades:
        day = t["entry_time"].strftime("%A").lower()  # e.g. "monday"
        if day not in by_dow:
            by_dow[day] = {"count": 0, "wins": 0}
        by_dow[day]["count"] += 1
        if t["pnl"] and float(t["pnl"]) > 0:
            by_dow[day]["wins"] += 1
    for v in by_dow.values():
        v["win_rate"] = round(v["wins"] / v["count"], 3) if v["count"] > 0 else 0

    # Hour-of-day breakdown (UTC)
    by_hour: dict[str, dict] = {}
    for t in trades:
        h = str(t["entry_time"].hour)
        if h not in by_hour:
            by_hour[h] = {"count": 0, "wins": 0}
        by_hour[h]["count"] += 1
        if t["pnl"] and float(t["pnl"]) > 0:
            by_hour[h]["wins"] += 1
    for v in by_hour.values():
        v["win_rate"] = round(v["wins"] / v["count"], 3) if v["count"] > 0 else 0

    # Avg R by outcome
    avg_win_r  = round(sum(_f(t["r_multiple"]) or 0 for t in winners) / len(winners), 3) if winners else None
    avg_loss_r = round(sum(_f(t["r_multiple"]) or 0 for t in losers)  / len(losers),  3) if losers  else None

    return {
        "profit_factor":    profit_factor,
        "stop_out_rate_pct": round(stop_out_rate, 1),
        "long_count":       len(longs),
        "short_count":      len(shorts),
        "long_win_rate":    round(len(long_winners)  / len(longs),  3) if longs  else 0,
        "short_win_rate":   round(len(short_winners) / len(shorts), 3) if shorts else 0,
        "avg_win_r":        avg_win_r,
        "avg_loss_r":       avg_loss_r,
        "by_dow":           by_dow,
        "by_hour":          by_hour,
    }
```

### Step 2-C: Register the new router in `backend/main.py`

**Line 14** — add `diagnosis` to the import:
```python
from routers import analytics, auth, backtest, candles, copilot, diagnosis, health, optimization, strategy, trading, ws
```

**After line 91** — register after `optimization.router`:
```python
app.include_router(diagnosis.router)
```

Restart fastapi container: `doppler run -- docker compose restart fastapi`

### Step 2-D: Create `src/lib/irPatch.ts`

```ts
import type { EntryCondition } from "./strategyLabels";

export interface StrategyIR {
  entry_conditions?: EntryCondition[];
  exit_conditions?: {
    stop_loss?:   { type: string; period?: number; multiplier?: number; pips?: number; percent?: number };
    take_profit?: { type: string; period?: number; multiplier?: number; pips?: number; percent?: number };
  };
  filters?: {
    exclude_days?: string[];
    session?: string;
  };
  position_sizing?: {
    risk_per_trade_pct?: number;
    max_size_units?: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Merge a partial SIR patch onto a base SIR.
 * - Scalar fields: patch wins
 * - Arrays (entry_conditions, exclude_days): patch replaces base
 * - exit_conditions: deep merge (patch fields win, unpatch fields kept)
 * - filters: deep merge
 */
export function mergeIrPatch(base: StrategyIR, patch: Partial<StrategyIR>): StrategyIR {
  const result = structuredClone(base);

  if (patch.entry_conditions !== undefined) {
    result.entry_conditions = patch.entry_conditions;
  }
  if (patch.exit_conditions !== undefined) {
    result.exit_conditions = {
      ...result.exit_conditions,
      ...patch.exit_conditions,
    };
  }
  if (patch.filters !== undefined) {
    result.filters = {
      ...result.filters,
      ...patch.filters,
    };
    // If patch adds to exclude_days, merge arrays rather than replace
    if (patch.filters.exclude_days && base.filters?.exclude_days) {
      const merged = Array.from(new Set([
        ...base.filters.exclude_days,
        ...patch.filters.exclude_days,
      ]));
      result.filters!.exclude_days = merged;
    }
  }
  if (patch.position_sizing !== undefined) {
    result.position_sizing = { ...result.position_sizing, ...patch.position_sizing };
  }

  return result;
}
```

### Step 2-E: Create `src/components/DiagnosisSidebar.tsx`

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth";
import { mergeIrPatch, type StrategyIR } from "@/lib/irPatch";

interface Finding {
  id: string;
  finding: string;
  action_label: string;
  ir_patch: Partial<StrategyIR>;
  confidence: "high" | "medium" | "low";
}

interface Props {
  backtestRunId: string;
  strategyId: string;
  strategyIr: StrategyIR;
  pair: string;
  timeframe: string;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
}

export default function DiagnosisSidebar({
  backtestRunId,
  strategyId,
  strategyIr,
  pair,
  timeframe,
  periodStart,
  periodEnd,
  onClose,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);

  // Trigger diagnosis on mount
  useState(() => {
    fetchWithAuth("/api/diagnosis/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backtest_run_id: backtestRunId }),
    })
      .then((r) => { if (!r.ok) throw new Error("Diagnosis failed"); return r.json(); })
      .then((data) => setFindings(data.findings ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  });

  async function applyFix(finding: Finding) {
    setApplying(finding.id);
    try {
      const patchedIr = mergeIrPatch(strategyIr, finding.ir_patch);
      const name = `[Fix: ${finding.action_label}] ${pair} ${timeframe}`;
      const res = await fetchWithAuth("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir_json: patchedIr,
          description: name,
          pair,
          timeframe,
        }),
      });
      if (!res.ok) throw new Error("Failed to save strategy");
      const newStrategy = await res.json();
      const params = new URLSearchParams({
        strategy_id: newStrategy.id,
        pair,
        timeframe,
        period_start: periodStart,
        period_end: periodEnd,
      });
      router.push(`/backtest?${params.toString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply fix");
    } finally {
      setApplying(null);
    }
  }

  const visible = findings.filter((f) => !dismissed.has(f.id));
  const confidenceColour: Record<string, string> = {
    high:   "text-red-400 border-red-800 bg-red-900/20",
    medium: "text-yellow-400 border-yellow-800 bg-yellow-900/20",
    low:    "text-slate-400 border-slate-700 bg-slate-800",
  };

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-700 shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
        <p className="text-sm font-medium text-slate-200">Diagnose Strategy</p>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">✕</button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-3 space-y-3">
        {loading && (
          <div className="px-4 py-8 text-center space-y-2">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500">Analyzing backtest results...</p>
          </div>
        )}
        {error && !loading && (
          <p className="px-4 text-xs text-red-400">{error}</p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="px-4 text-xs text-slate-500">No significant issues detected.</p>
        )}
        {visible.map((f) => (
          <div key={f.id} className="rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2 mx-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-slate-200 leading-relaxed flex-1">{f.finding}</p>
              <span className={`shrink-0 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${confidenceColour[f.confidence]}`}>
                {f.confidence}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                onClick={() => applyFix(f)}
                disabled={applying === f.id}
                className="flex-1 rounded border border-blue-700 px-2 py-1 text-[11px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-50 transition-colors"
              >
                {applying === f.id ? "Saving..." : f.action_label}
              </button>
              <button
                onClick={() => setDismissed((prev) => new Set([...prev, f.id]))}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                Ignore
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Footer note */}
      {!loading && visible.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-700 shrink-0">
          <p className="text-[10px] text-slate-600">
            Applying a fix creates a new strategy variant. Your original is unchanged.
          </p>
        </div>
      )}
    </div>
  );
}
```

**Note on `useState` for side effects:** The pattern above uses a `useState` initialiser for the fetch — this is a simplified approach. In practice, replace with `useEffect(() => { ... }, [backtestRunId])` which is the correct React pattern for data fetching.

### Step 2-F: Wire into `backtest/page.tsx`

**Add state** inside `BacktestPageInner` (after existing state declarations ~line 108):
```ts
const [diagnosisOpen, setDiagnosisOpen] = useState(false);
```

**Add import** at top of file:
```ts
import DiagnosisSidebar from "@/components/DiagnosisSidebar";
```

**Add "Diagnose Strategy" button** in the result panel toolbar. Find where `selectedId` is used to render `BacktestResultPanel` — add a button in the toolbar above it:

```tsx
{selectedId && (
  <div className="flex items-center justify-between mb-2">
    <p className="text-xs text-gray-500 font-mono">{selectedId.slice(0, 8)}</p>
    <button
      onClick={() => setDiagnosisOpen(true)}
      className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
    >
      Diagnose Strategy
    </button>
  </div>
)}
```

**Render sidebar** at the bottom of the JSX (outside the main layout div, before the closing tag):

```tsx
{diagnosisOpen && selectedId && (() => {
  const run = history.find(r => r.id === selectedId);
  const strategy = run ? strategies.find(s => s.id === run.strategy_id) : null;
  if (!run || !strategy) return null;
  return (
    <DiagnosisSidebar
      backtestRunId={selectedId}
      strategyId={run.strategy_id}
      strategyIr={strategy.ir_json as StrategyIR}
      pair={run.pair}
      timeframe={run.timeframe}
      periodStart={run.period_start}
      periodEnd={run.period_end}
      onClose={() => setDiagnosisOpen(false)}
    />
  );
})()}
```

**Note:** `strategy.ir_json` is typed as `{ metadata?: ... }` in `backtest/page.tsx:16`. Cast it as `StrategyIR` from `@/lib/irPatch`. Also check that `RunSummary` includes `period_start` and `period_end` — it does (lines 31–32).

---

## Build order

| # | Step | Files touched | Can ship independently? |
|---|---|---|---|
| 1 | 1-A: `strategyLabels.ts` | new file only | Yes — pure lib |
| 2 | 1-B: Condition Cards in BacktestResultPanel | `BacktestResultPanel.tsx` | Yes after step 1 |
| 3 | 1-C: Reuse in Optimization page | `optimization/page.tsx` | Yes after step 1 |
| 4 | 3-A: `strategyHealth.ts` | new file only | Yes — pure lib |
| 5 | 3-B: Health Badges in BacktestResultPanel | `BacktestResultPanel.tsx` | Yes after step 4 |
| 6 | 2-A: `strategy_diagnosis.py` | new backend file | Yes — no routes yet |
| 7 | 2-B: `diagnosis.py` router | new backend file | After step 6 |
| 8 | 2-C: Register router in `main.py` | `main.py` | After step 7; restart fastapi |
| 9 | 2-D: `irPatch.ts` | new frontend file | Yes — pure lib |
| 10 | 2-E: `DiagnosisSidebar.tsx` | new component | After steps 8 + 9 |
| 11 | 2-F: Wire into `backtest/page.tsx` | `backtest/page.tsx` | After step 10 |

Steps 1–5 are entirely frontend and require no container restarts.  
Steps 6–8 require `docker compose restart fastapi` after step 8.  
Steps 9–11 are frontend again.

---

## Verification checklist

### Feature 1
- [ ] Story view default: entry conditions render as readable sentences, not chips
- [ ] JSON view toggle: original chip rendering is intact and unchanged
- [ ] All 8 indicator types render without throwing (RSI, EMA, SMA, MACD, BB, ATR, ADX, STOCH)
- [ ] Exit conditions render correctly in both ATR and fixed_pips formats
- [ ] Session and exclude_days filters render in story view
- [ ] Toggle state resets to "story" when a new result is selected

### Feature 3
- [ ] All 4 badges appear for a result that has win_rate, max_dd, trades with pnl
- [ ] Badges are omitted (not shown as "unknown") when a metric is null
- [ ] Positive / neutral / negative colours are correct per threshold
- [ ] Profit factor computed correctly: sum(winning pnl) / abs(sum(losing pnl))

### Feature 2
- [ ] `POST /api/diagnosis/strategy` returns 200 with 1–3 findings for a known run ID
- [ ] "Diagnose Strategy" button only appears when a result is selected
- [ ] Sidebar opens in loading state, then renders findings after 3–6 s
- [ ] "Apply" creates a new strategy with name pattern `[Fix: ...] PAIR TF`
- [ ] After apply, router navigates to `/backtest?strategy_id=<new_id>&...`
- [ ] Original strategy is NOT modified
- [ ] "Ignore" dismisses the card without affecting others
- [ ] Sidebar closes on ✕ and reopens cleanly (fresh fetch) when reopened
- [ ] `mergeIrPatch` test: applying `{"filters": {"exclude_days": ["monday"]}}` to a base with `exclude_days: ["friday"]` produces `["friday", "monday"]` (not replacement)

---

## Notes on `ir_json` typing in `backtest/page.tsx`

`Strategy.ir_json` at `backtest/page.tsx:16` is typed as:
```ts
ir_json: { metadata?: { name?: string; description?: string } };
```

This is too narrow for `DiagnosisSidebar` which needs the full `StrategyIR` shape. Before step 2-F, widen the interface or use a type assertion `strategy.ir_json as unknown as StrategyIR`. The safe approach is to widen the `Strategy` interface in `backtest/page.tsx` to use the imported `StrategyIR` type from `@/lib/irPatch`.
