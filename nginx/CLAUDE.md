# Nginx

## Config structure

`nginx.conf` must always have top-level `events {}` and `http {}` wrapper blocks. Directives like `limit_req_zone` placed outside these blocks cause nginx to crash at startup.

## Upstream hostname resolution

Nginx resolves upstream hostnames (e.g. `fastapi`) at startup — if nginx restarts while fastapi is down, it fails with `host not found in upstream`.

The CI deploy script handles this by recreating backend services first, sleeping 5s, then recreating frontend, then reloading nginx with a restart fallback:

```bash
nginx -s reload 2>/dev/null || docker compose up -d --force-recreate nginx
```
