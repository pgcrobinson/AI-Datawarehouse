"""Admin log viewer endpoints."""
import csv
import io
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.app_db import get_db, LogEntry
from core.auth import require_sysadmin

router = APIRouter()

_PAGE_SIZE = 100


@router.get("")
def list_logs(
    level: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    user_email: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
    _: object = Depends(require_sysadmin),
):
    q = db.query(LogEntry)

    if level:
        q = q.filter(LogEntry.level == level)
    if category:
        q = q.filter(LogEntry.category == category)
    if user_email:
        q = q.filter(LogEntry.user_email.ilike(f"%{user_email}%"))
    if search:
        q = q.filter(LogEntry.message.ilike(f"%{search}%"))
    if date_from:
        q = q.filter(LogEntry.created_at >= date_from)
    if date_to:
        q = q.filter(LogEntry.created_at <= date_to)

    total = q.count()
    entries = (
        q.order_by(LogEntry.created_at.desc())
        .offset((page - 1) * _PAGE_SIZE)
        .limit(_PAGE_SIZE)
        .all()
    )

    return {
        "total": total,
        "page": page,
        "page_size": _PAGE_SIZE,
        "entries": [_serialize(e) for e in entries],
    }


@router.delete("")
def clear_logs(
    db: Session = Depends(get_db),
    _: object = Depends(require_sysadmin),
):
    deleted = db.query(LogEntry).delete()
    db.commit()
    return {"deleted": deleted}


@router.get("/export")
def export_logs(
    level: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _: object = Depends(require_sysadmin),
):
    q = db.query(LogEntry)
    if level:
        q = q.filter(LogEntry.level == level)
    if category:
        q = q.filter(LogEntry.category == category)

    entries = q.order_by(LogEntry.created_at.desc()).limit(5000).all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp", "level", "category", "user", "message", "duration_ms", "detail"])
    for e in entries:
        writer.writerow([
            e.created_at.isoformat() if e.created_at else "",
            e.level, e.category,
            e.user_email or "",
            e.message,
            e.duration_ms or "",
            e.detail or "",
        ])

    buf.seek(0)
    filename = f"app_logs_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/stats")
def log_stats(
    db: Session = Depends(get_db),
    _: object = Depends(require_sysadmin),
):
    total = db.query(LogEntry).count()
    by_level = {
        r[0]: r[1]
        for r in db.query(LogEntry.level, db.query(LogEntry).filter(LogEntry.level == LogEntry.level).count.__class__).all()
    }
    # simpler approach
    info  = db.query(LogEntry).filter(LogEntry.level == "info").count()
    warn  = db.query(LogEntry).filter(LogEntry.level == "warn").count()
    error = db.query(LogEntry).filter(LogEntry.level == "error").count()

    cats = db.query(LogEntry.category, LogEntry.id).all()
    category_counts: dict[str, int] = {}
    for row in db.query(LogEntry.category).all():
        category_counts[row[0]] = category_counts.get(row[0], 0) + 1

    return {
        "total": total,
        "by_level": {"info": info, "warn": warn, "error": error},
        "by_category": category_counts,
    }


def _serialize(e: LogEntry) -> dict:
    return {
        "id": e.id,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "level": e.level,
        "category": e.category,
        "message": e.message,
        "user_email": e.user_email,
        "duration_ms": e.duration_ms,
        "detail": json.loads(e.detail) if e.detail else None,
    }
