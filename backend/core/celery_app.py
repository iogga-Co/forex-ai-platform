import logging

from celery import Celery
from celery.signals import worker_ready

from core.config import settings

logger = logging.getLogger(__name__)

celery_app = Celery(
    "forex_ai",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["tasks.backtest"],  # Phase 1: backtest task
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # Backtest tasks can run for several minutes on large datasets
    task_soft_time_limit=900,   # 15 min soft limit — task gets a warning
    task_time_limit=1200,       # 20 min hard limit — task is killed
    worker_prefetch_multiplier=1,  # One task at a time per worker (CPU-bound)
)


@worker_ready.connect
def on_worker_ready(**_kwargs: object) -> None:
    """Ensure ClickHouse schema exists when the worker starts."""
    try:
        from core.clickhouse import init_schema
        init_schema()
    except Exception as exc:  # noqa: BLE001
        logger.warning("ClickHouse init_schema failed (non-fatal): %s", exc)
