# Indicator Lab — Feature Spec

**Status:** Planned  
**Phase:** 3.5 (between Phase 3 Analytics and Phase 4 Live Trading)  
**Complexity:** Medium-high — Optimization tab scope + indicator persistence + Superchart integration  
**Depends on:** Existing indicator engine, Superchart chart primitives, model_router

---

## Purpose

A visual sandbox where a trader can freely compose indicator combinations on historical candles,
see entry/exit signals overlaid on the chart, and ask Claude to analyse what it sees and suggest
improvements.

Two distinct outputs:

| Output | What it creates | Where it goes |
|---|---|---|
| **Save as Indicator** | A named, reusable indicator config (draft or completed) | Saved to DB; can be overlaid on Superchart |
| **Export as Strategy** | A full SIR config with entry conditions | Saved as a strategy; opens in Backtester |

A saved Indicator is NOT a strategy. It has no entry/exit logic, no PnL, no position sizing.
It is a named composition of indicator series that can be applied to any chart.

A saved Strategy IS a full SIR — it includes the signal conditions the trader built in the Lab,
and goes through the Backtester like any other strategy.

---

## Navigation

Add **"Indicator Lab"** to the sidebar `NAV_ITEMS` between "Superchart" and "Live":

```
Dashboard
Strategies
Backtest
Optimization
Co-Pilot
Superchart
→ Indicator Lab   ← new
Live
ForEx News
Settings
```

Route: `/lab`

---

## UI Layout

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Sidebar │                         Indicator Lab                                  │
│         │                                                                        │
│         │  [Pair ▾] [TF ▾] [From ──── To ────] [Load]                          │
│         │  ───────────────────────────────────────────────────────────────────  │
│         │                                                                        │
│         │  ┌──────────────┐  ┌─────────────────────────┐  ┌───────────────────┐│
│         │  │  Indicator   │  │  Chart (flex-1)          │  │  AI Panel (w-64)  ││
│         │  │  Library     │  │                          │  │                   ││
│         │  │  (w-48)      │  │  Candlestick +           │  │  [Analyse Chart]  ││
│         │  │              │  │  overlay series +        │  │                   ││
│         │  │  My Indicators│  │  signal markers         │  │  Claude SSE       ││
│         │  │  ──────────  │  │                          │  │  stream           ││
│         │  │  ● EMA Trend │  │  ─────────────────────  │  │                   ││
│         │  │  ○ RSI Setup │  │  Oscillator pane 1       │  │  Suggestion cards ││
│         │  │  ○ MACD...   │  │                          │  │  with [Apply]     ││
│         │  │              │  │  ─────────────────────  │  │                   ││
│         │  │  [+ New]     │  │  Oscillator pane 2       │  │                   ││
│         │  │              │  │                          │  │                   ││
│         │  │  ──────────  │  └─────────────────────────┘  └───────────────────┘│
│         │  │  Builder     │                                                     │
│         │  │  ──────────  │  (Builder panel slides in below toolbar when        │
│         │  │  EMA  20  ×  │   editing; collapses when viewing library)          │
│         │  │  RSI  14  ×  │                                                     │
│         │  │  [+Add]      │                                                     │
│         │  │              │                                                     │
│         │  │  Conditions  │                                                     │
│         │  │  [+Add]      │                                                     │
│         │  │              │                                                     │
│         │  │  Name [    ] │                                                     │
│         │  │  ○ Draft     │                                                     │
│         │  │  ● Complete  │                                                     │
│         │  │              │                                                     │
│         │  │  [Save as    │                                                     │
│         │  │   Indicator] │                                                     │
│         │  │  [Export as  │                                                     │
│         │  │   Strategy]  │                                                     │
│         │  └──────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Panel breakdown

| Panel | Width | Contents |
|---|---|---|
| Indicator Library | `w-48` fixed | List of saved indicators (own + loaded); active toggle per item |
| Builder + Save | `w-48` fixed (shares left column) | Indicator rows, params, conditions, name, status, save/export buttons |
| Chart | `flex-1` | Lightweight Charts candlestick + overlay + oscillator panes |
| AI Panel | `w-64` fixed | Analyse button, Claude SSE stream, suggestion cards with Apply |

