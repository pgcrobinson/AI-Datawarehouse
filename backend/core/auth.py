from datetime import datetime, timedelta, timezone
from typing import Optional
from jose import JWTError, jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from core.app_db import get_db, User
import os

SECRET_KEY = os.getenv("SECRET_KEY", "dev-change-this-secret-in-production")
ALGORITHM = "HS256"

_security = HTTPBearer()


def create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=7)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def _decode(token: str) -> Optional[str]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM]).get("sub")
    except JWTError:
        return None


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_security),
    db: Session = Depends(get_db),
) -> User:
    user_id = _decode(creds.credentials)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_sysadmin(user: User = Depends(get_current_user)) -> User:
    if user.role != "sysadmin":
        raise HTTPException(status_code=403, detail="Sysadmin access required")
    return user
