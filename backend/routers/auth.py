from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

from core.auth import (
    TokenData,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
)
from core.config import settings

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


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> None:
    """Clear the refresh token cookie."""
    response.delete_cookie("refresh_token")
