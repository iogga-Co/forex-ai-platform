from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    database_url: str

    # Redis / Celery
    redis_url: str

    # Authentication
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 15
    jwt_refresh_token_expire_days: int = 30

    # AI Services
    claude_api_key: str
    voyage_api_key: str
    gemini_api_key: str = ""
    openai_api_key: str = ""

    # Broker
    oanda_api_key: str
    oanda_account_id: str
    oanda_environment: str = "practice"  # "practice" | "live"

    # Operator auth (single-user system)
    operator_password: str

    # Feature flags
    live_trading_enabled: bool = False

    model_config = SettingsConfigDict(
        env_file=None,  # Doppler injects secrets as env vars — no .env file needed
        case_sensitive=False,
    )

    @classmethod
    def for_testing(cls, **overrides: object) -> "Settings":
        """Create a Settings instance for unit tests without real env vars.

        All required fields default to safe test values. Pass keyword arguments
        to override specific fields:

            settings = Settings.for_testing(live_trading_enabled=True)
        """
        defaults: dict[str, object] = {
            "database_url":    "postgresql://test:test@localhost:5432/test",
            "redis_url":       "redis://localhost:6379/0",
            "jwt_secret":      "test-secret-key-not-for-production",
            "claude_api_key":  "test-claude-key",
            "voyage_api_key":  "test-voyage-key",
            "oanda_api_key":   "test-oanda-key",
            "oanda_account_id": "001-001-00000000-001",
            "operator_password": "test-password",
        }
        defaults.update(overrides)
        return cls(**defaults)  # type: ignore[arg-type]


# Single instance imported everywhere.
# pydantic-settings populates fields from env vars, not constructor arguments.
settings = Settings()  # type: ignore[call-arg]
