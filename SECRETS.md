# Doppler Secrets Reference

All secrets are managed in Doppler. No secrets are stored in this repository.

Configure three environments in the Doppler dashboard:
- `development` — local dev (maps to `doppler.yaml` default)
- `staging` — pre-production VPS
- `production` — live trading VPS

## How to run locally

```bash
# Authenticate with Doppler (once)
doppler login

# Link this directory to the project (once)
doppler setup

# Run all services with secrets injected
doppler run -- docker compose up
```

## Required secrets

### Database — TimescaleDB
| Key | Example | Notes |
|-----|---------|-------|
| `POSTGRES_DB` | `forex_db` | Database name |
| `POSTGRES_USER` | `forex_user` | Postgres username |
| `POSTGRES_PASSWORD` | *(random 32-char string)* | Never reuse across environments |

### Database — ClickHouse
| Key | Example | Notes |
|-----|---------|-------|
| `CLICKHOUSE_DB` | `forex_analytics` | ClickHouse database name |
| `CLICKHOUSE_USER` | `forex_user` | ClickHouse username |
| `CLICKHOUSE_PASSWORD` | *(random 32-char string)* | |

### Cache — Redis
| Key | Example | Notes |
|-----|---------|-------|
| `REDIS_PASSWORD` | *(random 32-char string)* | Required — Redis runs with auth enabled |

### Authentication
| Key | Example | Notes |
|-----|---------|-------|
| `JWT_SECRET` | *(random 64-char string)* | Minimum 256-bit. Rotate every 90 days. |

### AI Services
| Key | Example | Notes |
|-----|---------|-------|
| `CLAUDE_API_KEY` | `sk-ant-...` | Anthropic API key |
| `VOYAGE_API_KEY` | `pa-...` | Voyage AI key for finance embeddings |

### Broker — OANDA
| Key | Example | Notes |
|-----|---------|-------|
| `OANDA_API_KEY` | `...` | Scoped to trading only — no withdrawal permissions |
| `OANDA_ACCOUNT_ID` | `101-...` | OANDA account ID |
| `OANDA_ENVIRONMENT` | `practice` | `practice` for staging, `live` for production only |

### Observability
| Key | Example | Notes |
|-----|---------|-------|
| `GRAFANA_ADMIN_PASSWORD` | *(random string)* | Grafana web UI admin password |

### Frontend
| Key | Example | Notes |
|-----|---------|-------|
| `NEXT_PUBLIC_API_URL` | `https://yourdomain.com` | Public base URL of the API |

## Live trading gate

The `LIVE_TRADING_ENABLED` flag is hardcoded to `false` in `docker-compose.yml`.
It is only set to `true` in Doppler's `production` config after the 30-day paper trading gate is passed.
It is never changed automatically by CI/CD.
