"""Structured application logger — writes to the log_entries SQLite table."""
import json
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from core.app_db import LogEntry, _Session

_MAX_ROWS = 10_000
_MAX_DAYS = 30


def log(
    level: str,
    category: str,
    message: str,
    user_email: Optional[str] = None,
    user_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    detail: Optional[dict] = None,
) -> None:
    """Write a log entry and rotate old entries if needed."""
    db = _Session()
    try:
        db.add(LogEntry(
            id=str(uuid.uuid4()),
            created_at=datetime.now(timezone.utc),
            level=level,
            category=category,
            message=message,
            user_email=user_email,
            user_id=user_id,
            duration_ms=duration_ms,
            detail=json.dumps(detail) if detail else None,
        ))
        db.commit()
        _rotate(db)
    except Exception:
        pass
    finally:
        db.close()


def _rotate(db) -> None:
    """Delete entries older than MAX_DAYS or beyond MAX_ROWS, whichever is larger."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=_MAX_DAYS)
    db.query(LogEntry).filter(LogEntry.created_at < cutoff).delete()

    total = db.query(LogEntry).count()
    if total > _MAX_ROWS:
        # Find the created_at of the Nth newest row and delete older ones
        cutoff_row = (
            db.query(LogEntry.created_at)
            .order_by(LogEntry.created_at.desc())
            .offset(_MAX_ROWS)
            .limit(1)
            .scalar()
        )
        if cutoff_row:
            db.query(LogEntry).filter(LogEntry.created_at <= cutoff_row).delete()

    db.commit()