The left column switches between **Library** view (browsing saved indicators) and **Builder** view
(editing). A tab strip or toggle at the top of the left panel controls this. When a saved indicator
is clicked in the Library, it loads into the Builder for editing.

---

## Indicator Library (left panel)

### What it shows

List of all saved indicators for the current user, sorted by `updated_at` descending:

```
● EMA Trend Stack     complete   [Load] [×]
○ RSI Divergence      draft      [Load] [×]
● MACD + ATR filter   complete   [Load] [×]
```

- `●` = complete (filled dot, white)
- `○` = draft (outline dot, slate)
- `[Load]` — loads the indicator into the Builder and applies it to the chart
- `[×]` — delete (with confirmation)

Multiple indicators can be active on the chart simultaneously. Each active indicator's series
are shown on the chart in addition to whatever is currently in the Builder.

### Active overlays on chart

When a saved indicator is loaded from the Library onto the chart, its series render as an
additional layer on top of the Builder's series. This lets the user compare e.g. "EMA Trend Stack"
vs their current experimental setup side by side.

Each active library overlay is visually distinguished from the Builder's series by slightly
different line opacity or a label in the chart legend.

---

## Indicator Builder

### Add indicator flow

1. Click **"+ Add Indicator"** → dropdown of 8 supported types (EMA, SMA, RSI, MACD, BB, ATR, ADX, STOCH)
2. Each added indicator renders an inline row: `[type] [param inputs] [colour] [×remove]`
3. Changing any param immediately recomputes and re-renders the chart (debounced 300 ms)

### Indicator row UI

```
EMA   period [  20  ]  [■ colour]  ×
RSI   period [  14  ]              ×
MACD  fast [12] slow [26] signal [9] ×
BB    period [20] std_dev [2.0]    ×
```

Colour picker for overlay series (EMA, SMA, BB bands). Oscillators use default palette colours.

### Signal conditions (optional)

A simplified SIR entry_conditions builder — same operators as the backtester:
`price_above`, `price_below`, `>`, `<`, `crosses_above`, `crosses_below`.

When conditions are defined, the chart renders entry signal markers (▲ green) at each matching
candle. No exit conditions, no trade simulation — purely visual.

If conditions are present when the user saves as Indicator, they are stored in `signal_conditions`
JSONB. When conditions are present on a saved indicator loaded onto Superchart, the signal markers
are rendered there too.

---

## Save Flow

### Name + Status

Below the condition builder:

```
Name  [EMA Trend Stack              ]
      ○ Draft   ● Complete
```

- **Draft** — work in progress; shown with `○` badge in the library. Editable.
- **Complete** — finished indicator, ready to use. Shown with `●` badge. Still editable.

There is no locked/immutable state — complete just signals intent, not a lock.

Auto-suggested name if blank: `[Lab] {TYPE_LIST} {pair} {TF}` e.g. `[Lab] EMA+RSI EURUSD 1H`.

### Save as Indicator

POSTs to `POST /api/lab/indicators/saved` with:
```json
{
  "name": "EMA Trend Stack",
  "status": "complete",
  "indicator_config": {
    "indicators": [
      { "type": "EMA", "params": { "period": 20 }, "color": "#3b82f6" },
      { "type": "EMA", "params": { "period": 50 }, "color": "#f59e0b" },
      { "type": "RSI", "params": { "period": 14 } }
    ]
  },
  "signal_conditions": []
}
```

On success: toast "Indicator saved", item appears in the Library panel immediately.

PATCH `PUT /api/lab/indicators/saved/{id}` for updates (name change, status toggle, param edit).

### Export as Strategy

Converts indicator config + signal conditions to a full SIR JSON, POSTs to `POST /api/strategies`,
then navigates to `/backtest?strategy_id=<new_id>&pair=<pair>&timeframe=<tf>`.
Signal conditions become `entry_conditions`; ATR defaults are used for SL/TP.

