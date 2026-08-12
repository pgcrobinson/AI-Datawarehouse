from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from models.schemas import ConnectionConfig, AuthType, DbType
from typing import Any, Dict, Optional
import json
import os
import uuid
import pyodbc


def _best_odbc_driver() -> str:
    preferred = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "ODBC Driver 13 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server",
    ]
    installed = pyodbc.drivers()
    for driver in preferred:
        if driver in installed:
            return driver
    raise RuntimeError(
        f"No SQL Server ODBC driver found. Installed drivers: {installed}\n"
        "Download from: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server"
    )


_connections: Dict[str, dict] = {}
_active_connection_id: Optional[str] = None
_engines: Dict[str, Engine] = {}

_DATA_DIR = os.environ.get("DATA_DIR") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONNECTIONS_FILE = os.path.join(_DATA_DIR, "connections.json")


def _load_connections():
    global _connections, _active_connection_id
    path = os.path.abspath(CONNECTIONS_FILE)
    if os.path.exists(path):
        with open(path, "r") as f:
            data = json.load(f)
        if "connections" in data:
            _connections = data["connections"]
            _active_connection_id = data.get("active_id")
        else:
            _connections = data  # legacy flat format


def _save_connections():
    path = os.path.abspath(CONNECTIONS_FILE)
    with open(path, "w") as f:
        json.dump({"connections": _connections, "active_id": _active_connection_id}, f, indent=2)


# ── Azure SQL ──────────────────────────────────────────────────────────────────

def _build_mssql_url(config: ConnectionConfig) -> str:
    driver = _best_odbc_driver().replace(" ", "+")
    if config.auth_type == AuthType.windows:
        return (
            f"mssql+pyodbc://{config.server}/{config.database}"
            f"?driver={driver}&Trusted_Connection=yes&TrustServerCertificate=yes"
        )
    return (
        f"mssql+pyodbc://{config.username}:{config.password}"
        f"@{config.server}:{config.port}/{config.database}"
        f"?driver={driver}&TrustServerCertificate=yes"
    )


def _test_mssql(config: ConnectionConfig) -> tuple[bool, str]:
    try:
        engine = create_engine(_build_mssql_url(config), connect_args={"timeout": 10})
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()
        return True, "Connection successful"
    except Exception as e:
        return False, str(e)


# ── BigQuery ───────────────────────────────────────────────────────────────────

_bq_clients: Dict[str, Any] = {}


def _create_bq_client(config: ConnectionConfig):
    from google.cloud import bigquery as bq

    creds = None
    if config.credentials_json:
        from google.oauth2 import service_account
        info = json.loads(config.credentials_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/bigquery"]
        )
    elif config.oauth_refresh_token:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as GoogleRequest
        creds = Credentials(
            token=None,
            refresh_token=config.oauth_refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""),
            client_secret=os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", ""),
            scopes=["https://www.googleapis.com/auth/bigquery"],
        )
        creds.refresh(GoogleRequest())

    return bq.Client(project=config.project_id, credentials=creds)


def get_bq_client(conn_id: Optional[str] = None):
    """Returns a google.cloud.bigquery.Client for BigQuery connections, None otherwise."""
    target_id = conn_id or _active_connection_id
    if not target_id or target_id not in _connections:
        return None
    config_data = _connections[target_id]
    if config_data.get("db_type") != "bigquery":
        return None
    if target_id not in _bq_clients:
        try:
            config = ConnectionConfig(**config_data)
            _bq_clients[target_id] = _create_bq_client(config)
        except Exception as e:
            import traceback; traceback.print_exc()
            print(f"[get_bq_client] Failed: {e}")
            return None
    return _bq_clients.get(target_id)


def _test_bigquery(config: ConnectionConfig) -> tuple[bool, str]:
    try:
        from google.cloud import bigquery as bq

        creds = None
        if config.credentials_json:
            from google.oauth2 import service_account
            info = json.loads(config.credentials_json)
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=["https://www.googleapis.com/auth/bigquery"]
            )
        elif config.oauth_refresh_token:
            from google.oauth2.credentials import Credentials
            from google.auth.transport.requests import Request as GoogleRequest
            creds = Credentials(
                token=None,
                refresh_token=config.oauth_refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""),
                client_secret=os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", ""),
                scopes=["https://www.googleapis.com/auth/bigquery"],
            )
            creds.refresh(GoogleRequest())

        client = bq.Client(project=config.project_id, credentials=creds)
        list(client.query("SELECT 1").result())
        return True, "Connection successful"
    except ImportError:
        return False, "google-cloud-bigquery package not installed"
    except Exception as e:
        return False, str(e)


