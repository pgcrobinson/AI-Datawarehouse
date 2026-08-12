"""
Orchestration — schedule and monitor dbt model runs.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone
import json, uuid, os, subprocess, shutil, threading

router = APIRouter()

# ── storage ───────────────────────────────────────────────────────────────────

_PROJECTS_DIR = Path(os.environ.get("DATA_DIR") or Path(__file__).parent.parent) / "dbt_projects"
_DATA_DIR     = Path(os.environ.get("DATA_DIR") or Path(__file__).parent.parent)
_ORCH_DIR     = _DATA_DIR / "orchestration"
_SCHED_FILE   = _ORCH_DIR / "schedules.json"
_RUNS_FILE    = _ORCH_DIR / "runs.json"
_MAX_RUNS     = 1000

_lock = threading.Lock()


def _ensure():
    _ORCH_DIR.mkdir(parents=True, exist_ok=True)


def _load_schedules() -> list:
    try:
        return json.loads(_SCHED_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_schedules(s: list):
    _ensure()
    _SCHED_FILE.write_text(json.dumps(s, indent=2, default=str), encoding="utf-8")


def _load_runs() -> list:
    try:
        return json.loads(_RUNS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_runs(runs: list):
    _ensure()
    runs = sorted(runs, key=lambda r: r.get("started_at", ""), reverse=True)[:_MAX_RUNS]
    _RUNS_FILE.write_text(json.dumps(runs, indent=2, default=str), encoding="utf-8")


# ── APScheduler ───────────────────────────────────────────────────────────────

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.start()
    _HAS_SCHED = True
except ImportError:
    _scheduler = None
    _HAS_SCHED = False


def _next_run(cron: str, tz: str = "UTC") -> Optional[str]:
    if not _HAS_SCHED:
        return None
    try:
        trigger = CronTrigger.from_crontab(cron, timezone=tz)
        nxt = trigger.get_next_fire_time(None, datetime.now(timezone.utc))
        return nxt.isoformat() if nxt else None
    except Exception:
        return None


def _workspace(project_id: str) -> Path:
    return _PROJECTS_DIR / project_id


def _project_meta(project_id: str) -> dict:
    meta_path = _workspace(project_id) / ".meta.json"
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


# ── run execution ─────────────────────────────────────────────────────────────

def _execute_run(schedule_id: str, triggered_by: str = "schedule"):
    with _lock:
        schedules = _load_schedules()
        sch = next((s for s in schedules if s["id"] == schedule_id), None)
        if not sch:
            return
        if triggered_by == "schedule" and not sch.get("enabled", True):
            return

    run_id    = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()

    run: dict = {
        "id":            run_id,
        "schedule_id":   schedule_id,
        "schedule_name": sch.get("name", ""),
        "project_id":    sch.get("project_id", ""),
        "command":       sch.get("command", "run"),
        "select":        sch.get("select"),
        "status":        "running",
        "started_at":    started_at,
        "finished_at":   None,
        "duration_s":    None,
        "log":           "",
        "return_code":   None,
        "triggered_by":  triggered_by,
    }

    with _lock:
        runs = _load_runs()
        runs.insert(0, run)
        _save_runs(runs)
        schedules = _load_schedules()
        for s in schedules:
            if s["id"] == schedule_id:
                s["last_run_at"] = started_at
                s["last_run_status"] = "running"
        _save_schedules(schedules)

    # Build and execute the dbt command
    try:
        ws      = _workspace(sch["project_id"])
        dbt_exe = shutil.which("dbt")
        if not dbt_exe:
            raise RuntimeError("dbt not found in PATH — install with: pip install dbt-sqlserver")
        if not (ws / "dbt_project.yml").exists():
            raise RuntimeError(f"dbt project not initialised at {ws}")

        # Refresh profiles.yml so latest connection creds are used
        from core.db import get_connection
        meta    = _project_meta(sch["project_id"])
        conn_id = meta.get("connection_id")
        if conn_id:
            conn = get_connection(conn_id)
            if conn:
                from routers.datastudio import _write_profiles
                _write_profiles(conn, meta.get("default_schema", "dbo"), meta.get("slug", "project"), sch["project_id"])

        cmd = [dbt_exe, sch["command"], "--profiles-dir", str(ws), "--no-use-colors"]
        if sch.get("select"):
            cmd += ["--select", sch["select"]]

        proc = subprocess.run(
            cmd, cwd=str(ws),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=7200,
        )
        log = proc.stdout or ""
        rc  = proc.returncode
        status = "success" if rc == 0 else "failed"

    except Exception as e:
        log    = str(e)
        rc     = -1
        status = "failed"

    finished_at = datetime.now(timezone.utc).isoformat()
    try:
        duration = (
            datetime.fromisoformat(finished_at) - datetime.fromisoformat(started_at)
        ).total_seconds()
    except Exception:
        duration = None

    with _lock:
        runs = _load_runs()
        for r in runs:
            if r["id"] == run_id:
                r["status"]      = status
                r["finished_at"] = finished_at
                r["duration_s"]  = duration
                r["log"]         = log
                r["return_code"] = rc
        _save_runs(runs)

        schedules = _load_schedules()
        for s in schedules:
            if s["id"] == schedule_id:
                s["last_run_at"]     = started_at
                s["last_run_status"] = status
                if s.get("enabled"):
                    s["next_run_at"] = _next_run(s["cron"], s.get("timezone", "UTC"))
        _save_schedules(schedules)


def _register(sch: dict):
    if not _HAS_SCHED or _scheduler is None:
        return
    job_id = f"orch_{sch['id']}"
    try:
        _scheduler.remove_job(job_id)
    except Exception:
        pass
    if sch.get("enabled", True):
        try:
            tz = sch.get("timezone", "UTC")
            trigger = CronTrigger.from_crontab(sch["cron"], timezone=tz)
            _scheduler.add_job(
                _execute_run, trigger=trigger,
                id=job_id, args=[sch["id"]],
                replace_existing=True,
                misfire_grace_time=300,
            )
        except Exception as e:
            print(f"[orchestration] Failed to register schedule {sch['id']}: {e}")


def init_scheduler():
    """Called at app startup — reloads all enabled schedules into APScheduler."""
    for sch in _load_schedules():
        if sch.get("enabled"):
            _register(sch)


# ── pydantic models ───────────────────────────────────────────────────────────

class ScheduleCreate(BaseModel):
    name:       str
    project_id: str
    command:    str = "run"
    select:     Optional[str] = None
    cron:       str
    timezone:   str = "UTC"
    enabled:    bool = True


class ScheduleUpdate(BaseModel):
    name:     Optional[str]  = None
    command:  Optional[str]  = None
    select:   Optional[str]  = None
    cron:     Optional[str]  = None
    timezone: Optional[str]  = None
    enabled:  Optional[bool] = None


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("/schedules")
def list_schedules():
    schedules = _load_schedules()
    # Refresh next_run_at on every list call so countdowns stay accurate
    changed = False
    for s in schedules:
        if s.get("enabled"):
            nxt = _next_run(s.get("cron", ""), s.get("timezone", "UTC"))
            if nxt != s.get("next_run_at"):
                s["next_run_at"] = nxt
                changed = True
    if changed:
        _save_schedules(schedules)
    return schedules


@router.post("/schedules")
def create_schedule(payload: ScheduleCreate):
    sch_id = str(uuid.uuid4())
    now    = datetime.now(timezone.utc).isoformat()
    sch = {
        "id":              sch_id,
        "name":            payload.name,
        "project_id":      payload.project_id,
        "command":         payload.command,
        "select":          payload.select,
        "cron":            payload.cron,
        "timezone":        payload.timezone,
        "enabled":         payload.enabled,
        "created_at":      now,
        "last_run_at":     None,
        "last_run_status": None,
        "next_run_at":     _next_run(payload.cron, payload.timezone) if payload.enabled else None,
    }
    schedules = _load_schedules()
    schedules.append(sch)
    _save_schedules(schedules)
    _register(sch)
    return sch


@router.put("/schedules/{sch_id}")
def update_schedule(sch_id: str, payload: ScheduleUpdate):
    schedules = _load_schedules()
    for s in schedules:
        if s["id"] == sch_id:
            if payload.name     is not None: s["name"]     = payload.name
            if payload.command  is not None: s["command"]  = payload.command
            if payload.select   is not None: s["select"]   = payload.select
            if payload.timezone is not None: s["timezone"] = payload.timezone
            if payload.enabled  is not None: s["enabled"]  = payload.enabled
            tz = s.get("timezone", "UTC")
            if payload.cron is not None:
                s["cron"]        = payload.cron
                s["next_run_at"] = _next_run(payload.cron, tz) if s.get("enabled") else None
            elif payload.enabled is not None:
                s["next_run_at"] = _next_run(s["cron"], tz) if s["enabled"] else None
            _save_schedules(schedules)
            _register(s)
            return s
    raise HTTPException(404, "Schedule not found")


@router.delete("/schedules/{sch_id}")
def delete_schedule(sch_id: str):
    schedules = [s for s in _load_schedules() if s["id"] != sch_id]
    _save_schedules(schedules)
    if _HAS_SCHED and _scheduler:
        try:
            _scheduler.remove_job(f"orch_{sch_id}")
        except Exception:
            pass
    return {"ok": True}


@router.post("/schedules/{sch_id}/toggle")
def toggle_schedule(sch_id: str):
    schedules = _load_schedules()
    for s in schedules:
        if s["id"] == sch_id:
            s["enabled"]     = not s.get("enabled", True)
            s["next_run_at"] = _next_run(s["cron"], s.get("timezone", "UTC")) if s["enabled"] else None
            _save_schedules(schedules)
            _register(s)
            return s
    raise HTTPException(404, "Schedule not found")


@router.post("/schedules/{sch_id}/trigger")
def trigger_schedule(sch_id: str):
    sch = next((s for s in _load_schedules() if s["id"] == sch_id), None)
    if not sch:
        raise HTTPException(404, "Schedule not found")
    threading.Thread(target=_execute_run, args=[sch_id, "manual"], daemon=True).start()
    return {"ok": True, "message": "Run triggered"}


@router.get("/runs")
def list_runs(
    limit:       int           = Query(100, le=500),
    status:      Optional[str] = None,
    schedule_id: Optional[str] = None,
):
    runs = _load_runs()
    if status:
        runs = [r for r in runs if r.get("status") == status]
    if schedule_id:
        runs = [r for r in runs if r.get("schedule_id") == schedule_id]
    return runs[:limit]


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    run = next((r for r in _load_runs() if r["id"] == run_id), None)
    if not run:
        raise HTTPException(404, "Run not found")
    return run


@router.get("/stats")
def get_stats():
    runs      = _load_runs()
    schedules = _load_schedules()

    today      = datetime.now(timezone.utc).date().isoformat()
    today_runs = [r for r in runs if (r.get("started_at") or "").startswith(today)]

    recent    = [r for r in runs[:100] if r.get("status") in ("success", "failed")]
    successes = [r for r in recent if r.get("status") == "success"]
    success_rate = round(len(successes) / len(recent) * 100, 1) if recent else None

    active     = [s for s in schedules if s.get("enabled")]
    upcoming   = sorted(
        [s for s in active if s.get("next_run_at")],
        key=lambda s: s["next_run_at"]
    )

    return {
        "runs_today":       len(today_runs),
        "runs_today_ok":    len([r for r in today_runs if r.get("status") == "success"]),
        "runs_today_fail":  len([r for r in today_runs if r.get("status") == "failed"]),
        "success_rate":     success_rate,
        "active_schedules": len(active),
        "total_schedules":  len(schedules),
        "next_run_at":      upcoming[0]["next_run_at"]   if upcoming else None,
        "next_run_name":    upcoming[0]["name"]          if upcoming else None,
        "scheduler_ok":     _HAS_SCHED,
    }
