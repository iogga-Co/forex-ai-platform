# Multi-Trade Analysis — Feature Specification

**Phase:** 3 Polish Sprint (after StrategyUXSpecs.md items)
**Date:** April 2026
**Replaces:** "Explain This Trade" per-row button from Frontend_Additions_Gemini.md

---

## Why the per-row "Why?" button was rejected

The original proposal — an AI "Why?" button on every trade row — has three fatal flaws:

1. **One click = one AI call.** A 300-trade backtest could generate 300 API calls. Slow (2–4 s per click) and expensive for zero marginal gain.
2. **A single row has no diagnostic context.** The AI would say "this trade entered because RSI crossed 50" — which is just restating the strategy rules the user already knows.
3. **The useful question is comparative.** Not "why did this trade enter?" but "why did this trade lose when 60% of identical setups won?" That requires comparing the trade against the population — impossible from one row.

This spec describes the correct version: **multi-trade pattern analysis** — the user selects a subset of trades, the backend pre-computes statistics on the selection vs the full population, and the AI explains the *pattern*, not the individual trade.

---

## Existing trade data

Trades are stored in the `trades` table with these fields (from `backend/data/db.py` and `backend/engine/metrics.py`):

```
id, backtest_run_id, entry_time, exit_time, direction,
entry_price, exit_price, pnl, r_multiple, mae, mfe, signal_context
```

The frontend `Trade` interface in `BacktestResultPanel.tsx`:
```ts
interface Trade {
  id: string;
  entry_time: string;   // ISO string
  exit_time: string;    // ISO string
  direction: "long" | "short";
  entry_price: number;
  exit_price: number;
  pnl: number;
  r_multiple: number;
  mae: number;
  mfe: number;
}
```

All four phases below build on this existing data — no new fields required in the DB.

---

## Phase A — Multi-row selection in the trade table

**Type:** Frontend only. No backend changes. No AI.

### What changes

The Master Trade Table in `BacktestResultPanel.tsx` gains a checkbox column enabling multi-row selection, following the same pattern already used for batch delete in `strategies/page.tsx`.

### State

```ts
const [checkedTradeIds, setCheckedTradeIds] = useState<Set<string>>(new Set());
```

Separate from any existing highlighted/selected row state.

### Checkbox column

- First column, 28px wide, `<input type="checkbox">` per row
- Header checkbox: select-all / deselect-all; uses `ref` callback to set `indeterminate` when partial selection
- Checked row tint: `border-blue-800 bg-blue-900/10` (same as batch delete pattern)

### Quick-select presets (toolbar dropdown)

A "Select" dropdown appears in the trade table toolbar:

| Preset | Logic |
|---|---|
| All losing trades | `trade.pnl < 0` |
| All winning trades | `trade.pnl > 0` |
| All long trades | `trade.direction === "long"` |
| All short trades | `trade.direction === "short"` |
| Outlier losses (> 2× avg loss) | `trade.pnl < avgLoss * 2` — see Phase D |
| Clear selection | deselect all |

### Toolbar button

When `checkedTradeIds.size >= 2` a button appears in the trade table toolbar:

```tsx
"Analyze {n} trades"
// styling: same as standard action button
"rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
```

Clicking this button triggers Phase C (AI analysis). It is disabled and greyed out when fewer than 2 trades are selected.

### Files changed

- `src/components/BacktestResultPanel.tsx` — add checkbox column, preset dropdown, "Analyze N trades" button

---

## Phase B — Statistical pre-computation (backend, no AI)

**Type:** Backend only. No AI. Runs before the AI call in Phase C.

### Purpose

Before sending anything to Claude, compute the context that makes analysis meaningful. Structured stats are cheaper than raw rows (fewer tokens) and produce better AI output.

### Endpoint

```
POST /api/diagnosis/trades/stats
Authorization: Bearer <jwt>
```

Request:
```json
{
  "backtest_run_id": "uuid",
  "trade_ids": ["id1", "id2", "..."]
}
```

### Computation (pure SQL/Python — no AI)

The endpoint fetches two populations from the `trades` table:

- **Selection:** trades matching `trade_ids`
- **Population:** all trades for `backtest_run_id`

Then computes:

```python
# Selection stats
sel_count         = len(selection)
sel_winners       = count where pnl > 0
sel_losers        = count where pnl < 0
sel_win_rate      = sel_winners / sel_count
sel_avg_pnl       = mean(pnl)
sel_avg_loss      = mean(pnl where pnl < 0)   # negative number
sel_avg_r         = mean(r_multiple)
sel_avg_duration  = mean(exit_time - entry_time) in minutes
sel_avg_mae       = mean(mae)
sel_avg_mfe       = mean(mfe)

# Direction breakdown
sel_long_count    = count where direction == 'long'
sel_short_count   = count where direction == 'short'
sel_long_win_rate = winners among longs / long_count
sel_short_win_rate= winners among shorts / short_count

# Time-of-day breakdown (UTC hour buckets)
sel_by_hour = { hour: {count, win_rate} for hour in 0..23 }
# Day-of-week breakdown
sel_by_dow  = { day: {count, win_rate} for day in Mon..Sun }

# Population stats (for comparison)
pop_win_rate      = population win rate
pop_avg_pnl       = population mean pnl
pop_avg_loss      = population mean loss
pop_avg_r         = population mean r_multiple
pop_avg_duration  = population mean duration (minutes)
pop_atr_at_entry  = mean ATR value at entry (from signal_context if available, else null)
```

