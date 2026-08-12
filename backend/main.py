from dotenv import load_dotenv
load_dotenv()  # load backend/.env before anything else reads os.environ

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from routers import database, query, settings, design
from routers import auth as auth_router
from routers import admin as admin_router
from routers import projects as projects_router
from routers import git_ops as git_router
from routers import datastudio as ds_router
from routers import orchestration as orch_router
from routers import logs as logs_router
from core.app_db import init_db, seed_sysadmin
from core.logger import log
import uvicorn
import os

_allowed_origins = [o.strip() for o in os.environ.get("FRONTEND_URL", "http://localhost:3000").split(",")]

app = FastAPI(title="AI Data Warehouse Builder API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router,     prefix="/api/auth",        tags=["auth"])
app.include_router(admin_router.router,    prefix="/api/admin",       tags=["admin"])
app.include_router(projects_router.router, prefix="/api/projects",    tags=["projects"])
app.include_router(database.router,        prefix="/api/database",    tags=["database"])
app.include_router(query.router,           prefix="/api/query",       tags=["query"])
app.include_router(settings.router,        prefix="/api/settings",    tags=["settings"])
app.include_router(design.router,          prefix="/api/design",      tags=["design"])
app.include_router(git_router.router,      prefix="/api/git",         tags=["git"])
app.include_router(ds_router.router,       prefix="/api/datastudio",  tags=["datastudio"])
app.include_router(orch_router.router,     prefix="/api/orchestration", tags=["orchestration"])
app.include_router(logs_router.router,     prefix="/api/logs",        tags=["logs"])


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log("error", "error",
        f"Unhandled exception on {request.method} {request.url.path}: {type(exc).__name__}: {str(exc)[:300]}",
        detail={"path": str(request.url.path), "method": request.method,
                "exc_type": type(exc).__name__})
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.on_event("startup")
def startup():
    init_db()
    seed_sysadmin()
    orch_router.init_scheduler()


@app.get("/api/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
