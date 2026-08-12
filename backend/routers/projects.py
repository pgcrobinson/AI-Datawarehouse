from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from core.app_db import get_db, User, Project, Design, DesignVersion, DesignTransform
from core.auth import get_current_user
from core.db import get_engine
from pydantic import BaseModel
from typing import Optional, Dict, List
import uuid
import re
import json
import os
from datetime import datetime, timezone

router = APIRouter()

SETTINGS_FILE = os.path.join(os.environ.get("DATA_DIR") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), "settings.json")


def _load_settings() -> dict:
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    return {}


def _assert_access(project: Project, user: User):
    if user.role == "sysadmin":
        return
    if user.org_id and project.org_id and user.org_id != project.org_id:
        raise HTTPException(403, "Not authorized")
    if project.user_id != user.id:
        raise HTTPException(403, "Not authorized")


def _strip_markdown_fences(sql: str) -> str:
    """Remove markdown code fences the AI sometimes wraps SQL in."""
    sql = re.sub(r'^```[a-zA-Z]*\s*', '', sql.strip(), flags=re.IGNORECASE)
    sql = re.sub(r'\s*```$', '', sql.strip(), flags=re.IGNORECASE)
    return sql.strip()


def _split_sql(sql: str) -> list:
    """Split T-SQL on GO batch separator, stripping any markdown fences first."""
    sql = _strip_markdown_fences(sql)
    batches = re.split(r'^\s*GO\s*$', sql, flags=re.IGNORECASE | re.MULTILINE)
    return [b.strip() for b in batches if b.strip()]


def _generate_mermaid_from_schema(engine) -> str:
    """Read live DB schema via INFORMATION_SCHEMA and build a Mermaid erDiagram — no AI tokens."""
    with engine.connect() as conn:
        tables = conn.execute(text("""
            SELECT TABLE_SCHEMA, TABLE_NAME
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        """)).fetchall()

        columns = conn.execute(text("""
            SELECT
                c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK,
                CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_FK
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA
                AND c.TABLE_NAME = pk.TABLE_NAME
                AND c.COLUMN_NAME = pk.COLUMN_NAME
            LEFT JOIN (
                SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
            ) fk ON c.TABLE_SCHEMA = fk.TABLE_SCHEMA
                AND c.TABLE_NAME = fk.TABLE_NAME
                AND c.COLUMN_NAME = fk.COLUMN_NAME
            ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
        """)).fetchall()

        fk_rows = conn.execute(text("""
            SELECT
                fk_cols.TABLE_SCHEMA, fk_cols.TABLE_NAME, fk_cols.COLUMN_NAME,
                pk_cols.TABLE_SCHEMA AS PK_SCHEMA, pk_cols.TABLE_NAME AS PK_TABLE
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk_cols
                ON rc.CONSTRAINT_NAME = fk_cols.CONSTRAINT_NAME
                AND fk_cols.ORDINAL_POSITION = 1
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk_cols
                ON rc.UNIQUE_CONSTRAINT_NAME = pk_cols.CONSTRAINT_NAME
                AND pk_cols.ORDINAL_POSITION = 1
        """)).fetchall()

    def _mtype(data_type: str) -> str:
        t = data_type.lower()
        if t in ('int', 'bigint', 'smallint', 'tinyint'): return 'int'
        if t in ('float', 'real', 'decimal', 'numeric', 'money', 'smallmoney'): return 'float'
        if t == 'bit': return 'boolean'
        if t == 'date': return 'date'
        if t in ('datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'): return 'datetime'
        return 'string'

    # Group columns
    cols_by_table: dict = {}
    for col in columns:
        cols_by_table.setdefault((col[0], col[1]), []).append(col)

    # Disambiguate table names that appear in multiple schemas
    tbl_names = [t[1] for t in tables]
    dupes = {n for n in tbl_names if tbl_names.count(n) > 1}

    def _eid(schema: str, table: str) -> str:
        name = f"{schema}_{table}" if table in dupes else table
        return re.sub(r'[^A-Za-z0-9_]', '_', name)

    lines = ["erDiagram"]
    for schema, table in tables:
        eid = _eid(schema, table)
        lines.append(f"    {eid} {{")
        for col in cols_by_table.get((schema, table), []):
            _, _, col_name, data_type, is_pk, is_fk = col
            annotation = " PK" if is_pk else (" FK" if is_fk else "")
            safe = re.sub(r'[^A-Za-z0-9_]', '_', col_name)
            lines.append(f"        {_mtype(data_type)} {safe}{annotation}")
        lines.append("    }")

    seen: set = set()
    for fk_schema, fk_table, _, pk_schema, pk_table in fk_rows:
        key = (_eid(pk_schema, pk_table), _eid(fk_schema, fk_table))
        if key not in seen:
            seen.add(key)
            lines.append(f'    {key[0]} ||--o{{ {key[1]} : ""')

    return "\n".join(lines)


# Standard DIM_DATE DDL and ETL — system-managed, never regenerated by the AI.
# Both are fully conditional so re-running a build never fails if DIM_DATE already exists.
# Schema is passed at runtime so DIM_DATE lands in the same schema as the rest of the warehouse.

def _dim_date_ddl(schema: str = "dbo") -> str:
    return f"""\
-- DIM_DATE: created automatically — skipped if already present
IF OBJECT_ID(N'[{schema}].[DIM_DATE]', N'U') IS NULL
    CREATE TABLE [{schema}].[DIM_DATE] (
        [DateKey]    INT         NOT NULL,
        [Date]       DATE        NOT NULL,
        [Year]       INT         NOT NULL,
        [Quarter]    INT         NOT NULL,
        [Month]      INT         NOT NULL,
        [MonthName]  VARCHAR(20) NOT NULL,
        [Day]        INT         NOT NULL,
        [DayName]    VARCHAR(30) NOT NULL,
        [DayOfWeek]  INT         NOT NULL,
        [WeekOfYear] INT         NOT NULL,
        [IsWeekend]  BIT         NOT NULL DEFAULT (0),
        CONSTRAINT [PK_DIM_DATE_{schema}] PRIMARY KEY ([DateKey])
    )"""


def _dim_date_etl(schema: str = "dbo") -> str:
    return f"""\
-- DIM_DATE: populate date dimension 2000-01-01 to 2050-12-31 — skipped if already populated
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM [{schema}].[DIM_DATE])
BEGIN
    DECLARE @d DATE = '2000-01-01';
    WHILE @d <= '2050-12-31'
    BEGIN
        INSERT INTO [{schema}].[DIM_DATE] (
            [DateKey], [Date], [Year], [Quarter], [Month], [MonthName],
            [Day], [DayName], [DayOfWeek], [WeekOfYear], [IsWeekend]
        )
        VALUES (
            CONVERT(INT, FORMAT(@d, 'yyyyMMdd')),
            @d,
            YEAR(@d),
            DATEPART(QUARTER, @d),
            MONTH(@d),
            DATENAME(MONTH, @d),
            DAY(@d),
            DATENAME(WEEKDAY, @d),
            DATEPART(WEEKDAY, @d),
            DATEPART(ISO_WEEK, @d),
            CASE WHEN DATEPART(WEEKDAY, @d) IN (1, 7) THEN 1 ELSE 0 END
        );
        SET @d = DATEADD(DAY, 1, @d);
    END
END"""


# Keep old constants as aliases so any other callers don't break
_DIM_DATE_DDL = _dim_date_ddl()
_DIM_DATE_ETL = _dim_date_etl()


def _extract_create_table_refs(sql: str) -> list:
    """Return [(schema, table)] from CREATE TABLE statements."""
    return re.findall(
        r'CREATE\s+TABLE\s+(?:\[?(\w+)\]?\.)?\[?(\w+)\]?',
        sql, re.IGNORECASE
    )


def _fix_cte_placement(sql: str) -> str:
    """
    Fix the common AI mistake of placing WITH/CTEs AFTER the INSERT INTO column list.

    Wrong:   INSERT INTO t (a, b)\nWITH cte AS (...)\nSELECT ...
    Correct: ;WITH cte AS (...)\nINSERT INTO t (a, b)\nSELECT ...

    Strategy per GO-batch:
    1. Detect the wrong pattern with a quick regex.
    2. Find the INSERT INTO + column list end.
    3. Walk the remainder character-by-character tracking paren depth.
       The first SELECT at depth 0 is the main query SELECT.
    4. Restructure: preamble + ;WITH <ctes> + INSERT INTO (cols) + SELECT ...
    """
    batches = _split_sql(sql)
    fixed = []
    for batch in batches:
        fixed.append(_fix_batch_cte(batch))
    return '\nGO\n'.join(fixed)