### Response

```json
{
  "selection": {
    "count": 14,
    "win_rate": 0.14,
    "avg_pnl": -28.4,
    "avg_loss": -32.1,
    "avg_r": -1.8,
    "avg_duration_min": 187,
    "avg_mae": -0.0042,
    "avg_mfe": 0.0018,
    "long_count": 14,
    "short_count": 0,
    "long_win_rate": 0.14,
    "short_win_rate": null,
    "by_hour": { "13": {"count": 9, "win_rate": 0.11}, "14": {"count": 5, "win_rate": 0.20} },
    "by_dow":  { "tuesday": {"count": 6, "win_rate": 0.17}, "wednesday": {"count": 5, "win_rate": 0.0} }
  },
  "population": {
    "count": 312,
    "win_rate": 0.54,
    "avg_pnl": 8.2,
    "avg_loss": -15.3,
    "avg_r": 0.42,
    "avg_duration_min": 134
  }
}
```

### File

- `backend/routers/diagnosis.py` — add `POST /api/diagnosis/trades/stats`

---

## Phase C — AI pattern analysis

**Type:** Backend (AI call) + Frontend (sidebar). Requires Phase A and B.

### Flow

1. User selects trades in Phase A, clicks "Analyze N trades"
2. Frontend calls `POST /api/diagnosis/trades/stats` (Phase B) to get structured stats
3. Frontend immediately opens `TradeAnalysisSidebar` in loading state
4. Frontend calls `POST /api/diagnosis/trades/analyze` with the stats payload
5. Sidebar renders AI response when it arrives (typically 3–6 s)

### Backend endpoint

```
POST /api/diagnosis/trades/analyze
Authorization: Bearer <jwt>
```

Request:
```json
{
  "backtest_run_id": "uuid",
  "trade_ids": ["id1", "id2", "..."],
  "stats": { ...Phase B response... }
}
```

### AI prompt (built in `backend/ai/trade_analysis.py`)

```
You are analyzing a trader-selected subset of trades from a forex backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {tf}
Full backtest: {pop_count} trades | Win rate: {pop_win_rate}% | Avg P&L: {pop_avg_pnl}

Selected subset: {sel_count} trades | Win rate: {sel_win_rate}% | Avg P&L: {sel_avg_pnl}
Selection win rate vs population: {delta_win_rate:+.1f}%
Selection avg loss vs population avg loss: {sel_avg_loss} vs {pop_avg_loss}

Direction breakdown:
  Longs:  {sel_long_count} trades, {sel_long_win_rate}% win rate
  Shorts: {sel_short_count} trades, {sel_short_win_rate}% win rate

Time-of-day (UTC): {top 3 hours by count with win rates}
Day-of-week: {top 3 days by count with win rates}

Avg trade duration: {sel_avg_duration} min vs population {pop_avg_duration} min
Avg MAE: {sel_avg_mae} | Avg MFE: {sel_avg_mfe}

Identify the 2–4 strongest patterns that distinguish this selection from the full population.
For each pattern, state: what it is, how strong the signal is, and what the trader should do.
Reply in the JSON format specified.
```

### AI response format

Claude must reply in strict JSON (parsed by backend before returning to frontend):

```json
{
  "headline": "1-sentence plain-English summary of the dominant pattern",
  "patterns": [
    {
      "label": "Time of day",
      "finding": "79% of selected trades entered during 13:00–15:00 UTC (NY open). Population win rate at this hour: 41% vs overall 54%.",
      "strength": "strong",
      "recommendation": "Consider excluding entries in the first hour of the NY session."
    },
    {
      "label": "Direction bias",
      "finding": "All 14 selected trades are longs. Short trades in the same period have a 61% win rate.",
      "strength": "moderate",
      "recommendation": "Review whether long entries have a structural disadvantage on this pair during this session."
    }
  ],
  "verdict": "structural",
  "recommendation": "The losses are not random — they cluster around NY open long entries. This is a structural edge issue, not a statistical outlier."
}
```

`strength` values: `"strong"` | `"moderate"` | `"weak"`
`verdict` values: `"outlier"` | `"edge_decay"` | `"structural"` | `"inconclusive"`

