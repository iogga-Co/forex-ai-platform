# Strategy UX Enhancements — Specification

**Phase:** 3 Polish Sprint (before Phase 4 Live Trading)  
**Date:** April 2026  
**Source:** Frontend_Additions_Gemini.md — items 1, 3, 4

---

## Overview

Three UX improvements to make strategy analysis more accessible without reducing analytical depth. All three are additive — they layer on top of existing components and do not replace raw data views.

---

## 1. Visual Strategy Story (Condition Cards)

### User story
As a trader reviewing a strategy, I want to read my entry and exit logic as plain English sentences rather than JSON fields, so I can validate the strategy intent at a glance without parsing code.

### Current state
`BacktestResultPanel.tsx` renders `ir_json` as `key=value` chips. Readable for a technical user, opaque for anyone else.

### Target state
Each entry condition renders as a **Condition Card** — a compact pill with a natural-language label derived from the IR fields.

### Condition Card format

| IR field combination | Rendered label |
|---|---|
| `indicator: RSI, operator: >, value: 50` | "RSI (14) above 50 — momentum positive" |
| `indicator: EMA, operator: price_above` | "Price above EMA (20)" |
| `indicator: MACD, operator: cross_above` | "MACD crosses above signal" |
| `indicator: BB, operator: price_below` | "Price below lower Bollinger Band (20, 2σ)" |
| `indicator: ADX, operator: >, value: 25` | "ADX (14) above 25 — trend strong" |
| `indicator: STOCH, operator: <, value: 20` | "Stochastic (K) below 20 — oversold" |
| Exit: `stop_loss, type: atr` | "Stop Loss: ATR (14) × 1.5" |
| Exit: `take_profit, type: atr` | "Take Profit: ATR (14) × 3.0" |
| Exit: `stop_loss, type: pips` | "Stop Loss: 50 pips" |
| Filter: `session: london` | "London session only" |
| Filter: `exclude_days: [monday]` | "Excludes Monday" |

### Implementation

- Add a `conditionToLabel(condition: EntryCondition): string` helper in `src/lib/strategyLabels.ts`
- Update `BacktestResultPanel.tsx` to render Condition Cards alongside (or replacing) the current chips — toggled by a "Story / JSON" toggle switch at the top of the IR section
- Default view: Story (cards); JSON view remains accessible for technical users
- Cards use the same grid layout as current chips (1/2/3 col based on condition count)

### Card styling
```tsx
// Condition card
"rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 leading-snug"

// Section label above card group
"text-[10px] uppercase tracking-widest text-slate-500 mb-1"

// Toggle (Story | JSON)
// Active tab: text-blue-400 border-b border-blue-500
// Inactive tab: text-slate-500 hover:text-slate-300
```

### Scope
- `BacktestResultPanel.tsx` — primary location
- Reuse the same `conditionToLabel` helper anywhere the IR is displayed (Optimization iterations panel, Superchart strategy info)

---

## 2. AI-Suggested Improvements (Diagnose Strategy)

### User story
As a trader reviewing a backtest with poor results, I want the AI to proactively identify the top 3 weaknesses and offer concrete one-click fixes, so I don't need to know which parameter to change — just whether to accept the suggestion.

### UX flow
1. On the Backtest results page, a **"Diagnose Strategy"** button appears in the toolbar after a run completes.
2. Clicking it calls `POST /api/diagnosis/strategy` with the `backtest_run_id`.
3. A **Diagnosis Sidebar** slides in from the right, showing a loading state while the AI processes.
4. The sidebar renders up to 3 **Fix Cards**, each with:
   - A plain-English finding ("70% of losses occur on Mondays")
   - A one-click action button ("Apply Monday Filter")
   - An "Ignore" dismiss button
5. Clicking "Apply" sends the suggested SIR patch to `POST /api/strategies` (creates a new strategy variant), then navigates to Backtest with the new strategy pre-filled.
6. The sidebar can remain open during navigation (persists in layout, not a modal).

### Fix Card examples

| Finding | One-Click Action | SIR change |
|---|---|---|
| "70% of losses occur on Mondays" | Apply Monday Filter | Add `monday` to `filters.exclude_days` |
| "Stop Loss too tight — 60% of trades stopped out before moving in your favour" | Increase ATR multiplier to 2.0 | Set `exit_conditions.stop_loss.multiplier = 2.0` |
| "Strategy performs 2× better during London session (08:00–16:00 UTC)" | Apply London Session Filter | Set `filters.session = "london"` |
| "RSI threshold of 50 produces too many false entries — most winners entered above 55" | Raise RSI threshold to 55 | Set matching entry condition `value = 55` |
| "Consecutive losses spike on high-volatility days (ATR > 1.5× average)" | Add ATR volatility filter | Add ATR filter condition to entry |