def _fix_batch_cte(batch: str) -> str:
    # Quick check: does this batch have INSERT INTO ... ) \n WITH?
    quick = re.search(
        r'INSERT\s+INTO\s+\S+\s*\([^;]*?\)\s*\n\s*;?\s*WITH\b',
        batch, re.IGNORECASE
    )
    if not quick:
        return batch

    # Find the INSERT INTO header and its column-list closing paren
    m = re.search(
        r'(INSERT\s+INTO\s+(?:\[?\w+\]?\.)?(?:\[?\w+\]?))\s*(\([^)]*\))',
        batch, re.IGNORECASE
    )
    if not m:
        return batch

    insert_keyword = m.group(1).strip()   # INSERT INTO [schema].[table]
    col_list       = m.group(2).strip()   # (Col1, Col2, ...)
    preamble       = batch[:m.start()].rstrip()
    after_cols     = batch[m.end():].lstrip('\r\n')  # starts with WITH ...

    # Strip leading semicolon if present
    if after_cols.startswith(';'):
        after_cols = after_cols[1:].lstrip()

    # Walk after_cols tracking parenthesis depth to find the first top-level SELECT.
    # Top-level = depth 0 (CTE bodies are depth 1+, so their SELECTs won't match).
    depth = 0
    i = 0
    main_sel = -1
    while i < len(after_cols):
        ch = after_cols[i]
        # Skip single-line comments
        if ch == '-' and i + 1 < len(after_cols) and after_cols[i + 1] == '-':
            while i < len(after_cols) and after_cols[i] != '\n':
                i += 1
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif depth == 0 and after_cols[i:i + 6].upper() == 'SELECT':
            main_sel = i
            break
        i += 1

    if main_sel < 0:
        return batch  # Can't safely restructure

    cte_block  = after_cols[:main_sel].rstrip().rstrip(',').rstrip()
    select_sql = after_cols[main_sel:]

    parts = []
    if preamble:
        parts.append(preamble)
    # Remove any leading WITH from cte_block and re-add with ;WITH prefix
    cte_body = re.sub(r'^\s*WITH\s+', '', cte_block, count=1, flags=re.IGNORECASE)
    parts.append(f';WITH {cte_body}')
    parts.append(f'{insert_keyword}\n{col_list}')
    parts.append(select_sql.strip())

    return '\n'.join(parts)


def _is_constraint_stmt(s: str) -> bool:
    """True for ALTER TABLE … ADD CONSTRAINT statements (FK, CHECK, UNIQUE, etc.)."""
    return bool(re.search(
        r'ALTER\s+TABLE\s+\S+\s+(?:WITH\s+\S+\s+)?ADD\s+CONSTRAINT',
        s, re.IGNORECASE
    ))


def _is_index_stmt(s: str) -> bool:
    """True for CREATE [UNIQUE/CLUSTERED/NONCLUSTERED] INDEX statements."""
    return bool(re.search(
        r'CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s',
        s, re.IGNORECASE
    ))


def _fetch_columns(engine, schema: str, table: str) -> list:
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
                   c.CHARACTER_MAXIMUM_LENGTH,
                   CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND tc.TABLE_SCHEMA = :s AND tc.TABLE_NAME = :t
            ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = :s AND c.TABLE_NAME = :t
            ORDER BY c.ORDINAL_POSITION
        """), {"s": schema, "t": table})
        return [
            {"name": r[0], "type": r[1], "nullable": r[2] == "YES",
             "max_length": r[3], "is_pk": bool(r[4])}
            for r in result
        ]


def _build_source_schema_text(engine, source_tables: list) -> str:
    lines = []
    for t in source_tables:
        key = f"{t['schema_name']}.{t['table_name']}"
        try:
            cols = _fetch_columns(engine, t["schema_name"], t["table_name"])
            lines.append(f"Table: {key}")
            for c in cols:
                pk = " [PK]" if c["is_pk"] else ""
                nn = " NOT NULL" if not c["nullable"] else ""
                ln = f"({c['max_length']})" if c["max_length"] else ""
                lines.append(f"  {c['name']}: {c['type']}{ln}{nn}{pk}")
            lines.append("")
        except Exception as e:
            lines.append(f"Table: {key}  [schema fetch failed: {e}]")
            lines.append("")
    return "\n".join(lines).strip()


# ── Pydantic models ────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None


class DesignSave(BaseModel):
    name: str
    connection_id: Optional[str] = None
    target_schema: Optional[str] = None
    tables_json: Optional[str] = None
    prompt: Optional[str] = None
    narrative: Optional[str] = None
    mermaid_erd: Optional[str] = None
    sql_ddl: Optional[str] = None


class SQLUpdate(BaseModel):
    sql_ddl: str


class ETLUpdate(BaseModel):
    etl_sql: str


class NameUpdate(BaseModel):
    name: str


class ETLGenerateRequest(BaseModel):
    table_filters: Optional[Dict[str, str]] = None  # {"stg.Orders": "OrderDate >= '2024-01-01'"}


class TransformCreate(BaseModel):
    name: str
    description: Optional[str] = None
    transform_type: str = "sql"  # "sql" | "ai_extract"
    source_table: Optional[str] = None
    target_table: Optional[str] = None
    output_sql: Optional[str] = None
    config_json: Optional[str] = None


class TransformUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    transform_type: Optional[str] = None
    source_table: Optional[str] = None
    target_table: Optional[str] = None
    output_sql: Optional[str] = None
    config_json: Optional[str] = None


class TransformGenerateRequest(BaseModel):
    name: str
    description: str
    transform_type: str = "sql"
    source_table: Optional[str] = None
    source_columns: Optional[str] = None  # comma-separated
    target_table: Optional[str] = None


class BuildConfig(BaseModel):
    target_connection_id: str
    target_schema: Optional[str] = None  # overrides design.target_schema; both fall back to "dbo"
    drop_if_exists: bool = False
    table_filters: Optional[Dict[str, str]] = None
    include_keys: bool = True
    include_indexes: bool = True


class RunTransformsConfig(BaseModel):
    target_connection_id: str
    transform_ids: Optional[List[str]] = None   # None = run all
    row_limit_override: Optional[int] = None    # overrides config_json row_limit for ai_extract


class TableActionConfig(BaseModel):
    target_connection_id: str
    tables: list  # [{"schema": "dbo", "table": "FACT_ORDER_LINE"}]


class TargetConnConfig(BaseModel):
    target_connection_id: str


# ── Projects ───────────────────────────────────────────────────────────────────

@router.get("")
def list_projects(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.role == "sysadmin":
        rows = db.query(Project).all()
    elif user.org_id:
        rows = db.query(Project).filter(Project.org_id == user.org_id).all()
    else:
        rows = db.query(Project).filter(Project.user_id == user.id).all()
    return [
        {"id": p.id, "name": p.name, "description": p.description,
         "user_id": p.user_id, "org_id": p.org_id,
         "created_at": p.created_at, "design_count": len(p.designs)}
        for p in rows
    ]


@router.post("")
def create_project(body: ProjectCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = Project(
        id=str(uuid.uuid4()), name=body.name, description=body.description,
        user_id=user.id, org_id=user.org_id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name, "description": project.description,
            "user_id": project.user_id, "org_id": project.org_id,
            "created_at": project.created_at, "design_count": 0}


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    db.delete(project)
    db.commit()
    return {"success": True}


# ── Designs ────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/designs")
def list_designs(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    return [
        {"id": d.id, "name": d.name, "prompt": d.prompt,
         "created_at": d.created_at, "updated_at": d.updated_at}
        for d in project.designs
    ]


@router.post("/{project_id}/designs")
def save_design(project_id: str, body: DesignSave, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    now = datetime.now(timezone.utc)
    design = Design(
        id=str(uuid.uuid4()), project_id=project.id, name=body.name,
        connection_id=body.connection_id, target_schema=body.target_schema,
        tables_json=body.tables_json,
        prompt=body.prompt, narrative=body.narrative,
        mermaid_erd=body.mermaid_erd, sql_ddl=body.sql_ddl,
        created_at=now, updated_at=now,
    )
    db.add(design)
    db.commit()
    return {"id": design.id, "name": design.name}


@router.get("/{project_id}/designs/{design_id}")
def get_design(project_id: str, design_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    return {
        "id": design.id, "name": design.name, "prompt": design.prompt,
        "narrative": design.narrative, "mermaid_erd": design.mermaid_erd,
        "sql_ddl": design.sql_ddl, "etl_sql": design.etl_sql,
        "connection_id": design.connection_id, "target_schema": design.target_schema,
        "tables_json": design.tables_json,
        "created_at": design.created_at, "updated_at": design.updated_at,
    }


@router.delete("/{project_id}/designs/{design_id}")
def delete_design(project_id: str, design_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    db.delete(design)
    db.commit()
    return {"success": True}


# ── DDL SQL versioning ─────────────────────────────────────────────────────────

def _save_version(db: Session, design_id: str, sql: str, sql_type: str, user: User):
    next_num = (db.query(DesignVersion)
                .filter(DesignVersion.design_id == design_id,
                        DesignVersion.sql_type == sql_type)
                .count()) + 1
    db.add(DesignVersion(
        id=str(uuid.uuid4()), design_id=design_id,
        version_number=next_num, sql_type=sql_type,
        sql_ddl=sql, edited_by_id=user.id, edited_by_name=user.name,
        created_at=datetime.now(timezone.utc),
    ))


@router.patch("/{project_id}/designs/{design_id}/sql")
def update_sql(project_id: str, design_id: str, body: SQLUpdate,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    if design.sql_ddl:
        _save_version(db, design_id, design.sql_ddl, "ddl", user)
    design.sql_ddl = body.sql_ddl
    design.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"success": True, "updated_at": design.updated_at}


@router.get("/{project_id}/designs/{design_id}/versions")
def list_ddl_versions(project_id: str, design_id: str,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    versions = (db.query(DesignVersion)
                .filter(DesignVersion.design_id == design_id,
                        DesignVersion.sql_type == "ddl")
                .order_by(DesignVersion.version_number.desc()).all())
    return [{"id": v.id, "version_number": v.version_number,
             "edited_by_name": v.edited_by_name, "created_at": v.created_at}
            for v in versions]


@router.get("/{project_id}/designs/{design_id}/versions/{version_id}")
def get_ddl_version(project_id: str, design_id: str, version_id: str,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    v = db.query(DesignVersion).filter(
        DesignVersion.id == version_id, DesignVersion.design_id == design_id,
        DesignVersion.sql_type == "ddl"
    ).first()
    if not v:
        raise HTTPException(404, "Version not found")
    return {"id": v.id, "version_number": v.version_number, "sql_ddl": v.sql_ddl,
            "edited_by_name": v.edited_by_name, "created_at": v.created_at}


# ── Rename design ─────────────────────────────────────────────────────────────

@router.patch("/{project_id}/designs/{design_id}/name")
def rename_design(project_id: str, design_id: str, body: NameUpdate,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    design.name = name
    design.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"success": True, "name": design.name}


# ── ETL SQL ────────────────────────────────────────────────────────────────────

@router.patch("/{project_id}/designs/{design_id}/etl")
def update_etl(project_id: str, design_id: str, body: ETLUpdate,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    if design.etl_sql:
        _save_version(db, design_id, design.etl_sql, "etl", user)
    design.etl_sql = body.etl_sql
    design.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"success": True, "updated_at": design.updated_at}


@router.get("/{project_id}/designs/{design_id}/etl-versions")
def list_etl_versions(project_id: str, design_id: str,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    versions = (db.query(DesignVersion)
                .filter(DesignVersion.design_id == design_id,
                        DesignVersion.sql_type == "etl")
                .order_by(DesignVersion.version_number.desc()).all())
    return [{"id": v.id, "version_number": v.version_number,
             "edited_by_name": v.edited_by_name, "created_at": v.created_at}
            for v in versions]


@router.get("/{project_id}/designs/{design_id}/etl-versions/{version_id}")
def get_etl_version(project_id: str, design_id: str, version_id: str,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    v = db.query(DesignVersion).filter(
        DesignVersion.id == version_id, DesignVersion.design_id == design_id,
        DesignVersion.sql_type == "etl"
    ).first()
    if not v:
        raise HTTPException(404, "Version not found")
    return {"id": v.id, "version_number": v.version_number, "sql_ddl": v.sql_ddl,
            "edited_by_name": v.edited_by_name, "created_at": v.created_at}


@router.post("/{project_id}/designs/{design_id}/generate-etl")
def generate_etl(project_id: str, design_id: str, body: ETLGenerateRequest,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    if not design.sql_ddl:
        raise HTTPException(400, "No DDL SQL on this design — generate or save DDL first")
    if not design.tables_json:
        raise HTTPException(400, "No source table information on this design")

    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured")
    model = settings.get("model", "claude-opus-4-8")

    source_tables = json.loads(design.tables_json)
    source_engine = get_engine(design.connection_id) if design.connection_id else None

    source_schema_text = ""
    if source_engine:
        try:
            source_schema_text = _build_source_schema_text(source_engine, source_tables)
        except Exception as e:
            source_schema_text = f"[Could not fetch source schema: {e}]"
    else:
        source_schema_text = "\n".join(
            f"Table: {t['schema_name']}.{t['table_name']}" for t in source_tables
        )

    filters_text = ""
    if body.table_filters:
        filters_text = "\n".join(
            f"  {tbl}: WHERE {clause}"
            for tbl, clause in body.table_filters.items()
            if clause.strip()
        )

    target_schema = (design.target_schema or "dbo").strip()

    prompt = f"""You are a senior SQL Server database developer, ETL specialist, and data warehouse engineer with 15+ years of experience building Kimball-style dimensional warehouses on SQL Server and Azure SQL. You write flawless, production-ready T-SQL.

