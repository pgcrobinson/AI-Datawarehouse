"""Git / GitHub source-control operations for dbt projects."""
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests as http_requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.app_db import get_db, User
from core.logger import log
from routers.auth import get_current_user

router = APIRouter()

DBT_PROJECTS_ROOT = Path(os.environ.get("DATA_DIR") or Path(__file__).parent.parent) / "dbt_projects"


# ── helpers ───────────────────────────────────────────────────────────────────

def _project_dir(project_id: str) -> Path:
    return DBT_PROJECTS_ROOT / project_id


def _read_meta(project_id: str) -> dict:
    """Read project meta, creating a minimal stub if dbt hasn't been initialised yet."""
    proj_dir = _project_dir(project_id)
    path = proj_dir / ".dbt_meta.json"
    if not path.exists():
        # Allow git operations before dbt init — create a minimal stub
        proj_dir.mkdir(parents=True, exist_ok=True)
        stub = {"project_slug": project_id[:8], "connection_id": None, "default_schema": "analytics"}
        path.write_text(json.dumps(stub, indent=2), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_meta(project_id: str, meta: dict) -> None:
    path = _project_dir(project_id) / ".dbt_meta.json"
    path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _git(project_id: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", *args],
        cwd=str(_project_dir(project_id)),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},  # never hang on auth prompt
    )
    if check and result.returncode != 0:
        msg = (result.stderr or result.stdout).strip()
        raise HTTPException(400, msg or "git command failed")
    return result


def _is_git_repo(project_id: str) -> bool:
    r = _git(project_id, "rev-parse", "--git-dir", check=False)
    return r.returncode == 0


def _current_branch(project_id: str) -> str:
    r = _git(project_id, "rev-parse", "--abbrev-ref", "HEAD", check=False)
    return r.stdout.strip() if r.returncode == 0 else ""


def _remote_with_pat(url: str, pat: str) -> str:
    """Inject PAT into HTTPS URL: https://PAT@github.com/…"""
    if pat and url.startswith("https://"):
        # Remove any existing credential first
        url = re.sub(r"https://[^@]+@", "https://", url)
        return url.replace("https://", f"https://{pat}@", 1)
    return url


def _owner_repo(url: str) -> tuple[str, str] | None:
    m = re.search(r"github\.com[:/]([^/]+)/([^/.]+?)(?:\.git)?\s*$", url)
    return (m.group(1), m.group(2)) if m else None


def _parse_status_porcelain(raw: str) -> dict:
    staged, unstaged, untracked = [], [], []
    for line in raw.splitlines():
        if len(line) < 3:
            continue
        x, y = line[0], line[1]
        path = line[3:]
        # Rename lines: "old -> new"
        if " -> " in path:
            path = path.split(" -> ")[-1]

        if x == "?" and y == "?":
            untracked.append(path)
        else:
            if x not in (" ", "?"):
                staged.append({"path": path, "status": x})
            if y not in (" ", "?"):
                # Avoid duplicating paths already in staged with same path
                if not any(f["path"] == path for f in staged) or y != x:
                    unstaged.append({"path": path, "status": y})
    return {"staged": staged, "unstaged": unstaged, "untracked": untracked}


def _set_local_git_identity(project_id: str, user: User) -> None:
    _git(project_id, "config", "user.name", user.name or "DW Builder", check=False)
    _git(project_id, "config", "user.email", user.email or "dw-builder@local", check=False)


def _ensure_meta_ignored(project_id: str) -> None:
    """
    Ensure .dbt_meta.json is in .gitignore and not tracked by git.
    Safe to call on any repo at any time.
    """
    proj_dir = _project_dir(project_id)

    # 1. Patch .gitignore if the entry is missing
    gitignore = proj_dir / ".gitignore"
    entry = ".dbt_meta.json"
    if gitignore.exists():
        lines = gitignore.read_text(encoding="utf-8").splitlines()
        if entry not in lines:
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8").rstrip() + f"\n{entry}\n",
                encoding="utf-8",
            )
    else:
        gitignore.write_text(_GITIGNORE, encoding="utf-8")

    # 2. Remove from git index if it was ever staged or committed
    if _is_git_repo(project_id):
        _git(project_id, "rm", "--cached", "--force", entry, check=False)


