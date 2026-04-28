# Frontend Conventions

**Working dir for frontend sessions:** `C:\Projects\forex-ai-platform\frontend`

## fetchWithAuth

All API calls use `fetchWithAuth` from `@/lib/auth` — automatically attaches the JWT Bearer token. **Never** use raw `fetch()` for authenticated endpoints.

Exception: SSE endpoints use raw `fetch()` with `?token=getAccessToken()` (SSE needs query-param auth, not headers).

---

## Button styles (toolbar buttons)

```tsx
// Standard action button
"rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"

// Disabled state for <Link> (can't use disabled prop)
"opacity-30 pointer-events-none"

// Delete/trash button
"rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
// Trash icon: h-3 w-3
```

---

## URL params — passing context between pages

| Page | Accepted params |
|---|---|
| `/backtest` | `strategy_id`, `pair`, `timeframe`, `period_start`, `period_end` |
| `/optimization` | `strategy_id`, `pair`, `timeframe`, `period_start`, `period_end` |
| `/copilot` | `strategy_id`, `pair`, `timeframe`, `backtest_id` |
| `/superchart` | `strategy_id`, `backtest_id` |
| `/lab` | `pair`, `timeframe` |

---

## useSearchParams — requires Suspense

Any page component using `useSearchParams()` must be wrapped in `<Suspense>`. Pattern:

```tsx
export default function Page() {
  return <Suspense><PageInner /></Suspense>;
}
function PageInner() {
  const searchParams = useSearchParams();
  // ...
}
```

Without this, Next.js static prerendering crashes at build/lint time.

---

## RunSummary interface

The `RunSummary` type in both `backtest/page.tsx` and `strategies/page.tsx` must include `strategy_id: string`. The API (`GET /api/backtest/results`) returns this field. Needed by toolbar buttons (Superchart, Optimize, Refine links) to construct correct URLs. Do not omit it.

---

## BacktestResultPanel (`src/components/BacktestResultPanel.tsx`)

- Compact horizontal Entry/Exit rows — entry conditions in left column, exit (SL/TP) in right column
- Auto-column grid within each row: 1 col (≤2 conditions), 2 col (3–4), 3 col (5+)
- Filters + position sizing rendered as compact chips below Entry/Exit rows
- No pair/timeframe/version header — that info lives in the toolbar above
- Trade table has a checkbox column — `checkedTradeIds: Set<string>` state
- Select-all checkbox uses `ref` callback for `indeterminate` state
- Row click toggles selection; checked rows get `border-blue-800 bg-blue-900/10` tint
- Outlier detection: trades with loss > 2σ below mean loss get a ⚠ icon + tooltip
- "Analyze N trades" button (disabled when `< 2` selected) opens `TradeAnalysisSidebar`
- `toggleTrade(id)` uses `if/else` not ternary (ternary unused-expression is a lint error)

Do not add Optimize/Refine/View IR navigation buttons to this component — those live in the toolbar above each list.

---

## TradeAnalysisSidebar (`src/components/TradeAnalysisSidebar.tsx`)

Props: `backtestRunId`, `tradeIds`, `onClose`

Two-step fetch on mount — both requests include `model: loadSettings().ai_model` in the body:
1. POST `/api/diagnosis/trades/stats` → show selection vs population stats table
2. POST `/api/diagnosis/trades/analyze` → show AI patterns + verdict

Strength badge colours: `strong` = red, `moderate` = yellow, `weak` = slate
Verdict badge colours: `structural` = orange, `edge_decay` = red, `outlier` = blue, `inconclusive` = slate

---

## strategyLabels utility (`src/lib/strategyLabels.ts`)

- `conditionToLabel(c)` — human-readable entry condition string; numeric `value` fields run through `fv()` (rounds to 1 decimal, strips trailing `.0` — prevents `19.900000000000013`)
- `exitConditionToLabel(ec)` — formats SL/TP as `ATR(14) × 1.5`, `50 pips`, or `2%`
- `filterToLabels(filters)` — compact filter/sizing chip array

Used by the Co-Pilot Story panel and anywhere SIR needs to be rendered as readable text.

---

## strategyHealth utility (`src/lib/strategyHealth.ts`)

Computes health badge ratings (Sharpe / Win Rate / Max DD) from a backtest run. Used in the Strategies tab to show colour-coded badges (green/yellow/red) on each strategy card.

