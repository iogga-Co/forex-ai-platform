import logging

from celery import Celery

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


