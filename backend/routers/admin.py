from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from core.app_db import get_db, User, Organisation
from core.auth import require_sysadmin
from core.security import hash_password
from core.logger import log
from pydantic import BaseModel
from typing import Optional
import uuid
from datetime import datetime, timezone

router = APIRouter()


class OrgCreate(BaseModel):
    name: str


class UserCreate(BaseModel):
    email: str
    name: str
    password: str
    role: str = "designer"
    org_id: Optional[str] = None


# ── Organisations ──────────────────────────────────────────────────────────────

@router.get("/organisations")
def list_orgs(db: Session = Depends(get_db), _: User = Depends(require_sysadmin)):
    orgs = db.query(Organisation).all()
    return [
        {"id": o.id, "name": o.name, "created_at": o.created_at, "user_count": len(o.users)}
        for o in orgs
    ]


@router.post("/organisations")
def create_org(body: OrgCreate, db: Session = Depends(get_db), me: User = Depends(require_sysadmin)):
    if db.query(Organisation).filter(Organisation.name == body.name).first():
        raise HTTPException(400, "Organisation name already exists")
    org = Organisation(id=str(uuid.uuid4()), name=body.name, created_at=datetime.now(timezone.utc))
    db.add(org)
    db.commit()
    log("info", "admin", f"Organisation created: {org.name}", user_email=me.email, user_id=me.id)
    return {"id": org.id, "name": org.name, "created_at": org.created_at, "user_count": 0}


@router.delete("/organisations/{org_id}")
def delete_org(org_id: str, db: Session = Depends(get_db), me: User = Depends(require_sysadmin)):
    org = db.query(Organisation).filter(Organisation.id == org_id).first()
    if not org:
        raise HTTPException(404, "Organisation not found")
    log("warn", "admin", f"Organisation deleted: {org.name}", user_email=me.email, user_id=me.id)
    db.delete(org)
    db.commit()
    return {"success": True}


# ── Users ──────────────────────────────────────────────────────────────────────

@router.get("/users")
def list_users(db: Session = Depends(get_db), _: User = Depends(require_sysadmin)):
    return [
        {
            "id": u.id,
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "org_id": u.org_id,
            "org_name": u.organisation.name if u.organisation else None,
        }
        for u in db.query(User).all()
    ]


@router.post("/users")
def create_user(body: UserCreate, db: Session = Depends(get_db), me: User = Depends(require_sysadmin)):
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(400, "Email already in use")
    if body.role not in ("sysadmin", "designer"):
        raise HTTPException(400, "Role must be sysadmin or designer")
    if body.org_id and not db.query(Organisation).filter(Organisation.id == body.org_id).first():
        raise HTTPException(400, "Organisation not found")
    user = User(
        id=str(uuid.uuid4()),
        email=body.email,
        name=body.name,
        password_hash=hash_password(body.password),
        role=body.role,
        org_id=body.org_id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(user)
    db.commit()
    log("info", "admin", f"User created: {user.email} ({user.role})",
        user_email=me.email, user_id=me.id, detail={"new_user": user.email, "role": user.role})
    return {
        "id": user.id, "email": user.email, "name": user.name,
        "role": user.role, "org_id": user.org_id, "org_name": None,
    }


@router.delete("/users/{user_id}")
def delete_user(user_id: str, db: Session = Depends(get_db), me: User = Depends(require_sysadmin)):
    if user_id == me.id:
        raise HTTPException(400, "Cannot delete your own account")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    log("warn", "admin", f"User deleted: {user.email}", user_email=me.email, user_id=me.id,
        detail={"deleted_user": user.email})
    db.delete(user)
    db.commit()
    return {"success": True}
