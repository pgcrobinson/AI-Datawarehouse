from fastapi import APIRouter, HTTPException
from models.schemas import QueryRequest, QueryResult, TableInfo, ColumnInfo
from core.db import get_engine, get_bq_client, get_connection, get_active_connection_id
from core.logger import log
from sqlalchemy import text
from pathlib import Path
import re
import time
import json

_DBT_WORKSPACE = Path(__file__).parent.parent / "dbt_workspace"

# Matches {{ ref('model_name') }} or {{ ref("model_name") }}
_REF_RE = re.compile(r"\{\{\s*ref\s*\(\s*['\"]([^'\"]+)['\"]\s*\)\s*\}\}", re.IGNORECASE)
# Matches {# ... #} Jinja block comments
_JINJA_COMMENT_RE = re.compile(r"\{#.*?#\}", re.DOTALL)


def _dbt_schema() -> str | None:
    meta = _DBT_WORKSPACE / ".meta.json"
    try:
        return json.loads(meta.read_text(encoding="utf-8")).get("default_schema") if meta.exists() else None
    except Exception:
        return None


def _resolve_refs(sql: str, schema: str) -> str:
    return _REF_RE.sub(lambda m: f"[{schema}].[{m.group(1)}]", sql)


def _qualify_table_names(sql: str, schema: str) -> str:
    def _replace(m: re.Match) -> str:
        kw, ref = m.group(1), m.group(2)
        if "." in ref:
            return m.group(0)
        name = ref.strip("[]")
        return f"{kw} [{schema}].[{name}]"

    pattern = re.compile(
        r"\b(FROM|JOIN|UPDATE|INTO)\s+"
        r"(\[?[A-Za-z_#][A-Za-z0-9_#]*\]?"
        r"(?:\s*\.\s*\[?[A-Za-z_#][A-Za-z0-9_#]*\]?)?)"
        r"(?!\s*\()",
        re.IGNORECASE,
    )
    return pattern.sub(_replace, sql)


# ── BigQuery helpers ──────────────────────────────────────────────────────────

def _bq_project(connection_id):
    conn_id = connection_id or get_active_connection_id()
    conn = get_connection(conn_id) if conn_id else None
    return (conn or {}).get("project_id", "")


def _bq_schema(client, connection_id) -> dict:
    project = _bq_project(connection_id)
    datasets = list(client.list_datasets(project=project or None))
    schemas = [ds.dataset_id for ds in datasets]

    tables = []
    for ds in datasets:
        for tbl in client.list_tables(ds.reference):
            tables.append(TableInfo(
                schema_name=ds.dataset_id,
                table_name=tbl.table_id,
                table_type=tbl.table_type,
            ))

    return {"schemas": schemas, "tables": [t.model_dump() for t in tables]}


def _bq_columns(client, schema_name: str, table_name: str, connection_id) -> dict:
    project = _bq_project(connection_id)
    table_ref = f"{project}.{schema_name}.{table_name}" if project else f"{schema_name}.{table_name}"
    table = client.get_table(table_ref)

    columns = [
        ColumnInfo(
            column_name=f.name,
            data_type=f.field_type,
            is_nullable=(f.mode != "REQUIRED"),
            max_length=None,
            is_primary_key=False,
        )
        for f in table.schema
    ]
    return {"columns": [c.model_dump() for c in columns]}


def _bq_execute(client, request: QueryRequest) -> QueryResult:
    start = time.time()
    try:
        job = client.query(request.sql)
        rows_iter = job.result()
        columns = [f.name for f in rows_iter.schema]
        rows = []
        for i, row in enumerate(rows_iter):
            if i >= request.limit:
                break
            rows.append([str(v) if v is not None else None for v in row.values()])
        elapsed = (time.time() - start) * 1000
        log("info", "query", f"BigQuery query — {len(rows)} rows",
            duration_ms=round(elapsed),
            detail={"connection_id": request.connection_id, "row_count": len(rows),
                    "sql_preview": request.sql[:120]})
        return QueryResult(columns=columns, rows=rows, row_count=len(rows),
                           execution_time_ms=round(elapsed, 2))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        log("error", "query", f"BigQuery query failed: {str(e)[:200]}",
            duration_ms=round(elapsed),
            detail={"connection_id": request.connection_id, "sql_preview": request.sql[:120]})
        return QueryResult(columns=[], rows=[], row_count=0,
                           execution_time_ms=round(elapsed, 2), error=str(e))