Source tables (existing data to load FROM):
{source_schema_text}

Target warehouse DDL (tables to load INTO):
{design.sql_ddl}
{f'''
Row filters to apply on source tables (add these WHERE clauses to the corresponding SELECT statements):
{filters_text}''' if filters_text else ''}

Generate complete T-SQL loading scripts that INSERT data from the source tables into the warehouse tables.

Rules:
- Output ONLY raw valid T-SQL — absolutely no markdown, no code fences (```), no explanations
- Target schema for all warehouse tables is [{target_schema}] — use this exact schema prefix on every INSERT INTO and JOIN reference to warehouse tables
- Load order: generate all DIM_ tables (excluding DIM_DATE) first, then FACT_ tables
- For IDENTITY columns, exclude them from INSERT column lists (SQL Server generates them automatically)
- For FK surrogate key lookups, JOIN to the relevant DIM_ table to get the surrogate key
- Include SET NOCOUNT ON at the top
- Use GO between each logical batch
- Apply any row filters listed above in the WHERE clause of the corresponding SELECT
- Comment each INSERT block with the source → target mapping

CTE syntax (CRITICAL — SQL Server strict requirement):
- When using Common Table Expressions (WITH ... AS), the WITH clause MUST come BEFORE the INSERT INTO statement.
- CORRECT syntax:
    ;WITH cte1 AS (
        SELECT ...
    ),
    cte2 AS (
        SELECT ...
    )
    INSERT INTO [{target_schema}].[TargetTable] ([Col1], [Col2])
    SELECT ... FROM cte1 JOIN cte2 ...
- WRONG — this causes a syntax error and must NEVER be written:
    INSERT INTO [{target_schema}].[TargetTable] ([Col1], [Col2])
    WITH cte1 AS (...)   -- WRONG: CTE after INSERT column list
    SELECT ...
- Always prefix the WITH keyword with a semicolon (;WITH) to safely terminate any prior statement.
- Every CTE block must be separated by a comma BEFORE the next CTE name, and the final CTE has NO trailing comma before INSERT INTO.

DIM_DATE population:
- DO NOT generate any INSERT statements for DIM_DATE — the system populates it automatically.
- Completely omit DIM_DATE from your output.
- DIM_DATE lives in the SAME target schema [{target_schema}]. Always reference it as [{target_schema}].[DIM_DATE].

NULL safety (CRITICAL — apply everywhere):
- Every DateKey column in every FACT or DIM table is NOT NULL. Source date columns may be NULL.
  Always wrap every date-key calculation with COALESCE so a NULL source date never propagates:
    COALESCE(CONVERT(INT, FORMAT(CAST(src.some_date AS DATE), 'yyyyMMdd')),
             (SELECT MIN(DateKey) FROM [{target_schema}].[DIM_DATE]))  AS SomeDateKey
  Apply this pattern to ALL DateKey columns in ALL INSERT statements without exception.
- When an unknown-member row in a dimension requires a DateKey FK value you MUST write it as a
  subquery — never use a hardcoded integer literal:
    (SELECT MIN(DateKey) FROM [{target_schema}].[DIM_DATE])
- For any NULLable FK source column that maps to a NOT NULL warehouse FK column (e.g. CustomerKey),
  always use COALESCE(lookup.SurrogateKey, <unknown_member_subquery>) to guarantee a non-NULL result."""

    try:
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=api_key)
        _MAX = {"claude-opus-4-8": 32000, "claude-opus-4-7": 32000}
        message = client.messages.create(
            model=model,
            max_tokens=_MAX.get(model, 16000),
            messages=[{"role": "user", "content": prompt}],
        )
        etl_sql = _strip_markdown_fences(message.content[0].text)

        # Auto-fix any INSERT INTO ... WITH CTE placement errors before saving
        etl_sql = _fix_cte_placement(etl_sql)

        # Strip any AI-generated DIM_DATE blocks and prepend the standard WHILE-loop ETL.
        # (The AI is told not to generate DIM_DATE, but this guards against it doing so anyway.)
        _stmts = _split_sql(etl_sql)
        _non_date = [
            s for s in _stmts
            if not re.search(r'INSERT\s+(?:INTO\s+)?\[?[^\n]*DIM_DATE', s, re.IGNORECASE)
        ]
        etl_sql = "\nGO\n".join([_dim_date_etl(target_schema)] + _non_date)

    except Exception as e:
        raise HTTPException(500, f"AI generation failed: {e}")

    # Save (versioning if existing)
    if design.etl_sql:
        _save_version(db, design_id, design.etl_sql, "etl", user)
    design.etl_sql = etl_sql
    design.updated_at = datetime.now(timezone.utc)
    db.commit()

    return {"etl_sql": etl_sql}


# ── Transforms ─────────────────────────────────────────────────────────────────

def _get_design_checked(project_id, design_id, db, user):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    return project, design


@router.get("/{project_id}/designs/{design_id}/transforms")
def list_transforms(project_id: str, design_id: str,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)
    return [
        {"id": t.id, "design_id": t.design_id, "name": t.name,
         "description": t.description, "transform_type": t.transform_type,
         "source_table": t.source_table, "target_table": t.target_table,
         "output_sql": t.output_sql, "config_json": t.config_json,
         "order_index": t.order_index,
         "created_at": t.created_at, "updated_at": t.updated_at}
        for t in design.transforms
    ]


@router.post("/{project_id}/designs/{design_id}/transforms")
def create_transform(project_id: str, design_id: str, body: TransformCreate,
                     db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)
    max_idx = max((t.order_index for t in design.transforms), default=-1)
    now = datetime.now(timezone.utc)
    t = DesignTransform(
        id=str(uuid.uuid4()), design_id=design.id,
        name=body.name.strip(), description=body.description,
        transform_type=body.transform_type,
        source_table=body.source_table, target_table=body.target_table,
        output_sql=body.output_sql, config_json=body.config_json,
        order_index=max_idx + 1,
        created_at=now, updated_at=now,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id, "name": t.name, "order_index": t.order_index}


@router.patch("/{project_id}/designs/{design_id}/transforms/{transform_id}")
def update_transform(project_id: str, design_id: str, transform_id: str,
                     body: TransformUpdate,
                     db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, _ = _get_design_checked(project_id, design_id, db, user)
    t = db.query(DesignTransform).filter(
        DesignTransform.id == transform_id, DesignTransform.design_id == design_id
    ).first()
    if not t:
        raise HTTPException(404, "Transform not found")
    if body.name is not None:
        t.name = body.name.strip()
    if body.description is not None:
        t.description = body.description
    if body.transform_type is not None:
        t.transform_type = body.transform_type
    if body.source_table is not None:
        t.source_table = body.source_table
    if body.target_table is not None:
        t.target_table = body.target_table
    if body.output_sql is not None:
        t.output_sql = body.output_sql
    if body.config_json is not None:
        t.config_json = body.config_json
    t.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"success": True}


@router.delete("/{project_id}/designs/{design_id}/transforms/{transform_id}")
def delete_transform(project_id: str, design_id: str, transform_id: str,
                     db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, _ = _get_design_checked(project_id, design_id, db, user)
    t = db.query(DesignTransform).filter(
        DesignTransform.id == transform_id, DesignTransform.design_id == design_id
    ).first()
    if not t:
        raise HTTPException(404, "Transform not found")
    db.delete(t)
    db.commit()
    return {"success": True}


@router.post("/{project_id}/designs/{design_id}/transforms/generate")
def generate_transform(project_id: str, design_id: str, body: TransformGenerateRequest,
                       db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)

    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured")
    model = settings.get("model", "claude-opus-4-8")

    # Fetch source schema if connection available
    source_schema_text = ""
    if design.connection_id and body.source_table:
        try:
            src_engine = get_engine(design.connection_id)
            parts = body.source_table.replace("[", "").replace("]", "").split(".")
            schema_name = parts[0] if len(parts) > 1 else "dbo"
            table_name = parts[-1]
            cols = _fetch_columns(src_engine, schema_name, table_name)
            source_schema_text = f"Table: {body.source_table}\n" + "\n".join(
                f"  {c['name']}: {c['type']}" + (" [PK]" if c["is_pk"] else "")
                for c in cols
            )
        except Exception:
            source_schema_text = f"Source table: {body.source_table}"
    elif body.source_table:
        source_schema_text = f"Source table: {body.source_table}"
        if body.source_columns:
            source_schema_text += f"\nColumns: {body.source_columns}"

    # Find the relevant DDL snippet for the target table
    target_ddl_text = ""
    if design.sql_ddl and body.target_table:
        tbl_plain = body.target_table.replace("[", "").replace("]", "").split(".")[-1]
        matches = re.findall(
            rf'CREATE\s+TABLE[^;]*?\[?{re.escape(tbl_plain)}\]?[^;]*?(?=\nGO|\Z)',
            design.sql_ddl, re.IGNORECASE | re.DOTALL
        )
        target_ddl_text = matches[0] if matches else f"Target table: {body.target_table}"

    try:
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=api_key)
        _MAX = {"claude-opus-4-8": 32000, "claude-opus-4-7": 32000}

        if body.transform_type == "sql":
            prompt = f"""You are a T-SQL expert. Generate a complete T-SQL INSERT...SELECT transform.

Source:
{source_schema_text}

Target table DDL:
{target_ddl_text or f"Target: {body.target_table}"}

What to do: {body.description}

Rules:
- Output ONLY raw valid T-SQL — no markdown, no code fences, no explanations
- Use GO between batches
- Include SET NOCOUNT ON
- Map source columns to target columns correctly
- Handle NULLs safely"""

            msg = client.messages.create(
                model=model, max_tokens=_MAX.get(model, 8000),
                messages=[{"role": "user", "content": prompt}]
            )
            output_sql = _strip_markdown_fences(msg.content[0].text)
            return {"output_sql": output_sql}

        else:  # ai_extract
            prompt = f"""You are a data extraction specialist. Given a description of what to extract
from text data using AI, generate an extraction configuration.

Source:
{source_schema_text}

Target table DDL:
{target_ddl_text or f"Target: {body.target_table}"}

What to extract: {body.description}

Generate a JSON configuration object with exactly these fields:
{{
  "source_key_column": "<the primary key or unique ID column from the source table>",
  "target_key_column": "<the column name in the target table that will hold the source key value, or omit if same as source_key_column>",
  "source_text_column": "<the column containing the text to analyse>",
  "prompt_template": "<a Claude prompt that includes {{{{text}}}} as a placeholder for the source text, instructs Claude to return ONLY a JSON object>",
  "response_array_key": "<if the prompt asks Claude to return multiple items per source row (e.g. multiple themes, topics, or entities), set this to the JSON key whose value is the array, e.g. 'themes'. Leave as empty string if only one object is returned per row.>",
  "output_fields": [
    {{"field_name": "<the exact JSON key name within each response object — plain key only, no dot notation, no array brackets>", "target_column": "<matching column name in target table>"}}
  ],
  "row_limit": 500
}}

Rules:
- Return ONLY the JSON object, no markdown, no explanation
- prompt_template must instruct the AI to return ONLY a JSON object (or an object with one array key if multiple items per row)
- field_name values MUST be the simple key name as it appears inside each response object — e.g. "theme_name", NOT "themes[].theme_name" or "themes.theme_name"
- If response_array_key is set (e.g. "themes"), then Claude returns {{{{"themes": [{{"theme_name": ..., ...}}]}}}} and field_name values are the keys inside each array item
- If response_array_key is empty, Claude returns a single flat object and field_name values are the top-level keys
- output_fields must map every extracted value to its target table column
- Be specific in prompt_template about expected JSON keys and their exact value formats"""

            msg = client.messages.create(
                model=model, max_tokens=2000,
                messages=[{"role": "user", "content": prompt}]
            )
            raw = _strip_markdown_fences(msg.content[0].text)
            # Validate it's valid JSON
            json.loads(raw)
            return {"config_json": raw}

    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON config: {e}")
    except Exception as e:
        raise HTTPException(500, f"AI generation failed: {e}")


# ── Generate target table DDL for a transform ────────────────────────────────────

class GenerateTargetDdlBody(BaseModel):
    pass  # no extra input needed — all info comes from the saved transform


@router.post("/{project_id}/designs/{design_id}/transforms/{transform_id}/generate-target-ddl")
def generate_target_ddl(project_id: str, design_id: str, transform_id: str,
                         db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)
    transform = db.query(DesignTransform).filter(
        DesignTransform.id == transform_id, DesignTransform.design_id == design_id
    ).first()
    if not transform:
        raise HTTPException(404, "Transform not found")

    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured")
    model = settings.get("model", "claude-opus-4-8")

    # Build description of output fields
    fields_text = ""
    source_key_col = "id"
    key_col_for_table = "SourceKey"
    if transform.transform_type == "ai_extract" and transform.config_json:
        cfg = json.loads(transform.config_json)
        fields = cfg.get("output_fields", [])
        target_key_col = cfg.get("target_key_column", "").strip()
        source_key_col = cfg.get("source_key_column", "id").strip()
        # Use target_key_column name if set, otherwise reuse source_key_column name
        key_col_for_table = target_key_col if target_key_col else source_key_col
        fields_text = "\n".join(
            f"  - {f['field_name']} → target column: [{f['target_column']}]"
            for f in fields
        )
    elif transform.transform_type == "sql" and transform.output_sql:
        fields_text = "(infer columns from the SQL transform description)"

    target_table = transform.target_table or "[dbo].[TargetTable]"
    tbl_plain = target_table.replace("[", "").replace("]", "").split(".")[-1]

    prompt = f"""You are a SQL Server database architect. Design an optimal CREATE TABLE statement for a data transform target table.

Transform name: {transform.name}
Transform description: {transform.description or "N/A"}
Transform type: {transform.transform_type}
Source key column: {source_key_col}
Target table: {target_table}

Output fields that will be inserted into this table:
{fields_text or "(no fields defined yet)"}

Design rules:
- Use exact table name: {target_table}
- First column: [{tbl_plain}Key] INT IDENTITY(1,1) NOT NULL as the surrogate primary key
- Second column: [{key_col_for_table}] INT NULL — this is the foreign key that links every row in this table back to its source record. It is REQUIRED for joining this table to the source in queries. Name it exactly [{key_col_for_table}].
- Then include all output fields with appropriate SQL Server types:
  NVARCHAR(100) for short names/categories, NVARCHAR(500) for descriptions,
  NVARCHAR(300) for text snippets, NVARCHAR(20) for short codes/polarity,
  FLOAT for confidence scores/decimals, INT for integer IDs/counts
- Make all extracted value columns NULL (they may not always be present)
- Add [CreatedAt] DATETIME2 NOT NULL CONSTRAINT DF_{tbl_plain}_CreatedAt DEFAULT GETDATE() as the last column
- Add PRIMARY KEY constraint on the first column only
- No foreign key constraints
- Output ONLY the raw CREATE TABLE statement — no markdown fences, no GO, no explanation"""

    try:
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=model, max_tokens=2000,
            messages=[{"role": "user", "content": prompt}]
        )
        ddl = _strip_markdown_fences(msg.content[0].text)
        return {"ddl": ddl}
    except Exception as e:
        raise HTTPException(500, f"DDL generation failed: {e}")


# ── Execute target table DDL on a target connection ───────────────────────────────

class CreateTargetTableBody(BaseModel):
    target_connection_id: str
    ddl: str


@router.post("/{project_id}/designs/{design_id}/transforms/{transform_id}/create-target-table")
def create_target_table_endpoint(project_id: str, design_id: str, transform_id: str,
                                  body: CreateTargetTableBody,
                                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, _ = _get_design_checked(project_id, design_id, db, user)
    transform = db.query(DesignTransform).filter(
        DesignTransform.id == transform_id, DesignTransform.design_id == design_id
    ).first()
    if not transform:
        raise HTTPException(404, "Transform not found")

    engine = get_engine(body.target_connection_id)
    if not engine:
        raise HTTPException(400, "Target connection not found")

    ddl = _strip_markdown_fences(body.ddl.strip())
    if not ddl:
        raise HTTPException(400, "DDL is empty")

    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(ddl))
        return {"success": True, "message": f"Table created successfully"}
    except Exception as e:
        raise HTTPException(400, f"Failed to create table: {e}")


# ── Refresh ERD from live DB schema (no AI) ──────────────────────────────────────

class RefreshErdBody(BaseModel):
    connection_id: str

@router.post("/{project_id}/designs/{design_id}/refresh-erd")
def refresh_erd_from_schema(project_id: str, design_id: str, body: RefreshErdBody,
                             db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)
    engine = get_engine(body.connection_id)
    if not engine:
        raise HTTPException(400, "Connection not found")
    try:
        mermaid_erd = _generate_mermaid_from_schema(engine)
        design.mermaid_erd = mermaid_erd
        design.updated_at = datetime.utcnow()
        db.commit()
        return {"mermaid_erd": mermaid_erd}
    except Exception as e:
        raise HTTPException(500, f"Failed to generate ERD from schema: {e}")


class CreateSchemaBody(BaseModel):
    connection_id: str
    schema_name: str


@router.post("/{project_id}/designs/{design_id}/create-schema")
def create_schema_on_db(project_id: str, design_id: str, body: CreateSchemaBody,
                        db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    import re
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", body.schema_name):
        raise HTTPException(400, "Invalid schema name — use letters, digits, and underscores only")
    _, design = _get_design_checked(project_id, design_id, db, user)
    engine = get_engine(body.connection_id)
    if not engine:
        raise HTTPException(400, "Connection not found")
    try:
        with engine.connect() as conn:
            # SQL Server: create schema if it doesn't already exist
            conn.execute(text(
                f"IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'{body.schema_name}') "
                f"EXEC('CREATE SCHEMA [{body.schema_name}]')"
            ))
            conn.commit()
        design.target_schema = body.schema_name
        design.updated_at = datetime.utcnow()
        db.commit()
        return {"success": True, "schema": body.schema_name}
    except Exception as e:
        raise HTTPException(500, f"Failed to create schema: {e}")


class DebugSqlBody(BaseModel):
    build_errors: List[str]
    sql_type: str = "both"  # "ddl" | "etl" | "both"


@router.post("/{project_id}/designs/{design_id}/debug-sql")
def debug_sql(project_id: str, design_id: str, body: DebugSqlBody,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _, design = _get_design_checked(project_id, design_id, db, user)
    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured")
    model = settings.get("model", "claude-opus-4-8")

    ddl = design.sql_ddl or ""
    etl = design.etl_sql or ""
    errors_text = "\n".join(f"- {e}" for e in body.build_errors if e.strip())

    sql_section = ""
    if body.sql_type in ("ddl", "both") and ddl:
        sql_section += f"\n\nCURRENT DDL SQL:\n```sql\n{ddl}\n```"
    if body.sql_type in ("etl", "both") and etl:
        sql_section += f"\n\nCURRENT ETL SQL:\n```sql\n{etl}\n```"

    prompt = f"""You are a senior SQL Server database developer and data warehouse specialist. Diagnose the following SQL Server build errors and return corrected SQL.

BUILD ERRORS:
{errors_text}{sql_section}

INSTRUCTIONS:
1. Identify the root cause of each error.
2. Return corrected SQL that fixes all errors.
3. Structure your response using EXACTLY these XML tags:

<DIAGNOSIS>
Brief plain-English explanation of each error and its cause (one bullet per error).
</DIAGNOSIS>
<FIXED_DDL>
Complete corrected DDL SQL (only include if DDL had errors, otherwise omit this tag entirely).
</FIXED_DDL>
<FIXED_ETL>
Complete corrected ETL SQL (only include if ETL had errors, otherwise omit this tag entirely).
</FIXED_ETL>

Rules for the fixed SQL:
- Output raw valid T-SQL only inside the tags — no markdown fences, no extra commentary
- Preserve all existing logic; only change what is broken
- Keep the same schema prefix that was already in use
- If an error is about a missing object, add the missing definition"""

    try:
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=api_key)
        _MAX = {"claude-opus-4-8": 32000, "claude-opus-4-7": 32000}
        message = client.messages.create(
            model=model,
            max_tokens=_MAX.get(model, 16000),
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text

        def _extract(tag: str) -> str:
            m = re.search(rf"<{tag}>(.*?)</{tag}>", raw, re.DOTALL)
            return m.group(1).strip() if m else ""

        return {
            "diagnosis": _extract("DIAGNOSIS"),
            "fixed_ddl": _extract("FIXED_DDL") or None,
            "fixed_etl": _extract("FIXED_ETL") or None,
        }
    except Exception as e:
        raise HTTPException(500, f"AI debug failed: {e}")


# ── Build (streaming NDJSON) ────────────────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/build")
def build_design(project_id: str, design_id: str, body: BuildConfig,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    if not design.sql_ddl:
        raise HTTPException(400, "No DDL SQL on this design")

    ddl_sql = design.sql_ddl
    etl_sql = design.etl_sql or ""
    _build_schema = (body.target_schema or design.target_schema or "dbo").strip()
    _all_ddl = _split_sql(ddl_sql)
    # Remove any DIM_DATE CREATE TABLE from user DDL — managed via _dim_date_ddl() instead
    _all_ddl = [s for s in _all_ddl
                if not re.search(r'CREATE\s+TABLE\s+(?:\[?\w+\]?\.)?\[?DIM_DATE\]?', s, re.IGNORECASE)]
    # Optionally exclude FK/check constraints and/or indexes from the initial build
    ddl_stmts = [s for s in _all_ddl
                 if (body.include_keys    or not _is_constraint_stmt(s))
                 and (body.include_indexes or not _is_index_stmt(s))]
    _raw_etl = _split_sql(etl_sql) if etl_sql else []

    # Reorder ETL batches so dependency chain is always satisfied:
    # 1. DIM_DATE population  — provides DateKey values for everything else
    # 2. Regular DIM inserts  — real dimension data
    # 3. Unknown-member inserts (IDENTITY_INSERT / WHERE NOT EXISTS blocks)
    #    — must run after DIM_DATE so (SELECT MIN(DateKey) FROM [schema].[DIM_DATE]) is non-NULL
    # 4. FACT inserts         — need DIM rows + unknown members present
    def _is_dim_date(s: str) -> bool:
        return bool(re.search(r'INSERT\s+(?:INTO\s+)?[^\n]*DIM_DATE', s, re.IGNORECASE))
    def _is_unknown_member(s: str) -> bool:
        return bool(re.search(r'SET\s+IDENTITY_INSERT|WHERE\s+NOT\s+EXISTS', s, re.IGNORECASE))
    def _is_fact(s: str) -> bool:
        return bool(re.search(r'INSERT\s+(?:INTO\s+)?[^\n]*FACT_', s, re.IGNORECASE))

    _etl_dim_date  = [s for s in _raw_etl if _is_dim_date(s)]
    _etl_unknown   = [s for s in _raw_etl if not _is_dim_date(s) and _is_unknown_member(s)]
    _etl_fact      = [s for s in _raw_etl if not _is_dim_date(s) and not _is_unknown_member(s) and _is_fact(s)]
    _etl_dim_other = [s for s in _raw_etl if not _is_dim_date(s) and not _is_unknown_member(s) and not _is_fact(s)]
    etl_stmts = _etl_dim_date + _etl_dim_other + _etl_unknown + _etl_fact

    table_refs = _extract_create_table_refs(ddl_sql)

    # Fetch transforms before entering the generator (session can't be used inside StreamingResponse)
    _transforms_rows = (db.query(DesignTransform)
                        .filter(DesignTransform.design_id == design_id)
                        .order_by(DesignTransform.order_index).all())
    transforms = [
        {"id": t.id, "name": t.name, "transform_type": t.transform_type,
         "source_table": t.source_table, "target_table": t.target_table,
         "output_sql": t.output_sql, "config_json": t.config_json}
        for t in _transforms_rows
    ]
    _build_settings = _load_settings()

    def _e(step: str, status: str, message: str) -> str:
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        yield _e("Initialise", "info",
                 f"DDL: {len(ddl_stmts)} statement(s) · ETL: {len(etl_stmts)} statement(s)")

        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return

        tables_created = 0
        rows_affected = 0

        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")

                # ── Phase 1: Schemas ──────────────────────────────────────────
                schemas = {s for s, _ in table_refs if s}
                for schema in schemas:
                    try:
                        conn.execute(text(
                            f"IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'{schema}') "
                            f"EXEC sp_executesql N'CREATE SCHEMA [{schema}]'"
                        ))
                        yield _e(f"Schema [{schema}]", "ok", "Ready")
                    except Exception as ex:
                        yield _e(f"Schema [{schema}]", "warn", str(ex))

                # ── Phase 2: Drop existing ────────────────────────────────────
                if body.drop_if_exists:
                    yield _e("── Drop phase ──", "info", "Dropping existing tables")
                    for schema, table in reversed(table_refs):
                        full = f"[{schema}].[{table}]" if schema else f"[{table}]"
                        obj_id = f"{schema}.{table}" if schema else table
                        try:
                            conn.execute(text(
                                f"IF OBJECT_ID(N'{obj_id}', 'U') IS NOT NULL DROP TABLE {full}"
                            ))
                            yield _e(f"DROP {full}", "ok", "Dropped")
                        except Exception as ex:
                            yield _e(f"DROP {full}", "warn", str(ex))

                # ── Phase 3a: DIM_DATE ────────────────────────────────────────
                # Always ensure DIM_DATE exists before user DDL (FK constraints reference it).
                # The statement is conditional so it's a no-op if DIM_DATE already exists.
                try:
                    conn.execute(text(_dim_date_ddl(_build_schema)))
                    yield _e("DIM_DATE", "ok", f"Date dimension ready in [{_build_schema}] (created or already existed)")
                except Exception as ex:
                    yield _e("DIM_DATE", "warn", f"Could not ensure DIM_DATE: {ex}")

                # ── Phase 3b: DDL ─────────────────────────────────────────────
                yield _e("── DDL phase ──", "info",
                         f"Creating {len(table_refs)} table(s)")
                for stmt in ddl_stmts:
                    label = stmt[:90].replace("\n", " ").strip()
                    if len(stmt) > 90:
                        label += "…"
                    try:
                        conn.execute(text(stmt))
                        if re.match(r'\s*CREATE\s+TABLE', stmt, re.IGNORECASE):
                            tables_created += 1
                            tbl_match = re.search(
                                r'CREATE\s+TABLE\s+(?:\[?\w+\]?\.)?(\[?\w+\]?)',
                                stmt, re.IGNORECASE
                            )
                            tbl_name = tbl_match.group(1) if tbl_match else "table"
                            yield _e(f"CREATE {tbl_name}", "ok", "Table created")
                        else:
                            yield _e(label, "ok", "Executed")
                    except Exception as ex:
                        yield _e(label, "error", str(ex))

                # ── Phase 4: ETL ──────────────────────────────────────────────
                if etl_stmts:
                    yield _e("── ETL phase ──", "info",
                             f"Loading data — {len(etl_stmts)} batch(es)")

                    # Disable FK constraints on all warehouse tables so load order
                    # within DIM/FACT tables doesn't cause integrity violations.
                    for schema, table in table_refs:
                        full = f"[{schema}].[{table}]" if schema else f"[{table}]"
                        try:
                            conn.execute(text(f"ALTER TABLE {full} NOCHECK CONSTRAINT ALL"))
                        except Exception:
                            pass

                    etl_error = False
                    for stmt in etl_stmts:
                        label = stmt[:90].replace("\n", " ").strip()
                        if len(stmt) > 90:
                            label += "…"
                        try:
                            conn.execute(text(stmt))
                            # SET NOCOUNT ON suppresses rowcount in cursor.rowcount (-1),
                            # so query @@ROWCOUNT explicitly to get the real insert count.
                            try:
                                affected = conn.execute(text("SELECT @@ROWCOUNT")).scalar() or 0
                            except Exception:
                                affected = 0
                            rows_affected += affected
                            ins_match = re.search(
                                r'INSERT\s+(?:INTO\s+)?(?:\[?\w+\]?\.)?(\[?\w+\]?)',
                                stmt, re.IGNORECASE
                            )
                            tbl = ins_match.group(1) if ins_match else "batch"
                            yield _e(f"LOAD {tbl}", "ok", f"{affected} row(s) inserted")
                        except Exception as ex:
                            etl_error = True
                            yield _e(label, "error", str(ex))

                    # Re-enable FK constraints after all ETL statements have run.
                    for schema, table in table_refs:
                        full = f"[{schema}].[{table}]" if schema else f"[{table}]"
                        try:
                            conn.execute(text(f"ALTER TABLE {full} WITH CHECK CHECK CONSTRAINT ALL"))
                        except Exception as ex:
                            if not etl_error:
                                yield _e(f"FK check {full}", "warn",
                                         f"Constraint validation failed: {ex}")
                else:
                    yield _e("ETL phase", "info", "No ETL SQL — skipped. Generate ETL SQL to load data.")

                # ── Phase 5: Transforms ───────────────────────────────────────
                if transforms:
                    yield _e("── Transforms phase ──", "info",
                             f"Running {len(transforms)} transform(s)")
                    src_engine = get_engine(design.connection_id) if design.connection_id else None

                    for tr in transforms:
                        tname = tr["name"]
                        try:
                            if tr["transform_type"] == "sql" and tr["output_sql"]:
                                tr_rows = 0
                                for stmt in _split_sql(tr["output_sql"]):
                                    conn.execute(text(stmt))
                                    try:
                                        affected = conn.execute(text("SELECT @@ROWCOUNT")).scalar() or 0
                                        tr_rows += affected
                                    except Exception:
                                        pass
                                yield _e(f"Transform: {tname}", "ok",
                                         f"{tr_rows} row(s) affected")

                            elif tr["transform_type"] == "ai_extract" and tr["config_json"]:
                                cfg = json.loads(tr["config_json"])
                                key_col = cfg.get("source_key_column", "id")
                                text_col = cfg.get("source_text_column", "")
                                prompt_tmpl = cfg.get("prompt_template", "")
                                output_fields = cfg.get("output_fields", [])
                                row_limit = cfg.get("row_limit", 500)
                                src_tbl = tr.get("source_table", "")
                                tgt_tbl = tr.get("target_table", "")

                                if not src_engine:
                                    yield _e(f"Transform: {tname}", "error",
                                             "No source connection on design — set connection and retry")
                                    continue
                                if not text_col or not prompt_tmpl or not output_fields or not src_tbl:
                                    yield _e(f"Transform: {tname}", "error",
                                             "Incomplete AI extract config — regenerate the transform")
                                    continue

                                api_key_t = _build_settings.get("anthropic_api_key")
                                if not api_key_t:
                                    yield _e(f"Transform: {tname}", "error",
                                             "Anthropic API key not configured")
                                    continue

                                with src_engine.connect() as src_conn:
                                    source_rows = src_conn.execute(text(
                                        f"SELECT TOP {int(row_limit)} [{key_col}], [{text_col}]"
                                        f" FROM {src_tbl}"
                                    )).fetchall()

                                if not source_rows:
                                    yield _e(f"Transform: {tname}", "warn",
                                             "No rows found in source table")
                                    continue

                                yield _e(f"Transform: {tname}", "info",
                                         f"Extracting from {len(source_rows)} row(s) using AI…")

                                import anthropic as _anthropic
                                ai_client = _anthropic.Anthropic(api_key=api_key_t)
                                ai_model = _build_settings.get("model", "claude-opus-4-8")

                                target_key_col = cfg.get("target_key_column", "").strip()
                                response_array_key = cfg.get("response_array_key", "").strip()

                                if target_key_col:
                                    target_cols_list = [target_key_col] + [f["target_column"] for f in output_fields]
                                else:
                                    target_cols_list = [f["target_column"] for f in output_fields]
                                col_list = ", ".join(f"[{c}]" for c in target_cols_list)
                                placeholders = ", ".join(f":p{i}" for i in range(len(target_cols_list)))
                                insert_sql = f"INSERT INTO {tgt_tbl} ({col_list}) VALUES ({placeholders})"

                                inserted_t = 0
                                errors_t = 0
                                for src_row in source_rows:
                                    row_key = src_row[0]
                                    row_text = str(src_row[1]) if src_row[1] else ""
                                    try:
                                        ai_prompt = prompt_tmpl.replace("{text}", row_text)
                                        ai_msg = ai_client.messages.create(
                                            model=ai_model, max_tokens=2048,
                                            messages=[{"role": "user", "content": ai_prompt}]
                                        )
                                        raw_text = ai_msg.content[0].text if ai_msg.content else ""
                                        raw_json = _strip_markdown_fences(raw_text)
                                        if not raw_json:
                                            raise ValueError(f"Claude returned empty response (raw: {repr(raw_text[:200])})")
                                        extracted = json.loads(raw_json)
                                        # Support array responses: {"themes": [{...}, {...}]}
                                        if response_array_key and isinstance(extracted.get(response_array_key), list):
                                            rows_to_insert = extracted[response_array_key]
                                        else:
                                            rows_to_insert = [extracted]
                                        for row_data in rows_to_insert:
                                            if target_key_col:
                                                vals = [row_key] + [row_data.get(f["field_name"], "") for f in output_fields]
                                            else:
                                                vals = [row_data.get(f["field_name"], "") for f in output_fields]
                                            params = {f"p{i}": v for i, v in enumerate(vals)}
                                            conn.execute(text(insert_sql), params)
                                            inserted_t += 1
                                    except Exception as row_err:
                                        errors_t += 1
                                        if errors_t <= 3:
                                            yield _e(f"Transform: {tname}", "warn",
                                                     f"Row {row_key}: {row_err}")

                                yield _e(f"Transform: {tname}",
                                         "ok" if errors_t == 0 else "warn",
                                         f"{inserted_t} row(s) inserted, {errors_t} error(s)")
                            else:
                                yield _e(f"Transform: {tname}", "warn",
                                         "No SQL or config — generate the transform first")

                        except Exception as tr_ex:
                            yield _e(f"Transform: {tname}", "error", str(tr_ex))

        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))
            return

        status = "ok"
        yield _e("── Build complete ──", status,
                 f"{tables_created} table(s) created · {rows_affected} row(s) loaded")

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Run transforms only (streaming NDJSON) ────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/run-transforms")
def run_design_transforms(project_id: str, design_id: str, body: RunTransformsConfig,
                          db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")

    _transforms_rows = (db.query(DesignTransform)
                        .filter(DesignTransform.design_id == design_id)
                        .order_by(DesignTransform.order_index).all())
    all_transforms = [
        {"id": t.id, "name": t.name, "transform_type": t.transform_type,
         "source_table": t.source_table, "target_table": t.target_table,
         "output_sql": t.output_sql, "config_json": t.config_json}
        for t in _transforms_rows
    ]
    # Filter to requested subset if specified
    if body.transform_ids is not None:
        id_set = set(body.transform_ids)
        transforms = [t for t in all_transforms if t["id"] in id_set]
    else:
        transforms = all_transforms
    _row_limit_override = body.row_limit_override
    _build_settings = _load_settings()
    _design_connection_id = design.connection_id

    def _e(step: str, status: str, message: str) -> str:
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        if not transforms:
            yield _e("Transforms", "warn", "No transforms defined for this design")
            return

        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return

        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                yield _e("── Transforms ──", "info", f"Running {len(transforms)} transform(s)")
                src_engine = get_engine(_design_connection_id) if _design_connection_id else None

                for tr in transforms:
                    tname = tr["name"]
                    try:
                        if tr["transform_type"] == "sql" and tr["output_sql"]:
                            tr_rows = 0
                            for stmt in _split_sql(tr["output_sql"]):
                                conn.execute(text(stmt))
                                try:
                                    affected = conn.execute(text("SELECT @@ROWCOUNT")).scalar() or 0
                                    tr_rows += affected
                                except Exception:
                                    pass
                            yield _e(f"Transform: {tname}", "ok", f"{tr_rows} row(s) affected")

                        elif tr["transform_type"] == "ai_extract" and tr["config_json"]:
                            cfg = json.loads(tr["config_json"])
                            key_col = cfg.get("source_key_column", "id")
                            text_col = cfg.get("source_text_column", "")
                            prompt_tmpl = cfg.get("prompt_template", "")
                            output_fields = cfg.get("output_fields", [])
                            row_limit = _row_limit_override if _row_limit_override is not None else cfg.get("row_limit", 500)
                            src_tbl = tr.get("source_table", "")
                            tgt_tbl = tr.get("target_table", "")

                            if not src_engine:
                                yield _e(f"Transform: {tname}", "error",
                                         "No source connection on design — set connection and retry")
                                continue
                            if not text_col or not prompt_tmpl or not output_fields or not src_tbl:
                                yield _e(f"Transform: {tname}", "error",
                                         "Incomplete AI extract config — regenerate the transform")
                                continue

                            api_key_t = _build_settings.get("anthropic_api_key")
                            if not api_key_t:
                                yield _e(f"Transform: {tname}", "error",
                                         "Anthropic API key not configured")
                                continue

                            with src_engine.connect() as src_conn:
                                source_rows = src_conn.execute(text(
                                    f"SELECT TOP {int(row_limit)} [{key_col}], [{text_col}]"
                                    f" FROM {src_tbl}"
                                )).fetchall()

                            if not source_rows:
                                yield _e(f"Transform: {tname}", "warn", "No rows found in source table")
                                continue

                            yield _e(f"Transform: {tname}", "info",
                                     f"Extracting from {len(source_rows)} row(s) using AI…")

                            import anthropic as _anthropic
                            ai_client = _anthropic.Anthropic(api_key=api_key_t)
                            ai_model = _build_settings.get("model", "claude-opus-4-8")

                            target_key_col = cfg.get("target_key_column", "").strip()
                            response_array_key = cfg.get("response_array_key", "").strip()

                            if target_key_col:
                                target_cols_list = [target_key_col] + [f["target_column"] for f in output_fields]
                            else:
                                target_cols_list = [f["target_column"] for f in output_fields]
                            col_list = ", ".join(f"[{c}]" for c in target_cols_list)
                            placeholders = ", ".join(f":p{i}" for i in range(len(target_cols_list)))
                            insert_sql = f"INSERT INTO {tgt_tbl} ({col_list}) VALUES ({placeholders})"

                            inserted_t = 0
                            errors_t = 0
                            for src_row in source_rows:
                                row_key = src_row[0]
                                row_text = str(src_row[1]) if src_row[1] else ""
                                try:
                                    ai_prompt = prompt_tmpl.replace("{text}", row_text)
                                    ai_msg = ai_client.messages.create(
                                        model=ai_model, max_tokens=2048,
                                        messages=[{"role": "user", "content": ai_prompt}]
                                    )
                                    raw_text = ai_msg.content[0].text if ai_msg.content else ""
                                    raw_json = _strip_markdown_fences(raw_text)
                                    if not raw_json:
                                        raise ValueError(f"Claude returned empty response (raw: {repr(raw_text[:200])})")
                                    extracted = json.loads(raw_json)
                                    # Support array responses: {"themes": [{...}, {...}]}
                                    if response_array_key and isinstance(extracted.get(response_array_key), list):
                                        rows_to_insert = extracted[response_array_key]
                                    else:
                                        rows_to_insert = [extracted]
                                    for row_data in rows_to_insert:
                                        if target_key_col:
                                            vals = [row_key] + [row_data.get(f["field_name"], "") for f in output_fields]
                                        else:
                                            vals = [row_data.get(f["field_name"], "") for f in output_fields]
                                        params = {f"p{i}": v for i, v in enumerate(vals)}
                                        conn.execute(text(insert_sql), params)
                                        inserted_t += 1
                                except Exception as row_err:
                                    errors_t += 1
                                    if errors_t <= 3:
                                        yield _e(f"Transform: {tname}", "warn", f"Row {row_key}: {row_err}")

                            yield _e(f"Transform: {tname}",
                                     "ok" if errors_t == 0 else "warn",
                                     f"{inserted_t} row(s) inserted, {errors_t} error(s)")
                        else:
                            yield _e(f"Transform: {tname}", "warn",
                                     "No SQL or config — generate the transform first")

                    except Exception as tr_ex:
                        yield _e(f"Transform: {tname}", "error", str(tr_ex))

        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))
            return

        yield _e("── Transforms complete ──", "ok", f"{len(transforms)} transform(s) processed")

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Maintenance: truncate selected tables ──────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/truncate-tables")
def truncate_selected_tables(project_id: str, design_id: str, body: TableActionConfig,
                              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)

    def _e(step: str, status: str, message: str) -> str:
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        tables = body.tables  # [{"schema": "dbo", "table": "FACT_ORDER_LINE"}]
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                yield _e("── Truncate ──", "info",
                         f"Disabling FK constraints then truncating {len(tables)} table(s)")
                # Disable FK constraints on all selected tables first
                for t in tables:
                    full = f"[{t.get('schema', 'dbo')}].[{t['table']}]"
                    try:
                        conn.execute(text(f"ALTER TABLE {full} NOCHECK CONSTRAINT ALL"))
                    except Exception:
                        pass
                # Truncate each table
                truncated = 0
                for t in tables:
                    full = f"[{t.get('schema', 'dbo')}].[{t['table']}]"
                    try:
                        conn.execute(text(f"TRUNCATE TABLE {full}"))
                        truncated += 1
                        yield _e(f"TRUNCATE {full}", "ok", "Truncated")
                    except Exception as ex:
                        yield _e(f"TRUNCATE {full}", "error", str(ex))
                # Re-enable FK constraints
                for t in tables:
                    full = f"[{t.get('schema', 'dbo')}].[{t['table']}]"
                    try:
                        conn.execute(text(f"ALTER TABLE {full} CHECK CONSTRAINT ALL"))
                    except Exception:
                        pass
                yield _e("── Complete ──", "ok", f"{truncated} of {len(tables)} table(s) truncated")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Maintenance: drop selected tables ─────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/drop-tables")
def drop_selected_tables(project_id: str, design_id: str, body: TableActionConfig,
                          db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)

    def _e(step: str, status: str, message: str) -> str:
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        tables = body.tables
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                yield _e("── Drop ──", "info",
                         f"Removing FK constraints then dropping {len(tables)} table(s)")
                # Drop FK constraints that reference any selected table
                table_names_csv = ", ".join(f"'{t['table']}'" for t in tables)
                try:
                    fk_rows = conn.execute(text(f"""
                        SELECT SCHEMA_NAME(tp.schema_id) AS pschema,
                               tp.name AS ptable,
                               fk.name AS fkname
                        FROM sys.foreign_keys fk
                        INNER JOIN sys.tables tp ON fk.parent_object_id = tp.object_id
                        WHERE OBJECT_NAME(fk.referenced_object_id) IN ({table_names_csv})
                    """)).fetchall()
                    for row in fk_rows:
                        try:
                            conn.execute(text(
                                f"ALTER TABLE [{row[0]}].[{row[1]}] DROP CONSTRAINT [{row[2]}]"
                            ))
                            yield _e(f"DROP FK [{row[2]}]", "ok",
                                     f"Removed from [{row[0]}].[{row[1]}]")
                        except Exception as ex:
                            yield _e(f"DROP FK [{row[2]}]", "warn", str(ex))
                except Exception as ex:
                    yield _e("FK scan", "warn", str(ex))
                # Drop each table
                dropped = 0
                for t in tables:
                    schema = t.get("schema", "dbo")
                    table = t["table"]
                    full = f"[{schema}].[{table}]"
                    try:
                        conn.execute(text(
                            f"IF OBJECT_ID(N'{schema}.{table}', 'U') IS NOT NULL DROP TABLE {full}"
                        ))
                        dropped += 1
                        yield _e(f"DROP {full}", "ok", "Dropped")
                    except Exception as ex:
                        yield _e(f"DROP {full}", "error", str(ex))
                yield _e("── Complete ──", "ok", f"{dropped} of {len(tables)} table(s) dropped")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Add keys (FK/check constraints) ───────────────────────────────────────────

# ── Regenerate DDL ─────────────────────────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/regenerate-ddl")
def regenerate_ddl(project_id: str, design_id: str,
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from routers.design import SYSTEM_PROMPT
    import anthropic as _anthropic

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design:
        raise HTTPException(404, "Design not found")
    if not design.tables_json:
        raise HTTPException(400, "No source table information on this design")
    if not design.prompt:
        raise HTTPException(400, "No original prompt on this design — cannot regenerate")

    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "Anthropic API key not configured")
    model = settings.get("model", "claude-opus-4-8")

    source_tables = json.loads(design.tables_json)
    source_engine = get_engine(design.connection_id) if design.connection_id else None

    source_schema_text = ""
    if source_engine:
        try:
            source_schema_text = _build_source_schema_text(source_engine, source_tables)
        except Exception as e:
            source_schema_text = f"[Could not fetch source schema: {e}]"
    else:
        source_schema_text = "\n".join(
            f"Table: {t['schema_name']}.{t['table_name']}" for t in source_tables
        )

    user_prompt = f"""Source schema:
{source_schema_text}

Requirements:
{design.prompt}"""

    try:
        client = _anthropic.Anthropic(api_key=api_key)
        _MAX_TOKENS = {
            "claude-opus-4-8": 32000,
            "claude-opus-4-7": 32000,
            "claude-opus-4-6": 32000,
            "claude-haiku-4-5": 8192,
        }
        max_tokens = _MAX_TOKENS.get(model, 16000)

        message = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = message.content[0].text

        import re as _re
        ddl_match = _re.search(r'<SQL_DDL>(.*?)</SQL_DDL>', raw, _re.DOTALL)
        if not ddl_match:
            raise HTTPException(500, "AI response did not contain <SQL_DDL> block")

        new_ddl = ddl_match.group(1).strip()

        if design.sql_ddl:
            _save_version(db, design_id, design.sql_ddl, "ddl", user)
        design.sql_ddl = new_ddl
        design.updated_at = datetime.now(timezone.utc)
        db.commit()

        return {"sql_ddl": new_ddl}

    except _anthropic.APIError as e:
        raise HTTPException(500, f"AI API error: {e}")


# ── Add keys (FK/check constraints) ───────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/add-keys")
def add_keys(project_id: str, design_id: str, body: TargetConnConfig,
             db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design or not design.sql_ddl:
        raise HTTPException(404, "Design / DDL not found")

    key_stmts = [s for s in _split_sql(design.sql_ddl) if _is_constraint_stmt(s)]

    def _e(step, status, message):
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        yield _e("── Add Keys ──", "info", f"{len(key_stmts)} constraint(s) to apply")
        if not key_stmts:
            yield _e("No constraints", "warn", "No ALTER TABLE … ADD CONSTRAINT statements found in DDL")
            return
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                applied = 0
                for stmt in key_stmts:
                    label = stmt[:90].replace("\n", " ").strip()
                    if len(stmt) > 90:
                        label += "…"
                    try:
                        conn.execute(text(stmt))
                        applied += 1
                        yield _e(label, "ok", "Applied")
                    except Exception as ex:
                        yield _e(label, "warn", str(ex))
                yield _e("── Complete ──", "ok", f"{applied} of {len(key_stmts)} constraint(s) applied")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Add indexes ────────────────────────────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/add-indexes")
def add_indexes(project_id: str, design_id: str, body: TargetConnConfig,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design or not design.sql_ddl:
        raise HTTPException(404, "Design / DDL not found")

    index_stmts = [s for s in _split_sql(design.sql_ddl) if _is_index_stmt(s)]

    def _e(step, status, message):
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        yield _e("── Add Indexes ──", "info", f"{len(index_stmts)} index(es) to create")
        if not index_stmts:
            yield _e("No indexes", "warn", "No CREATE INDEX statements found in DDL")
            return
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                created = 0
                for stmt in index_stmts:
                    label = stmt[:90].replace("\n", " ").strip()
                    if len(stmt) > 90:
                        label += "…"
                    try:
                        conn.execute(text(stmt))
                        created += 1
                        yield _e(label, "ok", "Created")
                    except Exception as ex:
                        yield _e(label, "warn", str(ex))
                yield _e("── Complete ──", "ok", f"{created} of {len(index_stmts)} index(es) created")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Drop keys (FK/check constraints) ──────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/drop-keys")
def drop_keys(project_id: str, design_id: str, body: TargetConnConfig,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design or not design.sql_ddl:
        raise HTTPException(404, "Design / DDL not found")

    # Extract (table_ref, constraint_name) from ALTER TABLE … ADD CONSTRAINT statements
    constraints = []
    for s in _split_sql(design.sql_ddl):
        if _is_constraint_stmt(s):
            m = re.search(
                r'ALTER\s+TABLE\s+(\S+)\s+(?:WITH\s+\S+\s+)?ADD\s+CONSTRAINT\s+(\S+)',
                s, re.IGNORECASE
            )
            if m:
                constraints.append((m.group(1).strip(), m.group(2).strip()))

    def _e(step, status, message):
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        yield _e("── Drop Keys ──", "info", f"{len(constraints)} constraint(s) to drop")
        if not constraints:
            yield _e("No constraints", "warn", "No ALTER TABLE … ADD CONSTRAINT statements found in DDL")
            return
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                dropped = 0
                for table, constraint in constraints:
                    label = f"DROP CONSTRAINT {constraint}"
                    try:
                        conn.execute(text(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}"))
                        dropped += 1
                        yield _e(label, "ok", f"Dropped from {table}")
                    except Exception as ex:
                        yield _e(label, "warn", str(ex))
                yield _e("── Complete ──", "ok", f"{dropped} of {len(constraints)} constraint(s) dropped")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Drop indexes ───────────────────────────────────────────────────────────────

@router.post("/{project_id}/designs/{design_id}/drop-indexes")
def drop_indexes(project_id: str, design_id: str, body: TargetConnConfig,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    _assert_access(project, user)
    design = db.query(Design).filter(Design.id == design_id, Design.project_id == project_id).first()
    if not design or not design.sql_ddl:
        raise HTTPException(404, "Design / DDL not found")

    # Extract (table_ref, index_name) from CREATE INDEX statements
    indexes = []
    for s in _split_sql(design.sql_ddl):
        if _is_index_stmt(s):
            m = re.search(
                r'CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(\S+)\s+ON\s+(\S+)',
                s, re.IGNORECASE
            )
            if m:
                indexes.append((m.group(2).strip(), m.group(1).strip()))  # (table, index)

    def _e(step, status, message):
        return json.dumps({"step": step, "status": status, "message": message}) + "\n"

    def stream():
        yield _e("── Drop Indexes ──", "info", f"{len(indexes)} index(es) to drop")
        if not indexes:
            yield _e("No indexes", "warn", "No CREATE INDEX statements found in DDL")
            return
        engine = get_engine(body.target_connection_id)
        if not engine:
            yield _e("Connect", "error", "Target connection not found")
            return
        try:
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                yield _e("Connect", "ok", "Connected to target database")
                dropped = 0
                for table, index in indexes:
                    label = f"DROP INDEX {index}"
                    try:
                        conn.execute(text(f"DROP INDEX {index} ON {table}"))
                        dropped += 1
                        yield _e(label, "ok", f"Dropped from {table}")
                    except Exception as ex:
                        yield _e(label, "warn", str(ex))
                yield _e("── Complete ──", "ok", f"{dropped} of {len(indexes)} index(es) dropped")
        except Exception as ex:
            yield _e("Fatal error", "error", str(ex))

    return StreamingResponse(stream(), media_type="application/x-ndjson")
