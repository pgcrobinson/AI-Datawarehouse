import bcrypt as _bcrypt


def hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
