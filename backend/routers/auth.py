import os
import secrets
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.app_db import get_db, User
from core.auth import get_current_user, create_token
from core.security import verify_password, hash_password
from core.logger import log

router = APIRouter()


# ── Rate limiting ──────────────────────────────────────────────────────────────

_login_attempts: dict[str, list] = defaultdict(list)
_attempts_lock = threading.Lock()
_MAX_ATTEMPTS = 10
_WINDOW_MINUTES = 15


def _check_rate_limit(ip: str | None):
    if not ip:
        return
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=_WINDOW_MINUTES)
    with _attempts_lock:
        recent = [t for t in _login_attempts[ip] if t > cutoff]
        _login_attempts[ip] = recent
        if len(recent) >= _MAX_ATTEMPTS:
            raise HTTPException(429, f"Too many login attempts. Please wait {_WINDOW_MINUTES} minutes.")
        recent.append(now)


def _clear_rate_limit(ip: str | None):
    if ip:
        with _attempts_lock:
            _login_attempts.pop(ip, None)


# ── Password login ─────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else None
    _check_rate_limit(ip)
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not verify_password(req.password, user.password_hash):
        log("warn", "auth", f"Failed login attempt for '{req.email}'",
            detail={"ip": ip})
        raise HTTPException(status_code=401, detail="Invalid email or password")
    _clear_rate_limit(ip)
    log("info", "auth", f"User logged in: {user.email}",
        user_email=user.email, user_id=user.id,
        detail={"role": user.role, "ip": ip})
    return {
        "token": create_token(user.id),
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role,
            "org_id": user.org_id,
            "has_password": bool(user.password_hash),
        },
    }


@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "org_id": user.org_id,
        "has_password": bool(user.password_hash),
    }


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not user.password_hash:
        raise HTTPException(400, "This account uses Google Sign-In and has no password.")
    if not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    user.password_hash = hash_password(req.new_password)
    db.commit()
    log("info", "auth", f"Password changed: {user.email}", user_email=user.email, user_id=user.id)
    return {"ok": True}


# ── Google Sign-In ─────────────────────────────────────────────────────────────

_GOOGLE_AUTH_URI  = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
_GOOGLE_SCOPES    = ["openid", "email", "profile"]
_google_states: dict[str, float] = {}   # state → created_at (epoch seconds)


def _google_redirect_uri() -> str:
    backend = os.environ.get("BACKEND_URL", "http://localhost:8000")
    return f"{backend.rstrip('/')}/api/auth/google/callback"


@router.get("/google/login")
def google_login():
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(503, "Google Sign-In is not configured on this server.")

    # Clean up stale states (older than 10 minutes)
    cutoff = datetime.now(timezone.utc).timestamp() - 600
    for k in list(_google_states):
        if _google_states[k] < cutoff:
            del _google_states[k]

    state = secrets.token_urlsafe(32)
    _google_states[state] = datetime.now(timezone.utc).timestamp()

    params = {
        "client_id": client_id,
        "redirect_uri": _google_redirect_uri(),
        "response_type": "code",
        "scope": " ".join(_GOOGLE_SCOPES),
        "state": state,
        "access_type": "online",
    }
    return RedirectResponse(f"{_GOOGLE_AUTH_URI}?{urlencode(params)}")


@router.get("/google/callback")
def google_callback(
    request: Request,
    code: str = Query(None),
    state: str = Query(None),
    error: str = Query(None),
    db: Session = Depends(get_db),
):
    frontend = os.environ.get("FRONTEND_URL", "http://localhost:3000").split(",")[0].strip()

    if error:
        return RedirectResponse(f"{frontend}/login?error=google_denied")

    if not state or state not in _google_states:
        return RedirectResponse(f"{frontend}/login?error=invalid_state")
    del _google_states[state]

    if not code:
        return RedirectResponse(f"{frontend}/login?error=no_code")

    client_id     = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    backend       = os.environ.get("BACKEND_URL", "http://localhost:8000")

    # Allow HTTP redirect URIs in local dev (mirrors the BigQuery OAuth flag)
    if backend.startswith("http://"):
        os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

    try:
        from google_auth_oauthlib.flow import Flow
        client_config = {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uris": [_google_redirect_uri()],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": _GOOGLE_TOKEN_URI,
            }
        }
        flow = Flow.from_client_config(client_config, scopes=_GOOGLE_SCOPES, state=state)
        flow.redirect_uri = _google_redirect_uri()
        flow.fetch_token(authorization_response=str(request.url))
        raw_token  = flow.oauth2session.token
        id_token_str = raw_token.get("id_token")
    except Exception as exc:
        log("error", "auth", f"Google OAuth token exchange failed: {exc}")
        return RedirectResponse(f"{frontend}/login?error=token_exchange_failed")

    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
        idinfo = google_id_token.verify_oauth2_token(
            id_token_str, google_requests.Request(), client_id
        )
    except Exception as exc:
        log("error", "auth", f"Google ID token verification failed: {exc}")
        return RedirectResponse(f"{frontend}/login?error=invalid_token")

    google_sub = idinfo.get("sub", "")
    email      = idinfo.get("email", "")
    name       = idinfo.get("name") or email.split("@")[0]

    if not email:
        return RedirectResponse(f"{frontend}/login?error=no_email")

    # Find by google_id first, then by email (to link existing password accounts)
    user = db.query(User).filter(User.google_id == google_sub).first()
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        if not user.google_id:
            user.google_id = google_sub
        db.commit()
    else:
        user = User(
            id=str(uuid.uuid4()),
            email=email,
            name=name,
            password_hash="",   # Google-only: no password
            role="designer",
            google_id=google_sub,
            created_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()

    token = create_token(user.id)
    log("info", "auth", f"Google Sign-In: {email}", user_email=email, user_id=user.id)
    return RedirectResponse(f"{frontend}/login?auth_token={token}")
