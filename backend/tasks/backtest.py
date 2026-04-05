from core.celery_app import celery_app


@celery_app.task(bind=True, name="tasks.backtest.run")
def run_backtest(self, strategy_id: str, params: dict) -> dict:
    """Placeholder — full implementation added in backtest phase."""
    raise NotImplementedError("Backtest task not yet implemented")
