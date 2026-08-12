"""
Data Studio — dbt integration with support for multiple named dbt projects.
Projects are stored at backend/dbt_projects/{project_id}/.
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, Any, List
from core.db import get_connection, _best_odbc_driver
from core.logger import log
import subprocess, shutil, json, re, uuid, os, time, stat

router = APIRouter()

# ── storage layout ────────────────────────────────────────────────────────────
# backend/
#   dbt_projects/
#     index.json           ← [{id, name, slug, connection_id, default_schema}]
#     {project_id}/
#       dbt_project.yml
#       profiles.yml
#       .meta.json
#       models/  *.sql  *.config.json
#       snapshots/  *.sql  *.config.json

_PROJECTS_DIR = Path(os.environ.get("DATA_DIR") or Path(__file__).parent.parent) / "dbt_projects"
_INDEX = _PROJECTS_DIR / "index.json"


def _load_index() -> list[dict]:
    if not _INDEX.exists():
        return []
    try:
        return json.loads(_INDEX.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_index(projects: list[dict]):
    _PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _INDEX.write_text(json.dumps(projects, indent=2), encoding="utf-8")


def _workspace(project_id: str) -> Path:
    return _PROJECTS_DIR / project_id


def _rmtree(path: Path) -> None:
    """Delete a directory tree, handling read-only files (common with nested .git on Windows)."""
    def _force_writeable(func, fpath, _):
        os.chmod(fpath, stat.S_IWRITE)
        func(fpath)
    shutil.rmtree(path, onerror=_force_writeable)


def _find_dbt() -> Optional[str]:
    found = shutil.which("dbt")
    if found:
        return found
    # Also check alongside sys.executable (works when venv isn't on PATH)
    import sys
    scripts_dir = Path(sys.executable).parent
    for name in ("dbt.exe", "dbt"):
        candidate = scripts_dir / name
        if candidate.exists():
            return str(candidate)
    return None


def _project_meta(project_id: str) -> dict:
    ws = _workspace(project_id)

    # Standard format written by create_project
    p = ws / ".meta.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass

    # GitHub-linked projects use .dbt_meta.json
    p2 = ws / ".dbt_meta.json"
    if p2.exists():
        try:
            data = json.loads(p2.read_text(encoding="utf-8"))
            return {"slug": data.get("project_slug", ""), "connection_id": data.get("connection_id", "")}
        except Exception:
            pass

    # Fall back to the index
    for entry in _load_index():
        if entry["id"] == project_id:
            return entry

    return {}


def _get_bq_location(conn: dict) -> Optional[str]:
    """Return the BigQuery dataset location (e.g. 'europe-west2') for a connection."""
    try:
        from core.db import _create_bq_client
        from models.schemas import ConnectionConfig
        config = ConnectionConfig(**conn)
        client = _create_bq_client(config)
        dataset = conn.get("database")
        project = conn.get("project_id")
        if dataset and project:
            ds = client.get_dataset(f"{project}.{dataset}")
            return ds.location or None
    except Exception:
        pass
    return None


# Macro that makes +schema use the custom name directly instead of appending it.
_GENERATE_SCHEMA_NAME_MACRO = """\
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}
"""


def _update_model_target(ws: Path, slug: str, project_id: str, dataset: str):
    """Set +project / +schema in dbt_project.yml and write the schema-name macro override."""
    import yaml as _yaml
    path = ws / "dbt_project.yml"
    data = _yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    models = data.setdefault("models", {})
    slug_cfg = models.setdefault(slug, {})
    slug_cfg["+project"] = project_id
    if dataset:
        slug_cfg["+schema"] = dataset
    path.write_text(
        _yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    # Override generate_schema_name so +schema uses the name as-is (not prepended with target schema)
    macros_dir = ws / "macros"
    macros_dir.mkdir(exist_ok=True)
    (macros_dir / "generate_schema_name.sql").write_text(_GENERATE_SCHEMA_NAME_MACRO, encoding="utf-8")


def _clear_model_target(ws: Path, slug: str):
    """Remove cross-project overrides from dbt_project.yml and the macro override."""
    import yaml as _yaml
    path = ws / "dbt_project.yml"
    data = _yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    slug_cfg = data.get("models", {}).get(slug, {})
    slug_cfg.pop("+project", None)
    slug_cfg.pop("+schema", None)
    path.write_text(
        _yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    macro = ws / "macros" / "generate_schema_name.sql"
    if macro.exists():
        macro.unlink()


def _require_project(project_id: str) -> dict:
    project = next((p for p in _load_index() if p["id"] == project_id), None)
    if not project:
        raise HTTPException(404, f"Project {project_id!r} not found")
    return project


def _write_profiles(conn: dict, default_schema: str, slug: str, project_id: str):
    import yaml
    db_type = conn.get("db_type", "azure_sql")

    if db_type == "bigquery":
        output: dict = {
            "type": "bigquery",
            "project": conn.get("project_id") or "",
            "dataset": default_schema,
            "threads": 4,
            "timeout_seconds": 300,
        }
        # Auto-detect dataset location so dbt submits jobs to the right region
        location = _get_bq_location(conn)
        if location:
            output["location"] = location
        creds_json     = conn.get("credentials_json")
        refresh_token  = conn.get("oauth_refresh_token")
        if creds_json:
            output["method"] = "service-account-json"
            output["keyfile_json"] = json.loads(creds_json)
        elif refresh_token:
            output["method"]        = "oauth-secrets"
            output["refresh_token"] = refresh_token
            output["client_id"]     = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
            output["client_secret"] = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
            output["token_uri"]     = "https://oauth2.googleapis.com/token"
        else:
            output["method"] = "oauth"
    else:
        try:
            driver = _best_odbc_driver()
        except RuntimeError:
            driver = "ODBC Driver 17 for SQL Server"

        output = {
            "type": "sqlserver",
            "driver": driver,
            "server": conn.get("server", ""),
            "port": conn.get("port", 1433),
            "database": conn.get("database", ""),
            "schema": default_schema,
            "trust_cert": True,
            "encrypt": False,
        }
        if conn.get("auth_type") == "windows":
            output["windows_login"] = True
        else:
            output["username"] = conn.get("username", "")
            output["password"] = conn.get("password", "")
            output["authentication"] = "sql"

    profiles_yml = yaml.dump(
        {slug: {"target": "dev", "outputs": {"dev": output}}},
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
    )
    (_workspace(project_id) / "profiles.yml").write_text(profiles_yml, encoding="utf-8")


# ── project management ────────────────────────────────────────────────────────

@router.get("/projects")
def list_projects():
    projects = _load_index()
    return {
        "projects": [
            {
                **p,
                "initialized": (_workspace(p["id"]) / "dbt_project.yml").exists(),
            }
            for p in projects
        ],
        "dbt_installed": _find_dbt() is not None,
    }


class CreateProjectPayload(BaseModel):
    project_name: str
    connection_id: str
    default_schema: str = "dbo"


@router.post("/projects")
def create_project(payload: CreateProjectPayload):
    conn = get_connection(payload.connection_id)
    if not conn:
        raise HTTPException(400, "Connection not found")

    project_id = uuid.uuid4().hex[:8]
    slug = re.sub(r"[^a-z0-9_]", "_", payload.project_name.lower())

    ws = _workspace(project_id)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "models").mkdir(exist_ok=True)
    (ws / "snapshots").mkdir(exist_ok=True)

    dbt_project_yml = (
        f"name: '{slug}'\n"
        f"version: '1.0.0'\n"
        f"config-version: 2\n"
        f"\n"
        f"profile: '{slug}'\n"
        f"\n"
        f"model-paths: ['models']\n"
        f"snapshot-paths: ['snapshots']\n"
        f"target-path: 'target'\n"
        f"clean-targets:\n"
        f"  - target\n"
        f"\n"
        f"models:\n"
        f"  {slug}:\n"
        f"    +materialized: table\n"
    )
    (ws / "dbt_project.yml").write_text(dbt_project_yml, encoding="utf-8")
    (ws / ".meta.json").write_text(json.dumps({
        "slug": slug,
        "connection_id": payload.connection_id,
        "default_schema": payload.default_schema,
    }), encoding="utf-8")
    _write_profiles(conn, payload.default_schema, slug, project_id)

    projects = _load_index()
    projects.append({
        "id": project_id,
        "name": payload.project_name,
        "slug": slug,
        "connection_id": payload.connection_id,
        "default_schema": payload.default_schema,
    })
    _save_index(projects)

    return {"id": project_id, "name": payload.project_name, "slug": slug}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    _require_project(project_id)
    ws = _workspace(project_id)
    if ws.exists():
        _rmtree(ws)
    _save_index([p for p in _load_index() if p["id"] != project_id])
    return {"ok": True}


# ── snapshot helpers ──────────────────────────────────────────────────────────

_SNAPSHOT_OPEN_RE  = re.compile(r"\{%-?\s*snapshot\s+\w+\s*-?%\}", re.IGNORECASE)
_SNAPSHOT_CLOSE_RE = re.compile(r"\{%-?\s*endsnapshot\s*-?%\}", re.IGNORECASE)


def _strip_snapshot_wrapper(content: str) -> str:
    content = _SNAPSHOT_OPEN_RE.sub("", content)
    content = _SNAPSHOT_CLOSE_RE.sub("", content)
    return content.strip()


def _build_snapshot_file(name: str, sql: str, cfg: dict) -> str:
    strategy      = cfg.get("strategy", "timestamp")
    unique_key    = cfg.get("unique_key", "id")
    target_schema = cfg.get("schema", "snapshots") or "snapshots"

    parts = [
        "        target_schema='" + target_schema + "'",
        "        unique_key='" + unique_key + "'",
        "        strategy='" + strategy + "'",
    ]
    if strategy == "timestamp":
        updated_at = cfg.get("updated_at", "updated_at") or "updated_at"
        parts.append("        updated_at='" + updated_at + "'")
    else:
        check_cols = cfg.get("check_cols", "")
        if check_cols:
            cols = ", ".join("'" + c.strip() + "'" for c in check_cols.split(",") if c.strip())
            parts.append("        check_cols=[" + cols + "]")
    if cfg.get("invalidate_hard_deletes"):
        parts.append("        invalidate_hard_deletes=True")

    config_str = ",\n".join(parts)
    return (
        "{%% snapshot %s %%}\n\n"
        "{{\n    config(\n%s\n    )\n}}\n\n"
        "%s\n\n"
        "{%% endsnapshot %%}\n"
    ) % (name, config_str, sql.strip())


# ── config block helpers ──────────────────────────────────────────────────────

_CONFIG_BLOCK_RE = re.compile(r"\{\{[\s\n]*config\s*\([^)]*\)[\s\n]*\}\}\s*\n?", re.IGNORECASE)


def _strip_config_block(sql: str) -> str:
    return _CONFIG_BLOCK_RE.sub("", sql).lstrip("\n")


def _build_config_block(cfg: dict) -> str:
    parts = [f"    materialized='{cfg.get('materialized', 'table')}'"]
    if cfg.get("materialized") == "incremental" and cfg.get("unique_key", "").strip():
        parts.append(f"    unique_key='{cfg['unique_key'].strip()}'")
    if cfg.get("schema", "").strip():
        parts.append(f"    schema='{cfg['schema'].strip()}'")
    if cfg.get("alias", "").strip():
        parts.append(f"    alias='{cfg['alias'].strip()}'")
    tags = cfg.get("tags", "").strip()
    if tags:
        tag_list = ", ".join(f"'{t.strip()}'" for t in tags.split(",") if t.strip())
        if tag_list:
            parts.append(f"    tags=[{tag_list}]")
    if cfg.get("pre_hook", "").strip():
        parts.append(f"    pre_hook='{cfg['pre_hook'].strip()}'")
    if cfg.get("post_hook", "").strip():
        parts.append(f"    post_hook='{cfg['post_hook'].strip()}'")
    return "{{\n  config(\n" + ",\n".join(parts) + "\n  )\n}}\n"


# ── model CRUD ────────────────────────────────────────────────────────────────

@router.get("/models")
def list_models(project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)
    result = []
    for stem, kind in [("models", "model"), ("snapshots", "snapshot")]:
        d = ws / stem
        if d.exists():
            result.extend({"name": f.stem, "type": kind} for f in sorted(d.glob("*.sql")))
    return {"models": sorted(result, key=lambda x: x["name"])}


@router.get("/models/{name}")
def get_model(name: str, project_id: str = Query(...), type: Optional[str] = None):
    _require_project(project_id)
    ws = _workspace(project_id)

    if type == "snapshot":
        subdirs = ("snapshots",)
    elif type == "model":
        subdirs = ("models",)
    else:
        subdirs = ("models", "snapshots")

    for subdir in subdirs:
        path = ws / subdir / f"{name}.sql"
        if path.exists():
            raw = path.read_text(encoding="utf-8")
            if subdir == "snapshots":
                sql = _strip_snapshot_wrapper(_strip_config_block(raw))
            else:
                sql = _strip_config_block(raw)
            config_path = ws / subdir / f"{name}.config.json"
            config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else None
            return {"name": name, "sql": sql, "config": config}
    raise HTTPException(404, "Model not found")


class SaveModelPayload(BaseModel):
    sql: str
    config: Optional[dict] = None


@router.put("/models/{name}")
def save_model(name: str, payload: SaveModelPayload, project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)

    safe = re.sub(r"[^a-z0-9_]", "_", name.lower().strip())
    if not safe:
        raise HTTPException(400, "Invalid model name")

    is_snapshot = (payload.config or {}).get("materialized") == "snapshot"
    subdir = "snapshots" if is_snapshot else "models"

    # Prevent a model and a snapshot sharing the same name
    other_subdir = "models" if is_snapshot else "snapshots"
    conflict = ws / other_subdir / f"{safe}.sql"
    if conflict.exists():
        other_type = "model" if is_snapshot else "snapshot"
        raise HTTPException(
            400,
            f"A {other_type} named '{safe}' already exists in this project. "
            f"Rename it before creating a {'snapshot' if is_snapshot else 'model'} with the same name.",
        )

    d = ws / subdir
    d.mkdir(parents=True, exist_ok=True)

    raw_sql = _strip_config_block(_strip_snapshot_wrapper(payload.sql))

    cfg = payload.config
    if cfg is not None:
        (d / f"{safe}.config.json").write_text(json.dumps(cfg), encoding="utf-8")
    else:
        existing = d / f"{safe}.config.json"
        cfg = json.loads(existing.read_text(encoding="utf-8")) if existing.exists() else None

    if is_snapshot and cfg:
        dbt_sql = _build_snapshot_file(safe, raw_sql, cfg)
    elif cfg:
        dbt_sql = _build_config_block(cfg) + "\n" + raw_sql
    else:
        dbt_sql = raw_sql
    (d / f"{safe}.sql").write_text(dbt_sql, encoding="utf-8")
    return {"success": True, "name": safe}


@router.delete("/models/{name}")
def delete_model(name: str, project_id: str = Query(...), type: Optional[str] = None):
    _require_project(project_id)
    ws = _workspace(project_id)

    if type == "snapshot":
        subdirs = ("snapshots",)
    elif type == "model":
        subdirs = ("models",)
    else:
        subdirs = ("models", "snapshots")
    for subdir in subdirs:
        for ext in (".sql", ".config.json"):
            p = ws / subdir / f"{name}{ext}"
            if p.exists():
                p.unlink()
    return {"success": True}


# ── schema.yml (dbt tests) ───────────────────────────────────────────────────

class SchemaSavePayload(BaseModel):
    version: int = 2
    models: List[Any] = []


@router.get("/schema")
def get_schema(project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)
    schema_file = ws / "models" / "schema.yml"
    if not schema_file.exists():
        return {"version": 2, "models": []}
    try:
        import yaml
        data = yaml.safe_load(schema_file.read_text(encoding="utf-8")) or {}
        return data if isinstance(data, dict) else {"version": 2, "models": []}
    except Exception as e:
        raise HTTPException(400, f"Could not parse schema.yml: {e}")


@router.put("/schema")
def save_schema(payload: SchemaSavePayload, project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)
    (ws / "models").mkdir(parents=True, exist_ok=True)
    schema_file = ws / "models" / "schema.yml"
    try:
        import yaml
        schema_file.write_text(
            yaml.dump(payload.model_dump(), default_flow_style=False,
                      allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, f"Could not save schema.yml: {e}")


# ── dbt command (streaming NDJSON) ────────────────────────────────────────────

class CommandPayload(BaseModel):
    command: str
    select: Optional[str] = None
    connection_id: Optional[str] = None
    write_connection_id: Optional[str] = None  # BigQuery cross-project write target


@router.post("/command")
def run_command(payload: CommandPayload, project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)

    if not (ws / "dbt_project.yml").exists():
        raise HTTPException(400, "dbt project not initialised")

    dbt_exe = _find_dbt()
    if not dbt_exe:
        conn_id = payload.connection_id
        conn = get_connection(conn_id) if conn_id else None
        db_type = (conn or {}).get("db_type", "azure_sql")
        adapter = "dbt-bigquery" if db_type == "bigquery" else "dbt-sqlserver"
        raise HTTPException(500, f"dbt not found — run: pip install {adapter}")

    meta = _project_meta(project_id)
    slug = meta.get("slug") or project_id

    write_conn = get_connection(payload.write_connection_id) if payload.write_connection_id else None
    cross_project = (
        write_conn
        and write_conn.get("db_type") == "bigquery"
        and payload.connection_id
    )

    if payload.connection_id:
        read_conn = get_connection(payload.connection_id)
        if read_conn:
            db_type = read_conn.get("db_type", "azure_sql")
            if db_type == "bigquery":
                # profiles.yml always points at the READ connection so that plain
                # "schema.table" SQL resolves against the source project
                default_schema = meta.get("default_schema") or read_conn.get("database") or ""
            else:
                default_schema = meta.get("default_schema") or "dbo"
            _write_profiles(read_conn, default_schema, slug, project_id)

    if cross_project:
        # Materialise models in the write project/dataset via dbt_project.yml overrides
        write_project = write_conn.get("project_id") or ""
        write_dataset = write_conn.get("database") or ""
        if write_project:
            _update_model_target(ws, slug, write_project, write_dataset)
    else:
        # Remove any leftover cross-project override
        _clear_model_target(ws, slug)

    cmd = [dbt_exe, payload.command, "--profiles-dir", str(ws), "--no-use-colors"]
    if payload.select:
        cmd += ["--select", payload.select]

    log("info", "dbt", f"dbt {payload.command}" + (f" --select {payload.select}" if payload.select else ""),
        detail={"project_id": project_id, "command": payload.command, "select": payload.select})

    def stream():
        start = time.time()
        try:
            with subprocess.Popen(
                cmd, cwd=str(ws),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            ) as proc:
                for line in proc.stdout:
                    yield json.dumps({"line": line.rstrip()}) + "\n"
                rc = proc.wait()
                elapsed = round((time.time() - start) * 1000)
                level = "info" if rc == 0 else "error"
                log(level, "dbt",
                    f"dbt {payload.command} {'succeeded' if rc == 0 else 'failed'} (exit {rc})",
                    duration_ms=elapsed,
                    detail={"project_id": project_id, "command": payload.command,
                            "select": payload.select, "return_code": rc})
                yield json.dumps({"done": True, "return_code": rc}) + "\n"
        except Exception as e:
            log("error", "dbt", f"dbt {payload.command} error: {str(e)[:200]}",
                detail={"project_id": project_id})
            yield json.dumps({"line": f"Error: {e}", "done": True, "return_code": 1}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── lineage ───────────────────────────────────────────────────────────────────

_LIN_REF_RE = re.compile(r"\{\{\s*ref\s*\(\s*['\"]([^'\"]+)['\"]\s*\)\s*\}\}", re.IGNORECASE)
# Any Jinja block: {{ }}, {% %}, {# #}
_LIN_JINJA_RE = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}", re.DOTALL)
# CTE alias names: foo AS (
_LIN_CTE_RE = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(', re.IGNORECASE)
# Direct FROM/JOIN table refs — excludes function calls via negative lookahead (?!\s*\()
_LIN_TABLE_RE = re.compile(
    r'\b(?:FROM|JOIN)\s+'
    r'(\[?[A-Za-z_#][A-Za-z0-9_#$]*\]?'
    r'(?:\s*\.\s*\[?[A-Za-z_#][A-Za-z0-9_#$]*\]?)?)'
    r'(?!\s*\()',
    re.IGNORECASE,
)
_LIN_SKIP = frozenset({
    "select", "values", "dual", "inserted", "deleted",
    "sys", "information_schema", "tempdb", "top", "percent",
})


def _extract_direct_sources(raw: str, known_lower: set) -> list:
    """
    Parse raw SQL for FROM/JOIN table references that are:
      - not inside a Jinja {{ }} / {% %} / {# #} block
      - not a CTE alias defined in the same query
      - not a known dbt model name
    Returns a list of 'schema.table' or 'table' strings.
    """
    jinja_spans = [(m.start(), m.end()) for m in _LIN_JINJA_RE.finditer(raw)]

    def in_jinja(pos):
        return any(s <= pos < e for s, e in jinja_spans)

    cte_names = {m.lower() for m in _LIN_CTE_RE.findall(raw)}

    def clean_ident(s):
        return s.strip().strip("[]")

    seen = set()
    result = []
    for m in _LIN_TABLE_RE.finditer(raw):
        if in_jinja(m.start()):
            continue
        raw_ref = m.group(1)
        if "." in raw_ref:
            parts = raw_ref.split(".", 1)
            ref_id = f"{clean_ident(parts[0])}.{clean_ident(parts[1])}"
        else:
            ref_id = clean_ident(raw_ref)

        ref_lower = ref_id.lower()
        if ref_lower in cte_names or ref_lower in known_lower or ref_lower in _LIN_SKIP:
            continue
        if ref_id not in seen:
            seen.add(ref_id)
            result.append(ref_id)
    return result


@router.get("/lineage")
def get_lineage(project_id: str = Query(...)):
    _require_project(project_id)
    ws = _workspace(project_id)

    nodes: dict[str, dict] = {}
    deps: dict[str, list] = {}
    raw_files: dict[str, str] = {}

    # Pass 1 — collect dbt models/snapshots with their {{ ref() }} dependencies
    for subdir, kind in [("models", "model"), ("snapshots", "snapshot")]:
        d = ws / subdir
        if not d.exists():
            continue
        for f in sorted(d.glob("*.sql")):
            name = f.stem
            raw = f.read_text(encoding="utf-8")
            display_sql = _strip_config_block(raw)
            if kind == "snapshot":
                display_sql = _strip_snapshot_wrapper(display_sql)
            jinja_refs = list(dict.fromkeys(_LIN_REF_RE.findall(raw)))
            nodes[name] = {"id": name, "name": name, "type": kind, "sql": display_sql.strip()}
            deps[name] = jinja_refs
            raw_files[name] = raw

    # Pass 2 — find direct FROM/JOIN table references not covered by ref()
    known_lower = {n.lower() for n in nodes}
    for name in list(nodes.keys()):
        for ref_id in _extract_direct_sources(raw_files.get(name, ""), known_lower):
            if ref_id not in nodes:
                nodes[ref_id] = {"id": ref_id, "name": ref_id, "type": "source", "sql": None}
                deps[ref_id] = []
            if ref_id not in deps[name]:
                deps[name].append(ref_id)

    # Pass 3 — any ref() target that isn't in the project becomes a source node
    for dep in {d for ref_list in deps.values() for d in ref_list}:
        if dep not in nodes:
            nodes[dep] = {"id": dep, "name": dep, "type": "source", "sql": None}
            deps[dep] = []

    edges = [
        {"source": dep, "target": name}
        for name, dep_list in deps.items()
        for dep in dep_list
    ]

    return {"nodes": list(nodes.values()), "edges": edges}


# ── legacy endpoints (kept for compatibility) ─────────────────────────────────

@router.get("/status")
def get_status():
    projects = _load_index()
    first = projects[0] if projects else None
    initialized = bool(first and (_workspace(first["id"]) / "dbt_project.yml").exists())
    return {
        "initialized": initialized,
        "dbt_installed": _find_dbt() is not None,
        "slug": first["slug"] if first else None,
        "connection_id": first["connection_id"] if first else None,
        "default_schema": first.get("default_schema", "dbo") if first else "dbo",
    }


class InitPayload(BaseModel):
    project_name: str
    connection_id: str
    default_schema: str = "dbo"


@router.post("/init")
def init_project(payload: InitPayload):
    return create_project(CreateProjectPayload(**payload.model_dump()))
