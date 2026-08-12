from fastapi import APIRouter, HTTPException
from models.schemas import DesignRequest, DesignResponse
from core.db import get_engine
from sqlalchemy import text
import json
import os
import re

router = APIRouter()

SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "..", "settings.json")


def _load_settings() -> dict:
    path = os.path.abspath(SETTINGS_FILE)
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {}


def _fetch_columns(engine, schema_name: str, table_name: str) -> list:
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
        return [
            {
                "name": row[0],
                "type": row[1],
                "nullable": row[2] == "YES",
                "max_length": row[3],
                "is_pk": bool(row[4]),
            }
            for row in result
        ]


def _build_schema_context(tables_data: dict) -> str:
    lines = []
    for table_key, columns in tables_data.items():
        lines.append(f"Table: {table_key}")
        for col in columns:
            pk = " [PK]" if col["is_pk"] else ""
            null = " NOT NULL" if not col["nullable"] else ""
            length = f"({col['max_length']})" if col["max_length"] else ""
            lines.append(f"  {col['name']}: {col['type']}{length}{null}{pk}")
        lines.append("")
    return "\n".join(lines).strip()


def _extract_tag(text: str, tag: str) -> str:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return match.group(1).strip() if match else ""


def _build_system_prompt(schema: str = "dbo") -> str:
    return f"""You are a senior data warehouse architect specialising in Kimball-style dimensional modelling.
Given a source schema and requirements, design an optimal star or snowflake schema warehouse.

Structure your response using exactly these XML tags — nothing before the first tag, nothing after the last:

<NARRATIVE>
3-4 plain-text paragraphs explaining your design decisions and rationale.
</NARRATIVE>
<MERMAID_ERD>
Valid Mermaid erDiagram source showing all FACT_ and DIM_ tables with their columns and relationships.
</MERMAID_ERD>
<SQL_DDL>
Complete T-SQL DDL for every warehouse table EXCEPT DIM_DATE (CREATE TABLE + ALTER TABLE constraints).
DIM_DATE is managed automatically by the system — do not generate its CREATE TABLE.
</SQL_DDL>

Rules:
- Prefix fact tables with FACT_, dimension tables with DIM_.
- Use INT IDENTITY(1,1) for all surrogate keys.
- All tables MUST use the schema [{schema}]. Every table reference is [{schema}].[TableName].
- Always include DIM_DATE in the MERMAID_ERD with these exact standard columns and all FK relationships
  to fact tables — but do NOT generate a CREATE TABLE for it in SQL_DDL:
    DIM_DATE {{
        int DateKey PK
        date Date
        int Year
        int Quarter
        int Month
        string MonthName
        int Day
        string DayName
        int DayOfWeek
        int WeekOfYear
        bit IsWeekend
    }}
- In mermaid_erd use erDiagram syntax, e.g.:  int FactSalesKey PK
- DDL structure — follow this order exactly:
  1. All CREATE TABLE statements first (EXCLUDING DIM_DATE), one per GO batch.
     - Define each table's PRIMARY KEY as an inline CONSTRAINT inside the CREATE TABLE body.
     - Do NOT add FOREIGN KEY clauses inside CREATE TABLE — no FK references inside the table body.
     - Do NOT put a trailing comma after the last column or constraint before the closing parenthesis.
  2. After all CREATE TABLE statements, add all FOREIGN KEY constraints as separate ALTER TABLE statements
     (INCLUDING the FKs that reference DIM_DATE — these are required):
     ALTER TABLE [{schema}].[FactTable] WITH CHECK ADD CONSTRAINT [FK_name] FOREIGN KEY ([col]) REFERENCES [{schema}].[DIM_DATE] ([DateKey])
     GO
  3. Separate every statement (CREATE TABLE and ALTER TABLE) with GO on its own line.
  4. Never put two SQL statements in the same GO batch."""


@router.post("/generate", response_model=DesignResponse)
async def generate_design(request: DesignRequest):
    settings = _load_settings()
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Anthropic API key not configured. Go to AI Settings first.",
        )
    model = settings.get("model", "claude-opus-4-8")

    engine = get_engine(request.connection_id)
    if not engine:
        raise HTTPException(status_code=400, detail="No active database connection.")

    tables_data: dict = {}
    try:
        for t in request.tables:
            key = f"{t.schema_name}.{t.table_name}"
            tables_data[key] = _fetch_columns(engine, t.schema_name, t.table_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Schema fetch failed: {e}")

    schema_context = _build_schema_context(tables_data)

    schema_name = (request.target_schema or "dbo").strip()

    user_prompt = f"""Source schema:
{schema_context}

Requirements:
{request.prompt}"""

    try:
        import anthropic as _anthropic

        client = _anthropic.Anthropic(api_key=api_key)
        _MAX_TOKENS: dict[str, int] = {
            "claude-opus-4-8": 32000,
            "claude-opus-4-7": 32000,
            "claude-opus-4-6": 32000,
            "claude-haiku-4-5": 8192,
        }
        max_tokens = _MAX_TOKENS.get(model, 16000)

        message = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=_build_system_prompt(schema_name),
            messages=[{"role": "user", "content": user_prompt}],
        )

        raw = message.content[0].text

        # If truncated, close any open tags so regex can still extract content
        if message.stop_reason == "max_tokens":
            for tag in ("SQL_DDL", "MERMAID_ERD", "NARRATIVE"):
                if f"<{tag}>" in raw and f"</{tag}>" not in raw:
                    raw += f"\n</{tag}>"

        narrative = _extract_tag(raw, "NARRATIVE")
        mermaid_erd = _extract_tag(raw, "MERMAID_ERD")
        sql_ddl = _extract_tag(raw, "SQL_DDL")

        if message.stop_reason == "max_tokens":
            trunc_note = "\n\n> **Note:** The response was truncated due to length. The SQL DDL may be incomplete — consider splitting into fewer tables."
            narrative = (narrative or "") + trunc_note

        if not narrative and not mermaid_erd and not sql_ddl:
            raise ValueError(f"Unexpected response format: {raw[:500]}")

        return DesignResponse(
            narrative=narrative,
            mermaid_erd=mermaid_erd,
            sql_ddl=sql_ddl,
        )

    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI generation failed: {e}")