_GITIGNORE = """\
# dbt artifacts
target/
dbt_packages/
logs/

# credentials & app config – never commit these
profiles.yml
.dbt_meta.json

# Python
*.pyc
__pycache__/
"""


# ── Request bodies ────────────────────────────────────────────────────────────

class GitConfigBody(BaseModel):
    remote_url: str = ""
    pat: str = ""


class GitCloneBody(BaseModel):
    remote_url: str
    pat: str = ""
    branch: str = "main"


class GitStageBody(BaseModel):
    paths: list[str]


class GitCommitBody(BaseModel):
    message: str


class GitBranchBody(BaseModel):
    name: str
    create: bool = False


class GitPRBody(BaseModel):
    title: str
    body: str = ""
    head: str
    base: str = "main"


class CreateRepoBody(BaseModel):
    name: str
    description: str = ""
    private: bool = False
    auto_init: bool = False


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/config")
def get_config(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meta = _read_meta(project_id)
    is_repo = _is_git_repo(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")
    branch = _current_branch(project_id) if is_repo else ""

    # Fall back to remote stored in .git/config
    if not remote and is_repo:
        r = _git(project_id, "remote", "get-url", "origin", check=False)
        if r.returncode == 0:
            remote = re.sub(r"https://[^@]+@", "https://", r.stdout.strip())

    return {
        "is_git_repo": is_repo,
        "remote_url": remote,
        "has_pat": bool(pat),
        "branch": branch,
    }


@router.post("/{project_id}/config")
def set_config(
    project_id: str,
    body: GitConfigBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meta = _read_meta(project_id)
    if body.remote_url:
        meta["github_remote"] = body.remote_url.strip()
    if body.pat:
        meta["github_pat"] = body.pat.strip()
    _write_meta(project_id, meta)

    # Update / add git remote if repo exists
    if _is_git_repo(project_id):
        remote = meta.get("github_remote", "")
        pat = meta.get("github_pat", "")
        if remote:
            auth_url = _remote_with_pat(remote, pat)
            r = _git(project_id, "remote", "get-url", "origin", check=False)
            if r.returncode == 0:
                _git(project_id, "remote", "set-url", "origin", auth_url, check=False)
            else:
                _git(project_id, "remote", "add", "origin", auth_url, check=False)
        # Store user identity in local git config
        _set_local_git_identity(project_id, user)

    return {"ok": True}


@router.get("/{project_id}/status")
def get_status(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        return {
            "is_git_repo": False, "branch": "", "ahead": 0, "behind": 0,
            "staged": [], "unstaged": [], "untracked": [], "commits": [],
        }

    branch = _current_branch(project_id)

    status_r = _git(project_id, "status", "--porcelain=v1")
    files = _parse_status_porcelain(status_r.stdout)

    # Commit log
    log_r = _git(project_id, "log", "--format=%H|%h|%s|%an|%ar", "-15", check=False)
    commits = []
    if log_r.returncode == 0:
        for line in log_r.stdout.splitlines():
            parts = line.split("|", 4)
            if len(parts) == 5:
                commits.append({
                    "hash": parts[0], "short": parts[1],
                    "message": parts[2], "author": parts[3], "date": parts[4],
                })

    # Ahead / behind relative to tracking branch
    ahead, behind = 0, 0
    ab_r = _git(
        project_id, "rev-list", "--left-right", "--count",
        f"origin/{branch}...HEAD", check=False,
    )
    if ab_r.returncode == 0:
        parts = ab_r.stdout.strip().split()
        if len(parts) == 2:
            behind, ahead = int(parts[0]), int(parts[1])

    return {
        "is_git_repo": True,
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        **files,
        "commits": commits,
    }


@router.post("/{project_id}/init")
def git_init(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if _is_git_repo(project_id):
        return {"ok": True, "message": "Already a git repository"}

    _git(project_id, "init")
    _set_local_git_identity(project_id, user)
    _ensure_meta_ignored(project_id)

    # Wire up remote if already configured in meta
    meta = _read_meta(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")
    if remote:
        auth_url = _remote_with_pat(remote, pat)
        _git(project_id, "remote", "add", "origin", auth_url, check=False)

    return {"ok": True, "message": "Initialised empty git repository"}


@router.post("/{project_id}/clone")
def git_clone(
    project_id: str,
    body: GitCloneBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Clone a remote repo and merge its .git history into the project dir."""
    meta = _read_meta(project_id)
    proj_dir = _project_dir(project_id)

    pat = body.pat or meta.get("github_pat", "")
    auth_url = _remote_with_pat(body.remote_url, pat)

    with tempfile.TemporaryDirectory() as tmpdir:
        # Try with specified branch first, fall back to default
        r = subprocess.run(
            ["git", "clone", "--branch", body.branch, auth_url, tmpdir],
            capture_output=True, text=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if r.returncode != 0:
            r = subprocess.run(
                ["git", "clone", auth_url, tmpdir],
                capture_output=True, text=True,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
            if r.returncode != 0:
                raise HTTPException(400, r.stderr.strip() or "Clone failed")

        # Swap in the .git directory
        git_src = Path(tmpdir) / ".git"
        git_dst = proj_dir / ".git"
        if git_dst.exists():
            shutil.rmtree(str(git_dst))
        shutil.copytree(str(git_src), str(git_dst))

        # If the project has no real dbt content yet (only a meta stub), do a full
        # overwrite; otherwise be non-destructive and only copy missing files.
        dbt_initialised = (proj_dir / "dbt_project.yml").exists()
        for src in Path(tmpdir).rglob("*"):
            if src.is_file() and ".git" not in src.parts:
                rel = src.relative_to(tmpdir)
                dst = proj_dir / rel
                # Never overwrite .dbt_meta.json — it holds our app config
                if rel.name == ".dbt_meta.json":
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                if not dbt_initialised or not dst.exists():
                    shutil.copy2(str(src), str(dst))

    if pat:
        meta["github_pat"] = pat
    meta["github_remote"] = body.remote_url.strip()

    # Auto-detect if the cloned repo has its dbt project in a subfolder
    nested = [
        p for p in proj_dir.rglob("dbt_project.yml")
        if p.parent != proj_dir and ".git" not in p.parts and "target" not in p.parts
    ]
    if len(nested) == 1:
        subdir = nested[0].parent.relative_to(proj_dir).as_posix()
        meta["project_subdir"] = subdir
    elif "project_subdir" in meta and not nested:
        meta.pop("project_subdir", None)

    _write_meta(project_id, meta)
    _set_local_git_identity(project_id, user)
    _ensure_meta_ignored(project_id)

    subdir_msg = f" (dbt project in '{meta.get('project_subdir', '')}/')" if meta.get("project_subdir") else ""
    return {"ok": True, "message": f"Cloned from {body.remote_url}{subdir_msg}"}


@router.post("/{project_id}/stage")
def git_stage(
    project_id: str,
    body: GitStageBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository — initialise first")
    if not body.paths:
        raise HTTPException(400, "No paths provided")
    _git(project_id, "add", "--", *body.paths)
    return {"ok": True}


@router.post("/{project_id}/stage-all")
def git_stage_all(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository — initialise first")
    _git(project_id, "add", "-A")
    return {"ok": True}


@router.post("/{project_id}/unstage")
def git_unstage(
    project_id: str,
    body: GitStageBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    # restore --staged works for both tracked and new files
    _git(project_id, "restore", "--staged", "--", *body.paths)
    return {"ok": True}


@router.post("/{project_id}/commit")
def git_commit(
    project_id: str,
    body: GitCommitBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    if not body.message.strip():
        raise HTTPException(400, "Commit message required")

    result = subprocess.run(
        ["git", "commit", "-m", body.message.strip()],
        cwd=str(_project_dir(project_id)),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if result.returncode != 0:
        raise HTTPException(400, result.stderr.strip() or result.stdout.strip() or "Commit failed")
    log("info", "git", f"Commit: {body.message.strip()[:80]}",
        user_email=user.email, user_id=user.id, detail={"project_id": project_id})
    return {"ok": True, "message": result.stdout.strip()}


@router.post("/{project_id}/push")
def git_push(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")

    meta = _read_meta(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")
    branch = _current_branch(project_id)

    if remote and pat:
        _git(project_id, "remote", "set-url", "origin",
             _remote_with_pat(remote, pat), check=False)

    # Safety: ensure .dbt_meta.json is not tracked before pushing
    _ensure_meta_ignored(project_id)

    result = _git(project_id, "push", "-u", "origin", branch)
    combined = (result.stderr or result.stdout).strip()

    # Surface a friendlier hint when GitHub push protection blocks the push
    if "GH013" in combined or "push protection" in combined.lower():
        log("warn", "git", "Push blocked by GitHub secret scanning (GH013)",
            user_email=user.email, user_id=user.id, detail={"project_id": project_id})
        raise HTTPException(400, (
            "GitHub blocked the push because a secret was found in the commit history. "
            "Use 'Scrub secret from history' in the Remote tab, then push again."
        ))

    log("info", "git", f"Pushed branch '{branch}' to remote",
        user_email=user.email, user_id=user.id, detail={"project_id": project_id, "branch": branch})
    return {"ok": True, "message": combined}


@router.post("/{project_id}/scrub-history")
def scrub_history(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Remove .dbt_meta.json from every commit in the repo's history,
    then update .gitignore so it can never be committed again.
    """
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")

    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "FILTER_BRANCH_SQUELCH_WARNING": "1"}
    cwd = str(_project_dir(project_id))

    # Stash any uncommitted changes so filter-branch can run cleanly
    stash_result = subprocess.run(
        ["git", "stash", "--include-untracked"],
        cwd=cwd, capture_output=True, text=True, env=env,
    )
    stashed = stash_result.returncode == 0 and "No local changes" not in stash_result.stdout

    result = subprocess.run(
        [
            "git", "filter-branch", "--force",
            "--index-filter", "git rm --cached --ignore-unmatch .dbt_meta.json",
            "--prune-empty", "--tag-name-filter", "cat",
            "--", "--all",
        ],
        cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=env,
    )

    # Always restore stash, even if filter-branch failed
    if stashed:
        subprocess.run(["git", "stash", "pop"], cwd=cwd, capture_output=True, text=True, env=env)

    if result.returncode != 0:
        raise HTTPException(400, result.stderr.strip() or "History rewrite failed")

    # Clean up refs/original left by filter-branch
    subprocess.run(
        ["git", "for-each-ref", "--format=%(refname)", "refs/original/"],
        cwd=str(_project_dir(project_id)),
        capture_output=True, text=True,
    )
    subprocess.run(
        ["git", "reflog", "expire", "--expire=now", "--all"],
        cwd=str(_project_dir(project_id)),
        capture_output=True, text=True, env=env,
    )
    subprocess.run(
        ["git", "gc", "--prune=now", "--aggressive"],
        cwd=str(_project_dir(project_id)),
        capture_output=True, text=True, env=env,
    )

    _ensure_meta_ignored(project_id)

    return {"ok": True, "message": "Secret scrubbed from history — push will require --force. Use the Push button to proceed."}


@router.post("/{project_id}/pull")
def git_pull(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")

    meta = _read_meta(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")

    if remote and pat:
        _git(project_id, "remote", "set-url", "origin",
             _remote_with_pat(remote, pat), check=False)

    result = _git(project_id, "pull", "--rebase")
    log("info", "git", "Pulled from remote (rebase)",
        user_email=user.email, user_id=user.id, detail={"project_id": project_id})
    return {"ok": True, "message": result.stdout.strip()}


@router.post("/{project_id}/stash")
def git_stash(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    result = _git(project_id, "stash", "--include-untracked")
    msg = result.stdout.strip() or "Stashed"
    if "No local changes" in msg:
        raise HTTPException(400, "Nothing to stash — working tree is clean")
    return {"ok": True, "message": msg}


@router.post("/{project_id}/stash-pop")
def git_stash_pop(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    result = _git(project_id, "stash", "pop")
    return {"ok": True, "message": result.stdout.strip() or "Stash applied"}


@router.get("/{project_id}/branches")
def get_branches(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        return {"branches": [], "current": ""}
    r = _git(project_id, "branch", "--format=%(refname:short)", check=False)
    branches = [b.strip() for b in r.stdout.splitlines() if b.strip()]
    return {"branches": branches, "current": _current_branch(project_id)}


@router.post("/{project_id}/branch")
def create_or_checkout_branch(
    project_id: str,
    body: GitBranchBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    if body.create:
        _git(project_id, "checkout", "-b", body.name)
    else:
        _git(project_id, "checkout", body.name)
    return {"ok": True, "branch": body.name}


@router.delete("/{project_id}/branch/{branch_name}")
def delete_branch(
    project_id: str,
    branch_name: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    if branch_name == _current_branch(project_id):
        raise HTTPException(400, f"Cannot delete '{branch_name}' — it is currently checked out. Switch to another branch first.")
    _git(project_id, "branch", "-d", branch_name)
    return {"ok": True}


@router.get("/{project_id}/diff")
def get_diff(
    project_id: str,
    path: str,
    staged: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _is_git_repo(project_id):
        raise HTTPException(400, "Not a git repository")
    args = ["diff", "--unified=3"]
    if staged:
        args.append("--cached")
    args += ["--", path]
    r = _git(project_id, *args, check=False)
    return {"diff": r.stdout}


@router.post("/{project_id}/pr")
def create_pr(
    project_id: str,
    body: GitPRBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meta = _read_meta(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")

    if not remote:
        raise HTTPException(400, "No GitHub remote configured")
    if not pat:
        raise HTTPException(400, "GitHub PAT required to create pull requests")

    parsed = _owner_repo(remote)
    if not parsed:
        raise HTTPException(400, "Cannot parse owner/repo from remote URL")
    owner, repo = parsed

    resp = http_requests.post(
        f"https://api.github.com/repos/{owner}/{repo}/pulls",
        headers={
            "Authorization": f"token {pat}",
            "Accept": "application/vnd.github.v3+json",
        },
        json={"title": body.title, "body": body.body, "head": body.head, "base": body.base},
        timeout=15,
    )
    if resp.status_code not in (200, 201):
        gh_data = resp.json()
        message = gh_data.get("message", "GitHub API error")
        errors = gh_data.get("errors", [])
        # Surface actionable messages for common GitHub 422 cases
        if resp.status_code == 422:
            for err in errors:
                field = err.get("field", "")
                msg = err.get("message", "")
                if field == "head":
                    raise HTTPException(400, f"Branch '{body.head}' not found on GitHub — push it first, then create a PR.")
                if "already exists" in msg or "No commits between" in msg:
                    raise HTTPException(400, msg)
            if body.head == body.base:
                raise HTTPException(400, f"Cannot open a PR from '{body.head}' into itself.")
        raise HTTPException(400, message)

    data = resp.json()
    return {"ok": True, "pr_url": data.get("html_url", ""), "pr_number": data.get("number")}


@router.get("/{project_id}/prs")
def list_prs(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meta = _read_meta(project_id)
    remote = meta.get("github_remote", "")
    pat = meta.get("github_pat", "")

    if not remote or not pat:
        return {"prs": []}

    parsed = _owner_repo(remote)
    if not parsed:
        return {"prs": []}
    owner, repo = parsed

    resp = http_requests.get(
        f"https://api.github.com/repos/{owner}/{repo}/pulls",
        headers={
            "Authorization": f"token {pat}",
            "Accept": "application/vnd.github.v3+json",
        },
        params={"state": "open", "per_page": 10},
        timeout=15,
    )
    if resp.status_code != 200:
        return {"prs": []}

    return {
        "prs": [
            {
                "number": pr["number"],
                "title": pr["title"],
                "state": pr["state"],
                "url": pr["html_url"],
                "head": pr["head"]["ref"],
                "base": pr["base"]["ref"],
                "created_at": pr["created_at"],
                "author": pr["user"]["login"],
            }
            for pr in resp.json()
        ]
    }


def _gh_headers(pat: str) -> dict:
    return {"Authorization": f"token {pat}", "Accept": "application/vnd.github.v3+json"}


@router.get("/{project_id}/github-user")
def get_github_user(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Validate the stored PAT and return the authenticated GitHub user."""
    meta = _read_meta(project_id)
    pat = meta.get("github_pat", "")
    if not pat:
        raise HTTPException(400, "No Personal Access Token saved — enter one in the Remote tab first")

    resp = http_requests.get(
        "https://api.github.com/user",
        headers=_gh_headers(pat),
        timeout=10,
    )
    if resp.status_code == 401:
        raise HTTPException(400, "Invalid PAT — check the token and try again")
    if resp.status_code != 200:
        raise HTTPException(400, f"GitHub API error: {resp.status_code}")

    data = resp.json()
    return {
        "login":       data["login"],
        "name":        data.get("name") or data["login"],
        "avatar_url":  data["avatar_url"],
        "html_url":    data["html_url"],
        "public_repos": data.get("public_repos", 0),
        "private_repos": data.get("total_private_repos", 0),
    }


@router.get("/{project_id}/github-repos")
def list_github_repos(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List the authenticated user's GitHub repositories (most recently updated, up to 50)."""
    meta = _read_meta(project_id)
    pat = meta.get("github_pat", "")
    if not pat:
        raise HTTPException(400, "No PAT saved")

    resp = http_requests.get(
        "https://api.github.com/user/repos",
        headers=_gh_headers(pat),
        params={"sort": "updated", "per_page": 50, "affiliation": "owner"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise HTTPException(400, f"GitHub API error: {resp.status_code}")

    return {
        "repos": [
            {
                "full_name":   r["full_name"],
                "name":        r["name"],
                "html_url":    r["html_url"],
                "clone_url":   r["clone_url"],
                "private":     r["private"],
                "description": r.get("description") or "",
                "default_branch": r.get("default_branch", "main"),
            }
            for r in resp.json()
        ]
    }


@router.post("/{project_id}/create-repo")
def create_github_repo(
    project_id: str,
    body: CreateRepoBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new GitHub repository and wire it as this project's remote."""
    if not body.name.strip():
        raise HTTPException(400, "Repository name is required")

    meta = _read_meta(project_id)
    pat = meta.get("github_pat", "")
    if not pat:
        raise HTTPException(400, "No PAT saved — save a Personal Access Token first")

    resp = http_requests.post(
        "https://api.github.com/user/repos",
        headers=_gh_headers(pat),
        json={
            "name":        body.name.strip(),
            "description": body.description.strip(),
            "private":     body.private,
            "auto_init":   body.auto_init,
        },
        timeout=15,
    )
    if resp.status_code not in (200, 201):
        gh = resp.json()
        msg = gh.get("message", "GitHub API error")
        errors = gh.get("errors", [])
        if errors:
            msg = f"{msg}: {'; '.join(e.get('message', '') for e in errors)}"
        raise HTTPException(400, msg)

    data = resp.json()
    html_url  = data["html_url"]
    clone_url = data["clone_url"]

    # Auto-configure remote on the local git repo
    meta["github_remote"] = html_url
    _write_meta(project_id, meta)

    if _is_git_repo(project_id):
        auth_url = _remote_with_pat(html_url, pat)
        r = _git(project_id, "remote", "get-url", "origin", check=False)
        if r.returncode == 0:
            _git(project_id, "remote", "set-url", "origin", auth_url, check=False)
        else:
            _git(project_id, "remote", "add", "origin", auth_url, check=False)

    return {
        "ok":           True,
        "name":         data["name"],
        "full_name":    data["full_name"],
        "html_url":     html_url,
        "clone_url":    clone_url,
        "private":      data["private"],
        "default_branch": data.get("default_branch", "main"),
    }