---

## DiagnosisSidebar (`src/components/DiagnosisSidebar.tsx`)

Single-strategy AI diagnosis panel. Opened via the "Diagnose" button in the Strategies tab toolbar. POSTs to `POST /api/diagnosis/strategy` and renders up to 3 structured fix suggestions with `ir_patch` objects.

---

## Co-Pilot IR panel (`copilot/page.tsx`)

- **Story panel** — entry condition cards, exit condition cards, filter/sizing row (uses `strategyLabels`)
- **Action buttons** — Backtest, Optimize, Superchart (no Refine button)
  - Buttons are greyed (`opacity-30 pointer-events-none`) until strategy is saved
  - "Save to enable" hint shown when `!savedId`
  - Backtest/Optimize links include `?strategy_id=&pair=&timeframe=` params

---

## Superchart toolbar

Backtest / Optimize / Refine buttons live in the **top toolbar** (`ml-auto` div), not the bottom-right corner. Use standard `border-blue-700` button style with `disabled:opacity-30 disabled:cursor-not-allowed`.

---

## Global CSS density overrides

`src/app/globals.css` compresses padding in **compact mode** (default). Scoped to `:root:not(.spacious)` — do not remove, this is intentional:

```css
:root:not(.spacious) .px-4 { padding-left: 0.5rem; padding-right: 0.5rem; }
:root:not(.spacious) .px-3 { padding-left: 0.5rem; padding-right: 0.5rem; }
:root:not(.spacious) .py-3 { padding-top:  0.5rem; padding-bottom: 0.5rem; }
:root:not(.spacious) .px-6 { padding-left: 0.5rem; padding-right: 0.5rem; }
:root:not(.spacious) .pl-6 { padding-left: 0.5rem; }
:root:not(.spacious) .py-2 { padding-top:  0.5rem; padding-bottom: 0.5rem; }
```

`DensityProvider` (client component in layout) reads `settings.ui_density` from localStorage and toggles `:root.spacious` on `<html>`. Default: `"compact"`.

---

## Full-viewport page wrapper (`-m-1`)

`<main>` in `layout.tsx` has `p-1`. Pages that need to fill the viewport edge-to-edge cancel it with `-m-1`:

```tsx
<div className="flex h-full overflow-hidden -m-1">
```

Currently used by: `strategies/page.tsx`, `copilot/page.tsx`. If global padding ever changes, update all `-m-N` wrappers to match.

---

## localStorage keys

- `copilot_system_prompt` — persisted system prompt in Co-Pilot tab
- `superchart_state` — full Superchart state: pair, timeframe, date range, `activeOsc`, `oscParams`, `chartOverlays`, `selectedStratId`, `selectedBtId`, `savedSIRs`
  - `savedSIRs: Record<strategyId, StrategyIR>` — user-edited entry conditions per strategy; cleared when user resets. URL params take priority on mount.
  - `oscParams` are **never** overwritten by strategy load — fully user-controlled.
- `backtest_state` — Backtest page form + `savedIRs: Record<strategyId, IR>`. URL params take priority.
- `opt_form` — Optimization page form fields. URL params take priority.
- `opt_saved_irs` — Optimization page `editedIr` per strategy. Same pattern as `savedSIRs`.
- `lab_state` — Indicator Lab builder: pair, timeframe, dates, indicators, conditions.
- Settings keys managed via `@/lib/settings`.

---

## Page persistence pattern (Superchart · Backtest · Optimization)

All three pages persist editable indicator parameters so they survive navigation and logout. Only the Reset button returns to defaults.

**oscParams:** saved to `superchart_state.oscParams` on every spinbox change. The SIR→oscParams auto-sync that previously overwrote saved values on every strategy load has been removed — oscParams are now exclusively user-controlled.

**editedIr:** saved per `strategyId` to `savedSIRs` / `savedIRs` / `opt_saved_irs`. On strategy load the saved IR takes priority over `ir_json`. Setting `irDirty = false` (inline "reset" link or Reset button) triggers the persist effect to remove the saved IR for that strategy, cleanly falling back to `ir_json` on next load.

---

## Batch delete pattern (checkboxes)

