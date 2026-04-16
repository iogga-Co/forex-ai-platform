# Forex News — Feature Specification

## Overview

Two related capabilities delivered under a new **"ForEx News"** tab and integrated into the Superchart / backtest analysis views:

1. **ForEx News Tab** — a live economic calendar and news feed showing upcoming/past high-impact events for the traded pairs.
2. **Contextual Performance Diagnosis** — click a drawdown region on the equity curve and ask the AI "why did we lose money here?", receiving a structured analysis that correlates trade losses with market conditions and news events.

---

## 1. ForEx News Tab

### User story
As a trader I want a dedicated news tab that shows scheduled high-impact economic events for the pairs I trade, so I can avoid entering positions during volatile news windows and review past events that may have affected my strategy's performance.

### Layout
- **Filter bar** (top): pair selector (multi-select, defaults to all 6 pairs), date range picker, impact filter (All / High / Medium / Low), currency filter (USD, EUR, GBP, JPY, CHF)
- **Calendar table** (main): sortable by date; columns: Date/Time (UTC), Currency, Event name, Impact (🔴/🟡/⚪), Forecast, Actual, Previous
- **Upcoming events banner**: next 24 h high-impact events shown as a compact strip at the top of the page
- **Pair correlation chip**: for each event, chips showing which of the 6 traded pairs are directly affected

### Data source — Phase 1
- **ForexFactory calendar API** (unofficial JSON endpoint) — pull and cache in Redis (TTL 1 h per ISO week)
- Backend endpoint: `GET /api/news/calendar?from=&to=&currencies=&impact=`
- Store fetched events in a `news_events` Postgres table for historical correlation queries (see Phase 2)

> **⚠ Historical data limitation:** ForexFactory only exposes three weekly feeds (`lastweek`, `thisweek`,
> `nextweek`). There is no historical archive endpoint. The `news_events` table will only accumulate data
> from the day the feature is deployed — it will **not** automatically backfill to April 2021 (the start
> of OHLCV coverage). This means Phase 2 news correlation against historical backtests requires one of the
> options below.

### Historical backfill (required for Phase 2 correlation)

The OHLCV data covers April 2021 → present. To correlate past backtest trades against news events, one
of these approaches is needed before Phase 2:

| Option | Coverage | Cost | Effort |
|---|---|---|---|
| **One-time CSV import** (recommended) | 2010–present | Free | Low — write `backend/scripts/backfill_news.py` to upsert a CSV downloaded from Investing.com economic calendar export | 
| **Tradermade Economic Calendar API** | ~2015–present | ~$50–200/mo | Medium — replace ForexFactory fetch in `news.py` |
| **Polygon.io News** | Historical | Paid | Medium — different data model, requires mapping |

**Recommended path:** download a historical CSV from Investing.com's economic calendar export (free,
covers 2010–present) and write a one-time backfill script. ForexFactory continues as the live forward
feed. The existing `news_events` schema and upsert logic already support this — no table changes needed.

### Data source — Phase 2
- One-time historical backfill (see above) to populate `news_events` from April 2021 onwards
- Optionally replace ForexFactory with a paid, reliable feed (e.g., Tradermade Economic Calendar API) for higher reliability and richer data
- Add full news articles / headline feed alongside calendar events

### `news_events` table schema
```sql
CREATE TABLE news_events (
    id           SERIAL PRIMARY KEY,
    event_time   TIMESTAMPTZ NOT NULL,
    currency     VARCHAR(3)  NOT NULL,   -- e.g. 'USD'
    title        TEXT        NOT NULL,
    impact       VARCHAR(6)  NOT NULL,   -- 'high' | 'medium' | 'low'
    forecast     TEXT,
    actual       TEXT,
    previous     TEXT,
    source       VARCHAR(50) NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON news_events (event_time, currency);
```

---

## 2. Contextual Performance Diagnosis

### User story
As a trader reviewing a significant drawdown period on the equity curve, I want to click that period and ask the AI "Why did we lose money here?" so that the system can analyze the trade logs and market conditions to identify if the edge has decayed or if it was a statistical outlier.

### Interaction flow
1. User brushes (click-drag) a date range on the equity curve in **Superchart** or **Backtest results**.
2. The **Master Trade Table** filters to trades within that window automatically.
3. A **"Diagnose this period"** button appears above the table.
4. On click: the filtered trades are sent to the AI with a structured prompt.
5. A diagnosis panel slides in showing the AI response.

### AI prompt structure (backend-constructed)
```
You are analyzing a losing period in a forex backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {tf}
Period: {start} → {end}

Trades in this window ({n} total, {losses} losses, {wins} wins):
{trade_rows: entry_time, direction, entry_price, exit_price, pnl, duration_min}

[If news_events available]:
High-impact news events during this period:
{news_rows: event_time, currency, title, impact, actual vs forecast}

Analyze:
1. Were losses concentrated at a specific time of day or day of week?
2. Was there a directional bias (mostly longs lost, or mostly shorts)?
3. Do losses correlate with any news events in the window?
4. Is this consistent with overall strategy stats (statistical outlier) or a sign of edge decay?
5. What would you recommend the trader investigate or change?
```

### Response format (AI output)
The AI must respond in structured JSON consumed by the frontend:

```json
{
  "summary": "Short 1-2 sentence plain-English summary",
  "patterns": [
    { "label": "Time of day", "finding": "70% of losses occurred 13:00–14:00 UTC (NY open)" },
    { "label": "Direction", "finding": "Mostly long losses; shorts were flat" },
    { "label": "News correlation", "finding": "3 of 5 worst losses occurred within 30 min of USD high-impact events" }
  ],
  "verdict": "outlier" | "edge_decay" | "structural" | "inconclusive",
  "recommendation": "Consider adding a news filter to exclude entries 30 min either side of USD high-impact events."
}
```

### Phase 1 (no news data)
- Diagnose using trade data only (time-of-day, day-of-week, direction, duration, indicator state at entry if available)
- `news_correlation` pattern is omitted from the response

### Phase 2 (with `news_events` table populated)
- Backend joins the selected trade window against `news_events` on `event_time` within ±30 min
- News events are appended to the AI prompt
- Full correlation analysis available

---

## Backend endpoints required

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/news/calendar` | Fetch/return economic calendar events (with caching) |
| `POST` | `/api/diagnosis/period` | Accept trade window + optional news events, return AI diagnosis |

### `POST /api/diagnosis/period` request body
```json
{
  "backtest_run_id": "uuid",
  "period_start": "2024-01-15T00:00:00Z",
  "period_end":   "2024-01-19T23:59:59Z",
  "include_news": true
}
```

---

## Frontend pages / components

| File | Change |
|---|---|
| `src/app/news/page.tsx` | New ForEx News tab page |
| `src/app/superchart/page.tsx` | Add brush selection + diagnosis trigger |
| `src/components/DiagnosisPanel.tsx` | New: slide-in panel rendering AI verdict |
| `src/components/NewsCalendarTable.tsx` | New: sortable calendar event table |
| `src/components/UpcomingEventsBanner.tsx` | New: next-24h high-impact strip |

---

## Navigation

Add **"News"** to the top nav alongside Backtest, Optimize, Superchart, etc.  
Route: `/news`

---

## Out of scope (for now)

- Live price feed or real-time chart overlays on the News tab
- Push notifications for upcoming events
- News sentiment analysis on full articles (Phase 2+ only)
- Automated strategy pause on news windows (Live Trading, Phase 4)