def _build_bigquery_engine(config: ConnectionConfig) -> Engine:
    project = config.project_id or config.server or ""
    dataset = config.database or ""
    kwargs: dict = {}

    if config.credentials_json:
        from google.oauth2 import service_account
        info = json.loads(config.credentials_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/bigquery"]
        )
        kwargs["credentials_base"] = creds
    elif config.oauth_refresh_token:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as GoogleRequest
        client_id     = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
        client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
        creds = Credentials(
            token=None,
            refresh_token=config.oauth_refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=["https://www.googleapis.com/auth/bigquery"],
        )
        creds.refresh(GoogleRequest())
        kwargs["credentials_base"] = creds
    # else: fall through to ADC (default Google auth)

    return create_engine(f"bigquery://{project}/{dataset}", **kwargs)


# ── Snowflake ──────────────────────────────────────────────────────────────────

def _test_snowflake(config: ConnectionConfig) -> tuple[bool, str]:
    try:
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=config.server or "",
            user=config.username or "",
            password=config.password or "",
            database=config.database or "",
            warehouse=config.warehouse or "",
            schema=config.schema_name or "PUBLIC",
        )
        conn.cursor().execute("SELECT 1")
        conn.close()
        return True, "Connection successful"
    except ImportError:
        return False, "snowflake-connector-python package not installed"
    except Exception as e:
        return False, str(e)


def _build_snowflake_engine(config: ConnectionConfig) -> Engine:
    from snowflake.sqlalchemy import URL

    url = URL(
        account=config.server or "",
        user=config.username or "",
        password=config.password or "",
        database=config.database or "",
        schema=config.schema_name or "PUBLIC",
        warehouse=config.warehouse or "",
    )
    return create_engine(url)


# ── Databricks ─────────────────────────────────────────────────────────────────

def _test_databricks(config: ConnectionConfig) -> tuple[bool, str]:
    try:
        from databricks import sql as dbsql

        conn = dbsql.connect(
            server_hostname=config.server or "",
            http_path=config.http_path or "",
            access_token=config.password or "",
        )
        conn.cursor().execute("SELECT 1")
        conn.close()
        return True, "Connection successful"
    except ImportError:
        return False, "databricks-sql-connector package not installed"
    except Exception as e:
        return False, str(e)


def _build_databricks_engine(config: ConnectionConfig) -> Engine:
    catalog = config.database or "hive_metastore"
    token = config.password or ""
    host = config.server or ""
    http_path = config.http_path or ""
    url = (
        f"databricks://token:{token}@{host}:443/{catalog}"
        f"?http_path={http_path}"
    )
    return create_engine(url)


# ── Public interface ───────────────────────────────────────────────────────────

def build_connection_string(config: ConnectionConfig) -> str:
    """Returns a SQLAlchemy URL string (Azure SQL only; others use engine builders)."""
    return _build_mssql_url(config)


def test_connection(config: ConnectionConfig) -> tuple[bool, str]:
    db_type = getattr(config, "db_type", DbType.azure_sql)
    if db_type == DbType.bigquery:
        return _test_bigquery(config)
    if db_type == DbType.snowflake:
        return _test_snowflake(config)
    if db_type == DbType.databricks:
        return _test_databricks(config)
    return _test_mssql(config)


def update_connection(conn_id: str, updates: dict):
    if conn_id in _connections:
        _connections[conn_id].update(updates)
        if conn_id in _engines:
            _engines[conn_id].dispose()
            del _engines[conn_id]
        _save_connections()


def add_connection(config: ConnectionConfig) -> str:
    conn_id = str(uuid.uuid4())
    _connections[conn_id] = {"id": conn_id, **config.model_dump()}
    _save_connections()
    return conn_id


def get_connection(conn_id: str) -> Optional[dict]:
    return _connections.get(conn_id)


def get_all_connections() -> list:
    return list(_connections.values())


def delete_connection(conn_id: str):
    if conn_id in _connections:
        del _connections[conn_id]
        if conn_id in _engines:
            _engines[conn_id].dispose()
            del _engines[conn_id]
        _bq_clients.pop(conn_id, None)
        _save_connections()


def set_active_connection(conn_id: str):
    global _active_connection_id
    _active_connection_id = conn_id
    _save_connections()


def get_active_connection_id() -> Optional[str]:
    return _active_connection_id


def get_engine(conn_id: Optional[str] = None) -> Optional[Engine]:
    target_id = conn_id or _active_connection_id
    if not target_id or target_id not in _connections:
        return None
    if target_id not in _engines:
        config_data = _connections[target_id]
        config = ConnectionConfig(**config_data)
        db_type = getattr(config, "db_type", DbType.azure_sql)
        try:
            if db_type == DbType.bigquery:
                _engines[target_id] = _build_bigquery_engine(config)
            elif db_type == DbType.snowflake:
                _engines[target_id] = _build_snowflake_engine(config)
            elif db_type == DbType.databricks:
                _engines[target_id] = _build_databricks_engine(config)
            else:
                _engines[target_id] = create_engine(_build_mssql_url(config), pool_pre_ping=True)
        except Exception as e:
            import traceback
            print(f"[get_engine] Failed to build engine for {target_id}: {e}")
            traceback.print_exc()
            return None
    return _engines.get(target_id)


_load_connections()