Verdict definitions (same as ForexNewsSpecs.md period diagnosis):
- `outlier` — selection is statistically consistent with normal variance; no action needed
- `edge_decay` — selection shows the edge is weakening over time
- `structural` — a specific, identifiable condition is causing the losses
- `inconclusive` — insufficient data or no clear pattern

### Backend file

- `backend/ai/trade_analysis.py` — new, prompt builder + Claude call (`claude-sonnet-4-6`)
- `backend/routers/diagnosis.py` — add `POST /api/diagnosis/trades/analyze`

### Frontend — `TradeAnalysisSidebar`

New component: `src/components/TradeAnalysisSidebar.tsx`

```tsx
// Sidebar container (same dimensions as DiagnosisSidebar from StrategyUXSpecs.md)
"fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-700 shadow-xl z-50 flex flex-col"

// Header
"px-4 py-3 border-b border-slate-700 flex items-center justify-between"
// Title: "Trade Pattern Analysis · {n} trades"
// Close button: X icon

// Loading state
// Spinner + "Analyzing {n} trades..."

// Headline (top of results)
"px-4 py-3 text-sm text-slate-200 leading-relaxed border-b border-slate-700"

// Pattern card
"rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-1.5 mx-4 my-2"

// Pattern label
"text-[10px] uppercase tracking-widest text-slate-400"

// Finding text
"text-xs text-slate-200 leading-relaxed"

// Recommendation text
"text-xs text-blue-400 leading-relaxed"

// Strength badge
// strong:   "text-red-400 border-red-800 bg-red-900/20"
// moderate: "text-yellow-400 border-yellow-800 bg-yellow-900/20"
// weak:     "text-slate-400 border-slate-700 bg-slate-800"

// Verdict badge (bottom) — same colour logic as DiagnosisSidebar
// structural: orange · edge_decay: red · outlier: blue · inconclusive: grey
```

### Reuse with DiagnosisSidebar

Both `TradeAnalysisSidebar` (this spec) and `DiagnosisSidebar` (StrategyUXSpecs.md) render:
- Pattern cards with label / finding / recommendation
- Verdict badge
- Recommendation footer

Extract shared rendering into `src/components/DiagnosisPatternCard.tsx` to avoid duplication.

---

## Phase D — Passive outlier flags

**Type:** Frontend only. No backend changes. No AI. Can ship independently of Phases B and C.

### Purpose

Give users a signal for which trades *are worth* selecting for Phase C, without requiring them to know what to look for.

### Logic

On trade table render, compute client-side:

```ts
const avgLoss = mean(trades.filter(t => t.pnl < 0).map(t => t.pnl));  // negative
const stdDevLoss = stdDev(same array);
const outlierThreshold = avgLoss - 2 * stdDevLoss;  // 2σ below mean loss

// A trade is an outlier if its loss exceeds 2σ from the mean loss
const isOutlier = (t: Trade) => t.pnl < outlierThreshold;
```

### Display

- `⚠` icon in the trade row (leftmost data column, before direction)
- Icon colour: `text-yellow-500`
- Tooltip on hover: `"Loss is {X}× larger than the average loss — worth investigating"`
- No AI call, no click required — purely passive

### Quick-select integration

The "Outlier losses" preset in Phase A's toolbar dropdown uses the same `isOutlier()` function to pre-populate `checkedTradeIds`.

### File

- `src/components/BacktestResultPanel.tsx` — add outlier computation and icon rendering

---

## Build order

| Order | Phase | Depends on | Value without later phases |
|---|---|---|---|
| 1 | D — Outlier flags | Nothing | Standalone — flags interesting trades passively |
| 2 | A — Multi-row selection | Nothing | Standalone — enables manual subset selection |
| 3 | B — Stats pre-computation | A | Standalone — stats response useful for display even without AI |
| 4 | C — AI analysis | A + B | Full feature |

Phases D and A can ship in the same PR. Phase B in a second PR. Phase C in a third.

---

## Backend endpoints summary

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/diagnosis/trades/stats` | Pre-compute selection vs population stats (no AI) |
| `POST` | `/api/diagnosis/trades/analyze` | AI pattern analysis using pre-computed stats |

Both endpoints live in `backend/routers/diagnosis.py`.  
Prompt builder lives in `backend/ai/trade_analysis.py`.

---

## Frontend files summary

| File | Change |
|---|---|
| `src/components/BacktestResultPanel.tsx` | Checkbox column, preset dropdown, "Analyze N" button, outlier flags |
| `src/components/TradeAnalysisSidebar.tsx` | New — AI results sidebar |
| `src/components/DiagnosisPatternCard.tsx` | New — shared pattern card, reused by TradeAnalysisSidebar and DiagnosisSidebar |

---

## Out of scope

- Per-row "Why?" button — rejected, see rationale at top of this document
- Analysis across multiple backtest runs (single run only in v1)
- Automatic trade selection based on AI suggestion (user always selects manually or via preset)
- Chart highlighting of selected trades on the equity curve (possible future addition)
