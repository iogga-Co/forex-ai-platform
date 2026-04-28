# Forex AI Trading Platform — Claude Code Guide

## Project overview

AI-assisted forex trading platform. Users create strategies via an AI Co-Pilot (Claude), backtest them against historical OHLCV data, optimize with iterative AI refinement, and view results on interactive charts.

**Stack:** Next.js 15 (frontend) · FastAPI + uvicorn (backend) · Celery + Redis (task queue) · TimescaleDB + pgvector (database) · Nginx (reverse proxy) · Doppler (secrets) · Docker Compose

**Repo:** https://github.com/iogga-Co/forex-ai-platform
**Local:** `C:\Projects\forex-ai-platform`
**Working dir for frontend sessions:** `C:\Projects\forex-ai-platform\frontend`

**AI models:** Claude (`claude-sonnet-4-6`, `claude-opus-4-6`), OpenAI (`gpt-4o`, `gpt-4o-mini`), Gemini (`gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`) — selected in Settings, routing via `ai/model_router.py`. Embeddings: Voyage AI (always, regardless of model selection).

**Broker:** OANDA REST API, practice account `001-001-21125823-001`. `LIVE_TRADING_ENABLED=false` (gated).

---

## Sub-CLAUDE.md files

Detailed rules live in the relevant subfolder:

| File | Contents |
|---|---|
| `backend/CLAUDE.md` | asyncpg patterns, Celery queues, pgvector, MFA, InstrumentRegistry, Settings.for_testing(), Doppler |
| `backend/engine/CLAUDE.md` | SIR schema + extensions (Phase 3.6), optimization iterations pattern |
| `backend/live/CLAUDE.md` | Phase 4 live trading architecture, Phase 5.1 trading-service, Redis channels |
| `backend/ai/CLAUDE.md` | Model routing, diagnosis endpoints, lab agent, Anthropic SDK gotchas |
| `backend/tasks/CLAUDE.md` | G-Optimize ConfigSampler, entry/exit config formats, RAG injection |
| `db/CLAUDE.md` | Key tables, OHLCV coverage, timeframe resampling, migrations |
| `nginx/CLAUDE.md` | nginx.conf structure, upstream hostname resolution |
| `frontend/CLAUDE.md` | All frontend conventions, components, localStorage, Lab UI patterns |

---

## Behavioral guidelines

### Think before coding
- State assumptions explicitly before implementing. If uncertain, ask — don't guess silently.
- If multiple interpretations exist, present them rather than picking one without saying so.
- If a simpler approach exists, say so and push back when warranted.

### Simplicity first
- Minimum code that solves the problem. Nothing speculative.
- No abstractions for single-use code. No "flexibility" that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.

### Surgical changes
- Touch only what the task requires. Don't "improve" adjacent code, comments, or formatting.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that *your* changes made unused; leave pre-existing dead code alone.

### Goal-driven execution
- Transform vague tasks into verifiable goals before starting (e.g. "fix the bug" → "write a test that reproduces it, then make it pass").
- For multi-step tasks, state a brief numbered plan with a verify step for each item.

---

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Foundation | ✅ Complete |
| 1 | Core Engine | ✅ Complete |
| 2 | AI Intelligence | ✅ Complete |
| 3 | Analytics Suite | ✅ Complete |
| 3.5 | Indicator Lab | ✅ Complete — PRs #108–#113 merged + AI panel 2026-04-26 |
| 3.6 | G-Optimize | ✅ Complete — PR #102 |
| 4 | Live Trading | ✅ Complete — PRs #106, #115, #117, #118 merged |
| 5.0 | Live Trading Hardening | ✅ Complete — ATR abort, reconciliation, pip registry, MFA |
| 5.1 | Microservice Decomposition | ✅ Complete — trading-service container |
| 5.2 | UX & Stability | ✅ Complete — toasts, dual-axis chart, density toggle, SSE backoff |
| 5.3 | Advanced Execution | ✅ Complete — limit orders, spread gating, TWAP |
| 5.4 | RAG Evaluation | 🔲 Pending |

---

## Directory structure

```
forex-ai-platform/
├── backend/
│   ├── routers/          # FastAPI route handlers
│   ├── engine/           # Backtesting engine (sir.py, parser.py, runner.py, indicators.py)
│   ├── tasks/            # Celery tasks (backtest.py, optimization.py, g_optimize.py)
│   ├── ai/               # model_router.py, claude/openai/gemini clients, agents, diagnosis
│   ├── live/             # Live trading: oanda.py, feed.py, bars.py, engine.py, executor.py
│   ├── core/             # Config, DB pool, auth (JWT), instruments.py
│   ├── data/             # OHLCV ingest pipeline
│   └── scripts/          # backfill.py, seed_demo.py
├── frontend/src/
│   ├── app/              # Next.js pages
│   ├── components/       # BacktestResultPanel, TradeAnalysisSidebar, etc.
│   └── lib/              # auth.ts, settings.ts, strategyLabels.ts, strategyHealth.ts
├── db/migrations/        # SQL migration files
├── nginx/                # nginx.conf + certs
├── backend/trading_service.py  # standalone trading process
├── docker-compose.yml
├── docker-compose.dev.yml
└── doppler.yaml
```