Used in Backtest tab history list and Strategies tab:
- `checkedIds: Set<string>` state — separate from the highlighted row (`selectedId`)
- Select-all checkbox uses `ref` callback to set `indeterminate` when partial
- **Checkbox position:** placed AFTER the trash icon in the toolbar, not at the front
- Trash button: if `checkedIds.size > 0` → delete all checked; else fall back to single highlighted item
- Count badge shown on trash icon when `checkedIds.size > 1`
- Strategy delete has a confirm/cancel flow; backtest delete is immediate
- Checked rows: `border-blue-800 bg-blue-900/10` tint (distinct from highlighted `bg-blue-900/20`)

---

## Sortable lists

Strategies tab uses `sortStrategies()` / `sortBacktests()` helpers (defined at top of `strategies/page.tsx`). Sort key + direction stored as state; clicking active key toggles direction; clicking new key sets to default direction. Sort bar renders below the toolbar, not in the header row.

---

## Toast notifications

`sonner` is installed. `<Toaster theme="dark" position="bottom-right" richColors />` in `layout.tsx`. Fire toasts:

```ts
import { toast } from "sonner"
toast.success("msg") / toast.error("msg")
```

Applied to optimization `complete` SSE event and any background task completions.

---

## Indicator Lab — frontend patterns

### `indicator_id` URL param

`/superchart?indicator_id={id}` pre-loads a saved indicator as a dotted overlay when Superchart opens. Constructed by the "SC" button in the Lab Library panel. The Superchart fetches `GET /api/lab/indicators/saved`, finds the matching entry, calls `POST /api/lab/indicators` with its config + current pair/TF/dates, and renders the series as dotted lines.

### Indicator date range clamping

`POST /api/lab/indicators` is called with the actual last candle's date as `to`, not the user's `dateTo` field. The candles API has `limit=5000`; for 1H over a full year that cuts data ~mid-year. Without clamping, indicator series extend past visible candles. The `actualTo()` helper in `lab/page.tsx` derives the end date from `candles[candles.length - 1].time`.

### `activeOsc` auto-selection

`uniqueOscTypes` is derived from `indicators` (only oscillator-type indicators in the builder). `activeOsc` defaults to `"RSI"` on mount. A `useEffect` on `indicators` auto-sets `activeOsc` to `uniqueOscTypes[0]` whenever `activeOsc` is not present in the builder — prevents blank sub-chart when user adds MACD (or any non-RSI oscillator) first.

### AI right panel layout

The Lab has three columns: Left panel (w-52, Builder/Library tabs) | Chart (flex-1) | AI right panel (w-64).

**AI right panel sections (top → bottom):**
1. **Header** — "AI Indicator IR" title + chevron toggle + "Apply" button (appears once AI has suggested a config)
2. **IR section** — collapsible (`irCollapsed`) + drag-resizable (`irHeight`, 40–600px). Uses smooth `transition-[height]`.
3. **Drag handle** — `cursor-row-resize`, turns blue on hover.
4. **Chat label** + scrollable message history — user messages right-tinted blue, assistant messages grey.
5. **2-row textarea** — `Enter` sends, `Shift+Enter` newlines; `resize-none`.
6. **Save section** — name input (placeholder = `aiSuggestedName`), draft/complete radio, "Save as Indicator", "Export as Strategy →".

**Save/Export logic:** `saveIndicator()` and `exportStrategy()` check `aiIR` first — if present, use the AI-generated IR; otherwise fall back to builder `indicators`/`conditions` state. The Save section was moved from the left panel into the AI panel.

**`aiSuggestedName`:** `[Lab] {types joined by +} {pair} {timeframe}` derived from `aiIR.indicators` if available, else `suggestedName` from builder.

---

## Spinbox float rounding (`src/components/Spinbox.tsx`)

When `float=true`, derives decimal places from `step` and rounds everywhere:

```typescript
const decimals = float ? (step.toString().split(".")[1]?.length ?? 0) : 0;
const round = (n: number) => float ? parseFloat(n.toFixed(decimals)) : Math.round(n);
```

Applied to `displayValue`, `increment()`, `decrement()`, and typed input `onChange`. Prevents `0.7999...` showing instead of `0.8` when `step=0.1`.

---

## Frontend testing

`vitest` is set up for pure utility functions. Config: `frontend/vitest.config.ts`. Test files: `frontend/src/__tests__/`. Run: `npm test` inside the nextjs container or locally. Currently covers `strategyLabels.ts` (24 tests). Do not use Jest — vitest is already configured.
