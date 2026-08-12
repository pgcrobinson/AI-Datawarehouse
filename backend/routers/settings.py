from fastapi import APIRouter
from models.schemas import AISettings, AISettingsResponse
from core.logger import log
import json
import os

router = APIRouter()

_DATA_DIR = os.environ.get("DATA_DIR") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SETTINGS_FILE = os.path.join(_DATA_DIR, "settings.json")

_DEFAULT: dict = {"anthropic_api_key": None, "model": "claude-opus-4-8"}


def _load() -> dict:
    path = os.path.abspath(SETTINGS_FILE)
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return dict(_DEFAULT)


def _save(data: dict):
    path = os.path.abspath(SETTINGS_FILE)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _mask(key: str | None) -> str | None:
    if not key or len(key) < 8:
        return None
    return f"sk-ant-...{key[-4:]}"


@router.get("", response_model=AISettingsResponse)
async def get_settings():
    data = _load()
    key = data.get("anthropic_api_key")
    return AISettingsResponse(
        masked_api_key=_mask(key),
        model=data.get("model", "claude-opus-4-8"),
        has_api_key=bool(key),
    )


@router.post("", response_model=AISettingsResponse)
async def save_settings(payload: AISettings):
    data = _load()
    key_changed = payload.anthropic_api_key is not None
    if key_changed:
        data["anthropic_api_key"] = payload.anthropic_api_key
    data["model"] = payload.model
    _save(data)
    key = data.get("anthropic_api_key")
    if key_changed:
        log("info", "admin", f"AI settings updated — model: {payload.model}, API key {'set' if key else 'cleared'}",
            detail={"model": payload.model, "has_key": bool(key)})
    return AISettingsResponse(
        masked_api_key=_mask(key),
        model=data["model"],
        has_api_key=bool(key),
    )
