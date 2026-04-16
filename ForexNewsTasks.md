# Forex News — Build Tasks

Reference spec: `ForexNewsSpecs.md`

---

## Phase 1 — Core (no paid news feed, diagnosis on trade data only)

### DB

- [ ] **DB-1** Write migration `db/migrations/009_news_events.sql` — create `news_events` table (schema in spec)
- [ ] **DB-2** Add index on `(event_time, currency)`

### Backend — News calendar

- [ ] **BE-1** Create `backend/routers/news.py` — `GET /api/news/calendar` endpoint
  - Query params: `from`, `to`, `currencies` (comma-separated), `impact`
  - Fetch from ForexFactory unofficial JSON endpoint (or equivalent free source)
  - Cache response in Redis (TTL 1 h, key `news:calendar:{date}`)
  - Persist fetched events to `news_events` table (upsert on `event_time + currency + title`)
  - Cast all NUMERIC fields with `_f()` before returning
- [ ] **BE-2** Register `news` router in `backend/main.py`

### Backend — Diagnosis

- [ ] **BE-3** Create `backend/routers/diagnosis.py` — `POST /api/diagnosis/period`
  - Accept `backtest_run_id`, `period_start`, `period_end`, `include_news` (bool)
  - Query `trades` table filtered to the window
  - If `include_news=true` AND `news_events` table has data: join ±30 min around trade entries
  - Build structured prompt (see spec)
  - Call Claude (`claude-sonnet-4-6`) and parse JSON response
  - Return structured diagnosis object
- [ ] **BE-4** Register `diagnosis` router in `backend/main.py`
- [ ] **BE-5** Add `claude-sonnet-4-6` diagnosis prompt template to `backend/ai/` (new file `diagnosis.py`)

### Frontend — ForEx News tab

- [ ] **FE-1** Create `src/app/news/page.tsx` with `<Suspense>` wrapper
  - Filter bar: pair multi-select, date range, impact filter, currency filter
  - Upcoming events banner (next 24 h, high-impact only)
  - `NewsCalendarTable` component (see below)
- [ ] **FE-2** Create `src/components/NewsCalendarTable.tsx`
  - Columns: Date/Time (UTC), Currency, Event, Impact badge, Forecast, Actual, Previous
  - Sortable by date (default asc); impact badge: 🔴 high / 🟡 medium / ⚪ low
  - Pair correlation chips per row (which of the 6 traded pairs are affected)
- [ ] **FE-3** Create `src/components/UpcomingEventsBanner.tsx`
  - Compact horizontal strip, filters to next 24 h, high-impact only
  - Auto-refreshes every 15 min
- [ ] **FE-4** Add **"News"** link to top nav (`src/components/` nav component)

### Frontend — Superchart diagnosis integration

- [ ] **FE-5** Add brush/range-select interaction to equity curve in `src/app/superchart/page.tsx`
  - On brush: set `selectedPeriod: { start, end }` state
  - Filter Master Trade Table to selected period
  - Show "Diagnose this period" button above the table when a period is selected
- [ ] **FE-6** Create `src/components/DiagnosisPanel.tsx`
  - Slide-in panel (right side or bottom drawer)
  - Loading state while AI processes
  - Renders: summary text, pattern findings list, verdict badge, recommendation
  - Verdict badge: `outlier` (blue) / `edge_decay` (red) / `structural` (orange) / `inconclusive` (grey)
- [ ] **FE-7** Wire "Diagnose this period" button → `POST /api/diagnosis/period` via `fetchWithAuth` → open `DiagnosisPanel`

---

## Phase 2 — Enhanced (paid feed, full news correlation)

### Data

> **Note:** ForexFactory only provides `lastweek` / `thisweek` / `nextweek` feeds — no historical
> archive. The `news_events` table accumulates forward from deploy date only. A historical backfill
> is required before news correlation against past backtests will work. See `ForexNewsSpecs.md`
> "Historical backfill" section for options.

- [ ] **P2-0** *(prerequisite)* Historical backfill — download Investing.com economic calendar CSV
      (free, covers 2010–present) and write `backend/scripts/backfill_news.py` to upsert into
      `news_events`. Run once on staging to populate April 2021 → present.
- [ ] **P2-1** Evaluate and integrate a reliable economic calendar API (Tradermade, Polygon.io, or equivalent)
- [ ] **P2-2** Set up a scheduled Celery beat task to refresh `news_events` table every hour
- [ ] **P2-3** Add `FOREX_NEWS_API_KEY` to Doppler (development + staging configs)

### Diagnosis improvements

- [ ] **P2-4** Update diagnosis prompt to include full news correlation section when events are present
- [ ] **P2-5** Add news event overlay on equity curve (vertical lines at high-impact events) in Superchart

### News tab improvements

- [ ] **P2-6** Add full headline news feed section below calendar (pair-filtered)
- [ ] **P2-7** Add "impact on my strategy" column — for past events, show PnL of trades within ±30 min of that event

---

## Nice to have (post-Phase 2)

- [ ] Push notifications / browser alerts for upcoming high-impact events
- [ ] Automated strategy pause rules during news windows (hooks into Phase 4 live trading)
- [ ] News sentiment scoring on full articles
- [ ] Export diagnosis report as PDF