Requires at least one signal condition to be defined (button disabled if none).

---

## Chart

Reuses the Lightweight Charts setup from Superchart:
- Candlestick series on main pane
- Overlay indicators (EMA, SMA, BB) as `LineSeries` on the main chart
- Oscillators (RSI, MACD, ATR, ADX, STOCH) in separate chart instances below, synced via
  `subscribeVisibleLogicalRangeChange` (same pattern as Superchart)
- Signal markers: `setMarkers()` on the candlestick series
- Time-based sync fix (same as Superchart PR #99 — use timestamps not indices)

Builder series and Library overlay series are rendered in the same chart instance; Library overlays
use slightly reduced opacity (`0.6`) to visually separate them from the active Builder series.

---

## AI Panel

### "Analyse Chart" flow

1. User clicks **[Analyse Chart]**
2. Frontend sends:
   - Current Builder indicator config + conditions
   - Active library overlays (if any)
   - Visible date range (from chart time scale)
   - Pair + timeframe
3. POST to `POST /api/lab/analyze` (SSE)
4. Claude responds with observations + structured suggestions, streamed token by token

### What Claude analyses

Prompt includes:
- Human-readable indicator description (same `conditionToLabel` format)
- Precomputed stats for the visible window: signal count, rough forward-return stats at signal bars
- Whether any library overlays are active (Claude can compare them)
- The pair + timeframe

### Suggestion cards

Claude tool use returns structured suggestions; each renders as a card:

```
┌────────────────────────────────────────────────────────┐
│ Add volatility filter                                  │
│ ATR(14) > 0.0010                                       │
│                                            [Apply]     │
└────────────────────────────────────────────────────────┘
```

Tools (3): `add_indicator`, `set_param`, `add_condition`
"Apply" adds to the Builder, triggers recompute, updates chart.

---

## Superchart Integration

### Loading a saved indicator onto Superchart

Superchart's right panel gets a new **"Indicators"** section (below the existing strategy IR panel):

```
┌──────────────────────────────┐
│  Indicators                  │
│  ─────────────────────────   │
│  [+ Load Indicator ▾]        │
│                              │
│  ● EMA Trend Stack    [×]    │
│  ○ RSI Divergence     [×]    │
└──────────────────────────────┘
```

- Dropdown lists all saved indicators (complete first, then drafts)
- Selecting one fetches the series via `POST /api/lab/indicators` (same compute endpoint)
  for the Superchart's current pair, timeframe, and visible range
- Series are rendered as additional overlays on the main chart and oscillator panes
- Each loaded indicator can be removed with `[×]`

Multiple saved indicators can be active on Superchart simultaneously.

### URL param: `indicator_id`

`/superchart?strategy_id=X&backtest_id=Y&indicator_id=Z` pre-loads a saved indicator onto the chart.
The "Open in Superchart with this indicator" button in the Lab Library panel constructs this URL.

### Superchart toolbar addition

Add **"Open in Lab"** button to the Superchart toolbar (standard `border-blue-700` style).
Navigates to `/lab?pair=<pair>&timeframe=<tf>` — pre-fills the pair/TF without loading a strategy.

---

## Backend

### New file: `backend/routers/lab.py`

Prefix: `/api/lab`

| Endpoint | Purpose |
|---|---|
| `GET /api/lab/candles` | Fetch OHLCV for pair + timeframe + date range |
| `POST /api/lab/indicators` | Compute indicator series — accepts `{pair, timeframe, from, to, indicators[]}` |
| `POST /api/lab/signals` | Compute signal timestamps for given indicator config + conditions |
| `POST /api/lab/analyze` | SSE — stream Claude analysis of current chart state |
| `GET /api/lab/indicators/saved` | List all saved indicators for current user |
| `POST /api/lab/indicators/saved` | Create a new saved indicator |
| `PUT /api/lab/indicators/saved/{id}` | Update name, status, or config |
| `DELETE /api/lab/indicators/saved/{id}` | Delete |

### `POST /api/lab/indicators` — compute (stateless)

Request:
```json
{
  "pair": "EURUSD",
  "timeframe": "1H",
  "from": "2025-01-01",
  "to": "2025-04-01",
  "indicators": [
    { "type": "EMA", "params": { "period": 20 }, "color": "#3b82f6" },
    { "type": "RSI", "params": { "period": 14 } }
  ]
}
```

Response: same schema as `GET /api/analytics/backtest/{id}/indicators` — identical serialisation
so frontend chart rendering code is reused without modification.

Superchart calls this endpoint when loading a saved indicator (passing its `indicator_config.indicators`).

### `POST /api/lab/analyze` — SSE

Auth: `get_current_user_sse` (token via query param). Same pattern as optimization SSE.

Prompt built in `ai/lab_agent.py`:
1. Human-readable description of Builder config
2. Quick stats for visible window
3. Note active library overlays if any
4. Claude tool use → suggestion objects

### New DB table: `saved_indicators`

```sql
CREATE TABLE saved_indicators (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             VARCHAR(200) NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'draft',  -- 'draft' | 'complete'
    indicator_config JSONB NOT NULL,     -- { indicators: [{type, params, color?}] }
    signal_conditions JSONB NOT NULL DEFAULT '[]',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_saved_indicators_user ON saved_indicators(user_id);
```

Migration: `db/migrations/0xx_saved_indicators.sql`

`indicator_config` schema:
```json
{
  "indicators": [
    { "type": "EMA",  "params": { "period": 20 }, "color": "#3b82f6" },
    { "type": "RSI",  "params": { "period": 14 } }
  ]
}
```

`signal_conditions` schema: same as SIR `entry_conditions` array — reuses existing SIR types.

---

## Frontend files

| File | Notes |
|---|---|
| `src/app/lab/page.tsx` | Main page — Suspense wrapper + `LabInner` |
| `src/components/LabLibrary.tsx` | Left panel library view — list, load, delete, status badges |
| `src/components/IndicatorBuilder.tsx` | Left panel builder view — rows, params, conditions, name, status, save/export |
| `src/components/LabChart.tsx` | Chart — Lightweight Charts, Builder series + Library overlay series |
| `src/components/LabAIPanel.tsx` | AI panel — SSE stream, suggestion cards |
| `src/lib/labTypes.ts` | `LabIndicator`, `LabCondition`, `SavedIndicator`, `LabSuggestion` |

Superchart changes:
| File | Change |
|---|---|
| `src/app/superchart/page.tsx` | Add Indicators section to right panel; handle `indicator_id` URL param; render Library overlay series |

---

## URL params

| Page | Param | Effect |
|---|---|---|
| `/lab` | `pair`, `timeframe` | Pre-fill pair/TF (from Superchart "Open in Lab" button) |
| `/lab` | `strategy_id` | Pre-load strategy's indicator config into Builder |
| `/lab` | `indicator_id` | Load a saved indicator into Builder for editing |
| `/superchart` | `indicator_id` | Pre-load a saved indicator as overlay on chart open |

---

## Build order (recommended)

1. DB migration `saved_indicators` table
2. `POST /api/lab/indicators` compute endpoint + `GET /api/lab/candles` — no AI, no persistence
3. Frontend: Lab page skeleton — Builder + Chart + live recompute (no library, no AI)
4. `POST /api/lab/signals` — signal markers on chart
5. Saved indicator CRUD endpoints + LabLibrary panel + Save as Indicator flow
6. `POST /api/lab/analyze` — SSE + AI panel + suggestion cards
7. Export as Strategy flow
8. Superchart integration — Indicators section + `indicator_id` URL param
9. "Open in Lab" button on Superchart; "Open in Superchart" button in Lab Library

Estimated PRs: 6–7

---

## Out of scope (v1)

- Trade simulation / PnL (belongs in Backtester)
- Custom indicator code editor (too complex, security risk)
- Sharing indicators between users
- Indicator versioning / history (just overwrite on save)
- ML-based signals (see ML Engine spec)
- Multi-pair comparison view
- Indicator performance metrics without a full backtest
