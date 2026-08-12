from pydantic import BaseModel
from typing import Optional, List, Any
from enum import Enum
import uuid


class DbType(str, Enum):
    azure_sql  = "azure_sql"
    bigquery   = "bigquery"
    snowflake  = "snowflake"
    databricks = "databricks"


class AuthType(str, Enum):
    sql_server = "sql_server"
    windows    = "windows"


class ConnectionConfig(BaseModel):
    name: str
    db_type: DbType = DbType.azure_sql

    # Azure SQL
    server:    Optional[str] = None
    database:  Optional[str] = None
    auth_type: AuthType = AuthType.sql_server
    username:  Optional[str] = None
    password:  Optional[str] = None
    port:      int = 1433

    # Snowflake extras
    warehouse:   Optional[str] = None
    schema_name: Optional[str] = None

    # Databricks extras
    http_path: Optional[str] = None

    # BigQuery extras
    project_id:           Optional[str] = None
    credentials_json:     Optional[str] = None  # service-account JSON string
    oauth_refresh_token:  Optional[str] = None  # OAuth flow refresh token


class ConnectionResponse(BaseModel):
    id:       str
    name:     str
    db_type:  DbType = DbType.azure_sql

    server:    Optional[str] = None
    database:  Optional[str] = None
    auth_type: AuthType = AuthType.sql_server
    username:  Optional[str] = None
    port:      int = 1433

    warehouse:   Optional[str] = None
    schema_name: Optional[str] = None
    http_path:   Optional[str] = None
    project_id:      Optional[str] = None
    oauth_connected: bool = False  # True when a Google OAuth refresh token is stored

    is_active: bool = False


class TestConnectionRequest(BaseModel):
    db_type: DbType = DbType.azure_sql

    server:    Optional[str] = None
    database:  Optional[str] = None
    auth_type: AuthType = AuthType.sql_server
    username:  Optional[str] = None
    password:  Optional[str] = None
    port:      int = 1433

    warehouse:        Optional[str] = None
    schema_name:      Optional[str] = None
    http_path:        Optional[str] = None
    project_id:       Optional[str] = None
    credentials_json: Optional[str] = None


class QueryRequest(BaseModel):
    sql: str
    connection_id: Optional[str] = None
    limit: int = 1000
    default_schema: Optional[str] = None


class QueryResult(BaseModel):
    columns: List[str]
    rows: List[List[Any]]
    row_count: int
    execution_time_ms: float
    error: Optional[str] = None


class TableInfo(BaseModel):
    schema_name: str
    table_name: str
    table_type: str


class ColumnInfo(BaseModel):
    column_name: str
    data_type: str
    is_nullable: bool
    max_length: Optional[int] = None
    is_primary_key: bool = False


class DesignTable(BaseModel):
    schema_name: str
    table_name: str


class DesignRequest(BaseModel):
    connection_id: Optional[str] = None
    tables: List[DesignTable]
    prompt: str
    target_schema: Optional[str] = None


class DesignResponse(BaseModel):
    narrative: str
    mermaid_erd: str
    sql_ddl: str


class AISettings(BaseModel):
    anthropic_api_key: Optional[str] = None
    model: str = "claude-opus-4-8"


class AISettingsResponse(BaseModel):
    masked_api_key: Optional[str] = None
    model: str = "claude-opus-4-8"
    has_api_key: bool = False
