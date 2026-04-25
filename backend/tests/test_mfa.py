"""Unit tests for MFA — core/auth.py + routers/auth.py MFA paths."""

from __future__ import annotations

import pyotp
import pytest

from core.auth import create_mfa_token, require_mfa
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# create_mfa_token / require_mfa
# ---------------------------------------------------------------------------

def test_create_mfa_token_returns_string():
    token = create_mfa_token("operator")
    assert isinstance(token, str)
    assert len(token) > 20


@pytest.mark.asyncio
async def test_require_mfa_passes_with_valid_token():
    token = create_mfa_token("operator")
    # Should not raise
    await require_mfa(x_mfa_token=token)


@pytest.mark.asyncio
async def test_require_mfa_raises_without_token():
    with pytest.raises(HTTPException) as exc_info:
        await require_mfa(x_mfa_token=None)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_require_mfa_raises_with_bad_token():
    with pytest.raises(HTTPException) as exc_info:
        await require_mfa(x_mfa_token="not.a.valid.jwt")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_require_mfa_raises_with_access_token_as_mfa():
    from core.auth import create_access_token
    wrong_type = create_access_token("operator")
    with pytest.raises(HTTPException) as exc_info:
        await require_mfa(x_mfa_token=wrong_type)
    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# TOTP verification logic (pyotp)
# ---------------------------------------------------------------------------

def test_totp_verify_accepts_current_code():
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    code = totp.now()
    assert totp.verify(code, valid_window=1) is True


def test_totp_verify_rejects_wrong_code():
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    assert totp.verify("000000", valid_window=1) is False


def test_totp_provisioning_uri_format():
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(
        name="operator", issuer_name="Forex AI Platform"
    )
    assert uri.startswith("otpauth://totp/")
    assert "Forex%20AI%20Platform" in uri or "Forex AI Platform" in uri
