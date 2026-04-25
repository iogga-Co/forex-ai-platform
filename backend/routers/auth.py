from typing import Annotated

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

from core.auth import (
    TokenData,
    create_access_token,
    create_mfa_token,
    create_refresh_token,
    decode_token,
    get_current_user,
)
from core.config import settings
from core.db import get_pool

router = APIRouter(prefix="/api/auth", tags=["Auth"])

# ---------------------------------------------------------------------------
# Single-user system. The operator password is stored in Doppler as
# OPERATOR_PASSWORD and checked at login. No user database needed.
# ---------------------------------------------------------------------------
OPERATOR_USERNAME = "operator"


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/login", response_model=TokenResponse)
async def login(
    response: Response,
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
) -> TokenResponse:
    """
    Authenticate with username + password.
    Returns a short-lived access token and sets a refresh token in an HttpOnly cookie.
    """
    operator_password = getattr(settings, "operator_password", None)

    if (
        form_data.username != OPERATOR_USERNAME
        or operator_password is None
        or form_data.password != operator_password
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token = create_access_token(OPERATOR_USERNAME)
    refresh_token = create_refresh_token(OPERATOR_USERNAME)

    # Refresh token lives in an HttpOnly cookie — not accessible from JavaScript
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=settings.jwt_refresh_token_expire_days * 86400,
    )

    return TokenResponse(access_token=access_token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: Request) -> TokenResponse:
    """Exchange a valid refresh token cookie for a new access token."""
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token missing",
        )

    token_data = decode_token(refresh_token, expected_type="refresh")
    return TokenResponse(access_token=create_access_token(token_data.sub))


# ---------------------------------------------------------------------------
# MFA — setup + verify
# ---------------------------------------------------------------------------

class MFASetupResponse(BaseModel):
    secret: str
    otpauth_uri: str
    already_enabled: bool


class MFAVerifyRequest(BaseModel):
    code: str


class MFAVerifyResponse(BaseModel):
    mfa_token: str


@router.post("/mfa/setup", response_model=MFASetupResponse)
async def mfa_setup(
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> MFASetupResponse:
    """
    Generate (or return) the TOTP secret for the operator account.
    Idempotent — calling again returns the same secret until MFA is disabled.
    Scan the returned otpauth_uri with an authenticator app (e.g. Google Authenticator).
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT totp_secret, enabled FROM operator_mfa WHERE username = 'operator'"
        )
        if row:
            secret = row["totp_secret"]
            already_enabled = row["enabled"]
        else:
            secret = pyotp.random_base32()
            await conn.execute(
                """
                INSERT INTO operator_mfa (username, totp_secret, enabled)
                VALUES ('operator', $1, false)
                """,
                secret,
            )
            already_enabled = False

    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name="operator", issuer_name="Forex AI Platform"
    )
    return MFASetupResponse(secret=secret, otpauth_uri=uri, already_enabled=already_enabled)


@router.post("/mfa/verify", response_model=MFAVerifyResponse)
async def mfa_verify(
    body: MFAVerifyRequest,
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> MFAVerifyResponse:
    """
    Verify a TOTP code. On success: marks MFA as enabled and returns a short-lived
    mfa_token (15 min) to be sent as X-MFA-Token on protected endpoints.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT totp_secret FROM operator_mfa WHERE username = 'operator'"
        )

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="MFA not set up — call /api/auth/mfa/setup first",
        )

    totp = pyotp.TOTP(row["totp_secret"])
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid TOTP code",
        )

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE operator_mfa SET enabled = true WHERE username = 'operator'"
        )

    return MFAVerifyResponse(mfa_token=create_mfa_token(OPERATOR_USERNAME))


@router.get("/mfa/status")
async def mfa_status(
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> dict:
    """Return whether MFA is set up and enabled for the operator."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT enabled FROM operator_mfa WHERE username = 'operator'"
        )
    return {
        "configured": row is not None,
        "enabled": bool(row["enabled"]) if row else False,
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> None:
    """Clear the refresh token cookie."""
    response.delete_cookie("refresh_token")
