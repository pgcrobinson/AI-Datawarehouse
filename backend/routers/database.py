import os
import secrets
import hashlib
import base64
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from models.schemas import ConnectionConfig, ConnectionResponse, TestConnectionRequest
from core.db import (
    test_connection, add_connection, get_all_connections,
    delete_connection, set_active_connection, get_active_connection_id,
    get_connection, update_connection,
)

router = APIRouter()

_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/bigquery",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.email",
]
_oauth_states: dict[str, dict] = {}  # state_token -> {name, project_id, database, conn_id?}


@router.post("/test")
async def test_db_connection(request: TestConnectionRequest):
    config = ConnectionConfig(name="_test", **request.model_dump())
    success, message = test_connection(config)
    return {"success": success, "message": message}


def _to_response(c: dict, active_id: str | None) -> ConnectionResponse:
    excluded = {"password", "credentials_json", "oauth_refresh_token"}
    return ConnectionResponse(
        **{k: v for k, v in c.items() if k not in excluded},
        oauth_connected=bool(c.get("oauth_refresh_token")),
        is_active=(c["id"] == active_id),
    )


@router.post("/connections", response_model=ConnectionResponse)
async def create_connection(config: ConnectionConfig):
    conn_id = add_connection(config)
    return _to_response(get_connection(conn_id), get_active_connection_id())


@router.get("/connections", response_model=list[ConnectionResponse])
async def list_connections():
    active_id = get_active_connection_id()
    return [_to_response(c, active_id) for c in get_all_connections()]


@router.delete("/connections/{conn_id}")
async def remove_connection(conn_id: str):
    if not get_connection(conn_id):
        raise HTTPException(status_code=404, detail="Connection not found")
    delete_connection(conn_id)
    return {"success": True}


@router.post("/connections/{conn_id}/test")
async def test_saved_connection(conn_id: str):
    conn = get_connection(conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    config = ConnectionConfig(**conn)
    success, message = test_connection(config)
    return {"success": success, "message": message}


@router.post("/connections/{conn_id}/activate")
async def activate_connection(conn_id: str):
    if not get_connection(conn_id):
        raise HTTPException(status_code=404, detail="Connection not found")
    set_active_connection(conn_id)
    return {"success": True, "active_connection_id": conn_id}


# ── BigQuery OAuth flow ────────────────────────────────────────────────────────

def _bq_oauth_client_config() -> dict:
    client_id     = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise HTTPException(500, (
            "Google OAuth is not configured. "
            "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables."
        ))
    return {
        "web": {
            "client_id":     client_id,
            "client_secret": client_secret,
            "redirect_uris": [_bq_redirect_uri()],
            "auth_uri":      "https://accounts.google.com/o/oauth2/auth",
            "token_uri":     "https://oauth2.googleapis.com/token",
        }
    }


def _bq_redirect_uri() -> str:
    backend = os.environ.get("BACKEND_URL", "http://localhost:8000")
    return f"{backend.rstrip('/')}/api/database/bigquery/oauth/callback"


def _allow_http_for_local_dev():
    """oauthlib rejects non-HTTPS redirect URIs unless this env var is set."""
    backend = os.environ.get("BACKEND_URL", "http://localhost:8000")
    if backend.startswith("http://"):
        os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
    # Google may return scopes in a different order or add 'openid'; relax the check.
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")


@router.get("/bigquery/oauth/start")
async def bq_oauth_start(
    name:       str = Query(...),
    project_id: str = Query(...),
    dataset:    str = Query(...),
    conn_id:    str = Query(None),
):
    """Generate a Google OAuth URL and redirect the user's browser to it."""
    from google_auth_oauthlib.flow import Flow
    _allow_http_for_local_dev()

    # Build PKCE pair so we can carry the verifier across the two requests
    code_verifier  = secrets.token_urlsafe(96)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()

    flow = Flow.from_client_config(_bq_oauth_client_config(), scopes=_OAUTH_SCOPES)
    flow.redirect_uri = _bq_redirect_uri()

    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",          # always ask so we get a refresh token
        code_challenge=code_challenge,
        code_challenge_method="S256",
    )
    _oauth_states[state] = {
        "name": name, "project_id": project_id, "database": dataset,
        "conn_id": conn_id, "code_verifier": code_verifier,
    }
    return RedirectResponse(auth_url)


@router.get("/bigquery/oauth/callback")
async def bq_oauth_callback(request: Request, state: str = Query(...)):
    """Exchange the auth code for tokens, save the connection, redirect to the frontend."""
    from google_auth_oauthlib.flow import Flow
    _allow_http_for_local_dev()

    pending = _oauth_states.pop(state, None)
    if not pending:
        raise HTTPException(400, "Invalid or expired OAuth state. Please try connecting again.")

    try:
        flow = Flow.from_client_config(_bq_oauth_client_config(), scopes=_OAUTH_SCOPES, state=state)
        flow.redirect_uri = _bq_redirect_uri()
        # Pass the full callback URL so oauthlib can extract code + validate state
        flow.fetch_token(
            authorization_response=str(request.url),
            code_verifier=pending.get("code_verifier"),
        )
    except Exception as e:
        raise HTTPException(400, f"Google token exchange failed: {e}")

    refresh_token = flow.credentials.refresh_token
    if not refresh_token:
        raise HTTPException(400, "Google did not return a refresh token. Try disconnecting and reconnecting.")

    conn_id = pending.get("conn_id")
    if conn_id and get_connection(conn_id):
        update_connection(conn_id, {"oauth_refresh_token": refresh_token})
    else:
        config = ConnectionConfig(
            name=pending["name"],
            db_type="bigquery",
            project_id=pending["project_id"],
            database=pending["database"],
            oauth_refresh_token=refresh_token,
        )
        conn_id = add_connection(config)

    set_active_connection(conn_id)

    frontend = os.environ.get("FRONTEND_URL", "http://localhost:3000").split(",")[0].strip()
    return RedirectResponse(f"{frontend}/database-config?bq_connected=1")