# ── Router ────────────────────────────────────────────────────────────────────

router = APIRouter()


@router.post("/execute", response_model=QueryResult)
async def execute_query(request: QueryRequest):
    bq = get_bq_client(request.connection_id)
    if bq:
        return _bq_execute(bq, request)

    engine = get_engine(request.connection_id)
    if not engine:
        raise HTTPException(status_code=400, detail="No active database connection")

    sql = _JINJA_COMMENT_RE.sub("", request.sql)

    if _REF_RE.search(sql):
        ref_schema = request.default_schema or _dbt_schema()
        if not ref_schema:
            return QueryResult(
                columns=[], rows=[], row_count=0, execution_time_ms=0,
                error="SQL contains {{ ref('...') }} but no schema is set — select a default schema in the toolbar.",
            )
        sql = _resolve_refs(sql, ref_schema)

    if request.default_schema:
        sql = _qualify_table_names(sql, request.default_schema)

    start = time.time()
    try:
        with engine.connect() as conn:
            result = conn.execute(text(sql))
            elapsed = (time.time() - start) * 1000

            if result.returns_rows:
                columns = list(result.keys())
                rows = [list(row) for row in result.fetchmany(request.limit)]
                elapsed = (time.time() - start) * 1000
                log("info", "query", f"Query executed — {len(rows)} rows",
                    duration_ms=round(elapsed),
                    detail={"connection_id": request.connection_id, "row_count": len(rows),
                            "sql_preview": sql[:120]})
                return QueryResult(columns=columns, rows=rows, row_count=len(rows),
                                   execution_time_ms=round(elapsed, 2))
            else:
                conn.commit()
                elapsed = (time.time() - start) * 1000
                log("info", "query", f"Statement executed — {result.rowcount} rows affected",
                    duration_ms=round(elapsed),
                    detail={"connection_id": request.connection_id, "sql_preview": sql[:120]})
                return QueryResult(columns=[], rows=[], row_count=result.rowcount,
                                   execution_time_ms=round(elapsed, 2))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        log("error", "query", f"Query failed: {str(e)[:200]}",
            duration_ms=round(elapsed),
            detail={"connection_id": request.connection_id, "sql_preview": sql[:120]})
        return QueryResult(columns=[], rows=[], row_count=0,
                           execution_time_ms=round(elapsed, 2), error=str(e))


@router.get("/schema")
async def get_schema(connection_id: str = None):
    bq = get_bq_client(connection_id)
    if bq:
        try:
            return _bq_schema(bq, connection_id)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    engine = get_engine(connection_id)
    if not engine:
        raise HTTPException(status_code=400, detail="No active database connection")

    try:
        with engine.connect() as conn:
            schemas_result = conn.execute(
                text("SELECT DISTINCT TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA")
            )
            schemas = [row[0] for row in schemas_result]

            tables_result = conn.execute(text("""
                SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
                FROM INFORMATION_SCHEMA.TABLES
                ORDER BY TABLE_SCHEMA, TABLE_NAME
            """))
            tables = [
                TableInfo(schema_name=row[0], table_name=row[1], table_type=row[2])
                for row in tables_result
            ]

        return {"schemas": schemas, "tables": [t.model_dump() for t in tables]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/schema/{schema_name}/{table_name}/columns")
async def get_columns(schema_name: str, table_name: str, connection_id: str = None):
    bq = get_bq_client(connection_id)
    if bq:
        try:
            return _bq_columns(bq, schema_name, table_name, connection_id)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    engine = get_engine(connection_id)
    if not engine:
        raise HTTPException(status_code=400, detail="No active database connection")

    try:
        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT
                    c.COLUMN_NAME,
                    c.DATA_TYPE,
                    c.IS_NULLABLE,
                    c.CHARACTER_MAXIMUM_LENGTH,
                    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN (
                    SELECT ku.COLUMN_NAME
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                        ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                      AND tc.TABLE_SCHEMA = :schema
                      AND tc.TABLE_NAME = :table
                ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
                WHERE c.TABLE_SCHEMA = :schema AND c.TABLE_NAME = :table
                ORDER BY c.ORDINAL_POSITION
            """), {"schema": schema_name, "table": table_name})

            columns = [
                ColumnInfo(
                    column_name=row[0],
                    data_type=row[1],
                    is_nullable=row[2] == "YES",
                    max_length=row[3],
                    is_primary_key=bool(row[4]),
                )
                for row in result
            ]

        return {"columns": [c.model_dump() for c in columns]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