### Backend — `POST /api/diagnosis/strategy`

Request:
```json
{ "backtest_run_id": "uuid" }
```

The endpoint:
1. Fetches run metrics + all trades for the run
2. Computes: day-of-week loss breakdown, stop-out rate, session P&L split, win-rate by direction
3. Builds a structured prompt with these pre-computed stats (reduces AI token load)
4. Calls Claude (`claude-sonnet-4-6`) requesting exactly 3 findings in structured JSON
5. Returns:

```json
{
  "findings": [
    {
      "id": "monday_filter",
      "finding": "70% of losses occur on Mondays (12 of 17 losing trades).",
      "action_label": "Apply Monday Filter",
      "ir_patch": { "filters": { "exclude_days": ["monday"] } },
      "confidence": "high"
    }
  ]
}
```

`ir_patch` is a partial SIR object — merged with the current strategy's `ir_json` on the frontend before POSTing as a new strategy.

### Frontend — new files / changes

| File | Change |
|---|---|
| `src/components/DiagnosisSidebar.tsx` | New — slide-in panel, fix cards, apply/ignore actions |
| `src/app/backtest/page.tsx` | Add "Diagnose Strategy" button to toolbar; wire sidebar open/close |
| `src/lib/irPatch.ts` | New — `mergeIrPatch(base: StrategyIR, patch: Partial<StrategyIR>): StrategyIR` helper |

### Sidebar styling
```tsx
// Sidebar container
"fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-700 shadow-xl z-50 flex flex-col"

// Fix card
"rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2"

// Finding text
"text-xs text-slate-200 leading-relaxed"

// Apply button
"w-full rounded border border-blue-700 px-2 py-1 text-[11px] text-blue-400 hover:bg-blue-900/30 transition-colors"

// Ignore button
"text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
```

---

## 3. Strategy Health Badges

### User story
As a trader reviewing backtest results, I want a colour-coded at-a-glance health summary at the top of the results panel, so I can form an immediate impression of the strategy's quality before reading the detailed metrics.

### Badges

Four badges, derived from existing backtest metrics:

| Badge | Label | Metric basis | Thresholds |
|---|---|---|---|
| **Consistency** | High / Medium / Low | Win rate | High ≥ 55% · Medium 45–55% · Low < 45% |
| **Risk Level** | Low / Medium / High | Max drawdown % | Low < 5% · Medium 5–15% · High > 15% |
| **Recovery Speed** | Fast / Moderate / Slow | Avg trade duration (winners vs losers ratio) | Fast < 1.5× · Moderate 1.5–3× · Slow > 3× |
| **Edge Quality** | Strong / Moderate / Weak | Profit factor | Strong > 1.8 · Moderate 1.2–1.8 · Weak < 1.2 |

### Colour mapping

| Rating | Text colour | Border / bg |
|---|---|---|
| Positive (High / Low risk / Fast / Strong) | `text-emerald-400` | `border-emerald-800 bg-emerald-900/20` |
| Neutral (Medium / Moderate) | `text-yellow-400` | `border-yellow-800 bg-yellow-900/20` |
| Negative (Low / High risk / Slow / Weak) | `text-red-400` | `border-red-800 bg-red-900/20` |

### Implementation

- Add `src/lib/strategyHealth.ts` — `computeHealthBadges(metrics: RunSummary): HealthBadge[]`
- Render badge strip at the top of `BacktestResultPanel.tsx`, above the metrics grid
- Badges are display-only — no interaction, no tooltips needed in v1
- If any required metric is null/missing, that badge is omitted (not shown as unknown)

### Badge component
```tsx
// Badge pill
"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"

// Label (e.g. "Consistency")
"text-slate-400"

// Value (e.g. "High")
// colour from mapping above
```

---

## Shared concerns

### No AI calls on page load
Features 1 and 3 are purely derived from existing data — no AI calls, no latency on render.  
Feature 2 (Diagnose Strategy) is AI-powered but **only fires on explicit user action** — never proactively on page load.

### New strategy variants, not mutations
When a one-click fix is applied (Feature 2), it always creates a **new strategy** via `POST /api/strategies`. The original strategy is never modified. The generated name follows the existing pattern: `[Fix: Monday Filter] EURUSD 1H`.

### Backend file summary

| File | Change |
|---|---|
| `backend/routers/diagnosis.py` | Add `POST /api/diagnosis/strategy` (separate from period diagnosis in ForexNewsSpecs) |
| `backend/ai/strategy_diagnosis.py` | New — prompt builder + Claude call for strategy-level diagnosis |

---

## Out of scope

- "Explain This Trade" per-row AI button (expensive, low signal — excluded deliberately)
- Automated application of fixes without user approval
- Health badge tooltips explaining the metric in v1 (can add later)
- Diagnosis for optimization iterations (backtest results only in v1)