---

## Running locally

```bash
# Start all services with hot reload (bind mounts via dev override)
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Restart after backend code changes (uvicorn has NO --reload)
doppler run -- docker compose restart fastapi

# Restart after tasks/ changes
doppler run -- docker compose restart celery

# Restart after live/ changes
doppler run -- docker compose restart trading-service

# Production/staging (baked images, no bind mounts)
doppler run -- docker compose up
```

**Critical:** uvicorn runs WITHOUT `--reload`. Always `docker compose restart fastapi` after editing backend files.

---

## Staging server

- **IP:** `86.48.16.255` — always SSH to this IP directly, NOT the domain (domain resolves to wrong IP)
- **Domain:** `trading.iogga-co.com` (HTTPS works, SSH does not)
- **OS:** Ubuntu 24.04, user: `root`
- **Project path:** `/opt/forex-ai-platform`
- **Container names:** `forex-ai-platform-fastapi-1`, `forex-ai-platform-celery-1`, `forex-ai-platform-timescaledb-1`, `forex-ai-platform-trading-service-1`

```bash
ssh root@86.48.16.255
ssh root@86.48.16.255 "docker compose -f /opt/forex-ai-platform/docker-compose.yml ps"
```

---

## Infrastructure notes

### Docker Compose — bind mounts
Never add source code bind mounts (`./backend:/app`) to the base `docker-compose.yml`. They go in `docker-compose.dev.yml` only. On the server, containers run as a different UID — bind mounts cause EACCES errors.

### NEXT_PUBLIC_API_URL — local dev
`docker-compose.dev.yml` sets `NEXT_PUBLIC_API_URL: ""` (empty string). This forces the browser to use relative URLs routed through nginx — required because Doppler injects `http://localhost:3000` which is only reachable server-side.

### Hot reload on Windows (Docker bind mounts)
Next.js with Turbopack ignores polling env vars on Windows bind-mounted volumes. Two fixes applied in combination:
1. `docker-compose.dev.yml` uses `node_modules/.bin/next dev` (webpack, no Turbopack) with `WATCHPACK_POLLING: "true"` and `CHOKIDAR_USEPOLLING: "true"`
2. `next.config.ts` sets `config.watchOptions = { poll: 1000, aggregateTimeout: 300 }`

If hot reload stops working, verify both are present. Do not re-add `--turbopack`.

### Docker image tags
Always lowercase the image tag owner prefix (`iogga-Co` → `iogga-co`):
```yaml
echo "IMAGE_PREFIX=ghcr.io/$(echo '${{ github.repository_owner }}' | tr '[:upper:]' '[:lower:]')/forex-ai" >> $GITHUB_ENV
```

### CI pipeline
- `next lint` deprecated in Next.js 15.5+ — use `eslint src/` with `eslint.config.mjs`
- pytest exit code 5 = no tests collected (not a failure) — handle with `pytest ... || [ $? -eq 5 ]`
- Staging deploy only fires on `push` to main, not `workflow_dispatch`
- `npm ci` requires `package-lock.json` in sync — commit both together after any `npm install`
- **Deploy order:** recreate `fastapi celery celery-g-optimize trading-service` first → `sleep 5` → recreate `nextjs` → `nginx -s reload`. All backend services must be listed explicitly.
- **DB migrations in deploy:** CI loop runs all `db/migrations/*.sql` with `|| true` — already-applied migrations are silently ignored.
- **Nginx reload fallback:** `nginx -s reload 2>/dev/null || docker compose up -d --force-recreate nginx`
- **Local main diverges after squash merges** — always create new branches from `origin/main` (`git checkout -b feat/foo origin/main`), never from local `main`.
- **Docker pip install** — Dockerfile uses `pip install --no-cache-dir --retries 5 -r requirements.txt` (`--retries 5` guards against transient SSL errors on GitHub Actions).
- **CI deploys as root** — deploy scripts use `username: root`. Never use `username: deploy` — file ownership conflicts cause silent `git pull` failures.

### Feature specs
Detailed specs for planned features live in `docs/specs/`:
- `docs/specs/indicator-lab.md` — Phase 3.5 ✅
- `docs/specs/g-optimize.md` — Phase 3.6 ✅
- `docs/specs/ml-engine.md` — Phase 5 🔲
