from sqlalchemy import create_engine, Column, String, Text, DateTime, ForeignKey, Integer
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy import text as sa_text
import uuid
import os
from datetime import datetime, timezone

_DATA_DIR = os.environ.get("DATA_DIR") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_DB_PATH = os.path.join(_DATA_DIR, "app.db")
_engine = create_engine(f"sqlite:///{_DB_PATH}", connect_args={"check_same_thread": False})
_Session = sessionmaker(autocommit=False, autoflush=False, bind=_engine)
Base = declarative_base()


class Organisation(Base):
    __tablename__ = "organisations"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    created_at = Column(DateTime)
    users = relationship("User", back_populates="organisation")


class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True)
    email = Column(String, nullable=False, unique=True)
    name = Column(String, nullable=False)
    password_hash = Column(String, nullable=False, default="")
    role = Column(String, nullable=False, default="designer")
    org_id = Column(String, ForeignKey("organisations.id"), nullable=True)
    google_id = Column(String, nullable=True)
    created_at = Column(DateTime)
    organisation = relationship("Organisation", back_populates="users")
    projects = relationship("Project", back_populates="user")


class Project(Base):
    __tablename__ = "projects"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    org_id = Column(String, ForeignKey("organisations.id"), nullable=True)
    created_at = Column(DateTime)
    user = relationship("User", back_populates="projects")
    designs = relationship("Design", back_populates="project", cascade="all, delete-orphan")


class Design(Base):
    __tablename__ = "designs"
    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    connection_id = Column(String, nullable=True)
    target_schema = Column(String, nullable=True)
    tables_json = Column(Text, nullable=True)
    prompt = Column(Text, nullable=True)
    narrative = Column(Text, nullable=True)
    mermaid_erd = Column(Text, nullable=True)
    sql_ddl = Column(Text, nullable=True)
    etl_sql = Column(Text, nullable=True)
    created_at = Column(DateTime)
    updated_at = Column(DateTime)
    project = relationship("Project", back_populates="designs")
    versions = relationship("DesignVersion", back_populates="design", cascade="all, delete-orphan")
    transforms = relationship("DesignTransform", back_populates="design", cascade="all, delete-orphan",
                              order_by="DesignTransform.order_index")


class DesignVersion(Base):
    __tablename__ = "design_versions"
    id = Column(String, primary_key=True)
    design_id = Column(String, ForeignKey("designs.id"), nullable=False)
    version_number = Column(Integer, nullable=False)
    sql_type = Column(String, nullable=False, default="ddl")
    sql_ddl = Column(Text, nullable=False)
    edited_by_id = Column(String, nullable=True)
    edited_by_name = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)
    design = relationship("Design", back_populates="versions")


class DesignTransform(Base):
    __tablename__ = "design_transforms"
    id = Column(String, primary_key=True)
    design_id = Column(String, ForeignKey("designs.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    transform_type = Column(String, nullable=False, default="sql")
    source_table = Column(String, nullable=True)
    target_table = Column(String, nullable=True)
    output_sql = Column(Text, nullable=True)
    config_json = Column(Text, nullable=True)
    order_index = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime)
    updated_at = Column(DateTime)
    design = relationship("Design", back_populates="transforms")


class LogEntry(Base):
    __tablename__ = "log_entries"
    id = Column(String, primary_key=True)
    created_at = Column(DateTime, nullable=False)
    level = Column(String, nullable=False)       # info | warn | error
    category = Column(String, nullable=False)    # auth | ai | dbt | git | query | admin | error
    message = Column(Text, nullable=False)
    user_email = Column(String, nullable=True)
    user_id = Column(String, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    detail = Column(Text, nullable=True)         # JSON blob for extra context


def init_db():
    Base.metadata.create_all(bind=_engine)
    migrations = [
        """CREATE TABLE IF NOT EXISTS log_entries (
            id TEXT PRIMARY KEY,
            created_at DATETIME NOT NULL,
            level TEXT NOT NULL,
            category TEXT NOT NULL,
            message TEXT NOT NULL,
            user_email TEXT,
            user_id TEXT,
            duration_ms INTEGER,
            detail TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS ix_log_entries_created_at ON log_entries (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS ix_log_entries_level ON log_entries (level)",
        "CREATE INDEX IF NOT EXISTS ix_log_entries_category ON log_entries (category)",
        "ALTER TABLE users ADD COLUMN google_id TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_id ON users (google_id) WHERE google_id IS NOT NULL",
        "ALTER TABLE designs ADD COLUMN etl_sql TEXT",
        "ALTER TABLE design_versions ADD COLUMN sql_type TEXT NOT NULL DEFAULT 'ddl'",
        """CREATE TABLE IF NOT EXISTS design_transforms (
            id TEXT PRIMARY KEY,
            design_id TEXT REFERENCES designs(id),
            name TEXT NOT NULL,
            description TEXT,
            transform_type TEXT NOT NULL DEFAULT 'sql',
            source_table TEXT,
            target_table TEXT,
            output_sql TEXT,
            config_json TEXT,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME,
            updated_at DATETIME
        )""",
    ]
    with _engine.connect() as conn:
        for stmt in migrations:
            try:
                conn.execute(sa_text(stmt))
                conn.commit()
            except Exception:
                pass


def get_db():
    db = _Session()
    try:
        yield db
    finally:
        db.close()


def seed_sysadmin():
    from core.security import hash_password
    admin_email    = os.environ.get("ADMIN_EMAIL",    "admin@admin.com")
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin1234!")
    db = _Session()
    try:
        if db.query(User).count() == 0:
            db.add(User(
                id=str(uuid.uuid4()),
                email=admin_email,
                name="System Administrator",
                password_hash=hash_password(admin_password),
                role="sysadmin",
                org_id=None,
                created_at=datetime.now(timezone.utc),
            ))
            db.commit()
    finally:
        db.close()
