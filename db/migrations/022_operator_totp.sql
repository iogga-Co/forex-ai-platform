-- Migration 022: TOTP secret for operator MFA
-- Single-user system — one row, keyed by username 'operator'.

CREATE TABLE IF NOT EXISTS operator_mfa (
    username     VARCHAR(50) PRIMARY KEY,
    totp_secret  VARCHAR(64) NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
