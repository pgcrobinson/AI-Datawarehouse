from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from core.app_db import get_db, User
from core.auth import get_current_user, create_token
from core.security import verify_password, hash_password
from core.logger import log
from pydantic import BaseModel

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not verify_password(req.password, user.password_hash):
        log("warn", "auth", f"Failed login attempt for '{req.email}'",
            detail={"ip": request.client.host if request.client else None})
        raise HTTPException(status_code=401, detail="Invalid email or password")
    log("info", "auth", f"User logged in: {user.email}",
        user_email=user.email, user_id=user.id,
        detail={"role": user.role, "ip": request.client.host if request.client else None})
    return {
        "token": create_token(user.id),
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role,
            "org_id": user.org_id,
        },
    }


@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "org_id": user.org_id,
    }


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    user.password_hash = hash_password(req.new_password)
    db.commit()
    log("info", "auth", f"Password changed: {user.email}", user_email=user.email, user_id=user.id)
    return {"ok": True}
