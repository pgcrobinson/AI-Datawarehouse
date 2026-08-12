"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  GitBranch, GitCommit, GitPullRequest, Upload, Download,
  RefreshCw, Plus, Minus, Check, ExternalLink, ChevronDown,
  ChevronRight, Loader2, ArrowUp, ArrowDown, X, Lock, Globe,
  UserCircle2, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { GitConfig, GitStatus, GitPR, GitHubUser, GitHubRepo } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── diff viewer ───────────────────────────────────────────────────────────────

function DiffViewer({ diff }: { diff: string }) {
  if (!diff.trim())
    return <p className="text-xs text-muted-foreground px-3 py-4 text-center italic">No diff available</p>;

  return (
    <pre className="text-[11px] font-mono overflow-x-auto p-2 leading-5 select-text">
      {diff.split("\n").map((line, i) => (
        <span
          key={i}
          className={cn(
            "block px-1",
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-green-400 bg-green-500/10"
              : line.startsWith("-") && !line.startsWith("---")
              ? "text-red-400 bg-red-500/10"
              : line.startsWith("@@")
              ? "text-blue-400"
              : line.startsWith("diff ") || line.startsWith("index ") ||
                line.startsWith("---") || line.startsWith("+++")
              ? "text-muted-foreground"
              : "text-foreground/70",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

// ── file row ──────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", "?": "?" };
const STATUS_COLOR: Record<string, string> = {
  M: "text-amber-400", A: "text-green-400", D: "text-red-400",
  R: "text-blue-400",  "?": "text-muted-foreground",
};

function FileRow({
  path, statusCode, staged, projectId, onStage, onUnstage,
}: {
  path: string; statusCode: string; staged: boolean; projectId: string;
  onStage: () => void; onUnstage: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  async function toggleDiff() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (diff === null) {
      setLoadingDiff(true);
      try {
        const r = await api.gitDiff(projectId, path, staged);
        setDiff(r.diff);
      } catch { setDiff(""); }
      finally { setLoadingDiff(false); }
    }
  }

  const sc = STATUS_LABEL[statusCode] ?? statusCode;
  const scColor = STATUS_COLOR[statusCode] ?? "text-muted-foreground";
  const filename = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/") + 1) : "";

  return (
    <div className="border-b border-border/40 last:border-0">
      <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-accent/50 group">
        <button onClick={toggleDiff} className="flex items-center gap-1 flex-1 min-w-0 text-left">
          {expanded
            ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {dir && <span className="text-[10px] text-muted-foreground truncate shrink">{dir}</span>}
          <span className="text-xs font-mono truncate">{filename}</span>
        </button>
        <span className={cn("text-[10px] font-bold font-mono shrink-0 ml-1", scColor)}>{sc}</span>
        {staged ? (
          <button
            title="Unstage"
            onClick={(e) => { e.stopPropagation(); onUnstage(); }}
            className="shrink-0 ml-1 text-red-400/60 hover:text-red-300 transition-colors"
          >
            <Minus className="h-3 w-3" />
          </button>
        ) : (
          <button
            title="Stage"
            onClick={(e) => { e.stopPropagation(); onStage(); }}
            className="shrink-0 ml-1 text-green-400/60 hover:text-green-300 transition-colors"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="bg-black/20 border-t border-border/30 max-h-52 overflow-y-auto">
          {loadingDiff
            ? <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            : <DiffViewer diff={diff ?? ""} />
          }
        </div>
      )}
    </div>
  );
}

// ── git dialog ────────────────────────────────────────────────────────────────

type GitTab = "changes" | "branches" | "history" | "remote";

export function GitDialog({
  open, onClose, projectId,
}: {
  open: boolean; onClose: () => void; projectId: string;
}) {
  const [tab, setTab] = useState<GitTab>("changes");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [config, setConfig] = useState<GitConfig | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [prs, setPrs] = useState<GitPR[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // GitHub account state
  const [ghUser, setGhUser]       = useState<GitHubUser | null>(null);
  const [ghRepos, setGhRepos]     = useState<GitHubRepo[]>([]);
  const [ghReposLoaded, setGhReposLoaded] = useState(false);
  const [selectedRepo, setSelectedRepo]   = useState("");
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName]     = useState("");
  const [newRepoDesc, setNewRepoDesc]     = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(false);

  // form state
  const [commitMsg, setCommitMsg]     = useState("");
  const [newBranch, setNewBranch]     = useState("");
  const [remoteUrl, setRemoteUrl]     = useState("");
  const [pat, setPat]                 = useState("");
  const [cloneUrl, setCloneUrl]       = useState("");
  const [clonePat, setClonePat]       = useState("");
  const [cloneBranch, setCloneBranch] = useState("main");
  const [prTitle, setPrTitle]         = useState("");
  const [prBody, setPrBody]           = useState("");
  const [prBase, setPrBase]           = useState("main");

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [s, c, b] = await Promise.all([
        api.gitGetStatus(projectId),
        api.gitGetConfig(projectId),
        api.gitBranches(projectId),
      ]);
      setStatus(s);
      setConfig(c);
      setBranches(b.branches);
      setCurrentBranch(b.current || s.branch);
      setRemoteUrl(prev => prev || c.remote_url || "");
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open && projectId) load(); }, [open, projectId, load]);

  useEffect(() => {
    if (tab !== "remote" || !projectId) return;
    if (config?.has_pat) {
      api.gitListPRs(projectId).then(r => setPrs(r.prs)).catch(() => {});
      // Auto-load GitHub user when remote tab opened with a saved PAT
      if (!ghUser) {
        api.gitGitHubUser(projectId).then(u => setGhUser(u)).catch(() => {});
      }
    }
  }, [tab, projectId, config?.has_pat, ghUser]);

  // ── operations ───────────────────────────────────────────────────────────────

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try { await fn(); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Operation failed"); }
    finally { setBusy(null); }
  }

  const doInit      = () => run("init",      () => api.gitInit(projectId).then(r => toast.success(r.message)));
  const doStageAll  = () => run("stageall",  () => api.gitStageAll(projectId));
  const doStage     = (paths: string[]) => run("stage",   () => api.gitStage(projectId, paths));
  const doUnstage   = (paths: string[]) => run("unstage", () => api.gitUnstage(projectId, paths));
  const doStash     = () => run("stash",     () => api.gitStash(projectId).then(r => toast.success(r.message)));
  const doStashPop  = () => run("stashpop",  () => api.gitStashPop(projectId).then(r => toast.success(r.message)));

  const doPull = () => run("pull", () =>
    api.gitPull(projectId).then(r => toast.success(r.message || "Up to date")));

  const doPush = () => run("push", () =>
    api.gitPush(projectId).then(r => toast.success(r.message || "Pushed")));

  async function doCommit() {
    if (!commitMsg.trim()) { toast.error("Commit message required"); return; }
    if ((status?.staged.length ?? 0) === 0) { toast.error("Nothing staged — stage files first"); return; }
    await run("commit", async () => {
      const r = await api.gitCommit(projectId, commitMsg.trim());
      toast.success(r.message || "Committed");
      setCommitMsg("");
    });
  }

  const doCheckout = (name: string) => run("checkout", () =>
    api.gitBranch(projectId, name, false).then(() => toast.success(`Switched to ${name}`)));

  const doDeleteBranch = (name: string) => run("delbranch", () =>
    api.gitDeleteBranch(projectId, name).then(() => toast.success(`Deleted ${name}`)));

  async function doCreateBranch() {
    if (!newBranch.trim()) return;
    await run("newbranch", async () => {
      await api.gitBranch(projectId, newBranch.trim(), true);
      toast.success(`Created & switched to ${newBranch.trim()}`);
      setNewBranch("");
    });
  }

  async function doSaveRemote() {
    await run("remote", async () => {
      await api.gitSetConfig(projectId, remoteUrl.trim(), pat.trim());
      toast.success("Remote saved");
      setPat("");
      setGhUser(null); // will re-verify on next tab open
    });
  }

  async function doVerifyPat() {
    // Save the PAT first, then verify
    await run("verifypat", async () => {
      await api.gitSetConfig(projectId, remoteUrl.trim(), pat.trim());
      setPat("");
      const u = await api.gitGitHubUser(projectId);
      setGhUser(u);
      setGhRepos([]);
      setGhReposLoaded(false);
      toast.success(`Connected as @${u.login}`);
    });
  }

  async function doLoadRepos() {
    if (ghReposLoaded) return;
    setBusy("loadrepos");
    try {
      const r = await api.gitGitHubRepos(projectId);
      setGhRepos(r.repos);
      setGhReposLoaded(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load repos");
    } finally { setBusy(null); }
  }

  async function doUseExistingRepo() {
    if (!selectedRepo) return;
    const repo = ghRepos.find(r => r.full_name === selectedRepo);
    if (!repo) return;
    await run("userepo", async () => {
      await api.gitSetConfig(projectId, repo.html_url, "");
      setRemoteUrl(repo.html_url);
      toast.success(`Remote set to ${repo.full_name}`);
      await load();
    });
  }

  async function doCreateGitHubRepo() {
    if (!newRepoName.trim()) { toast.error("Repository name required"); return; }
    await run("createrepo", async () => {
      const r = await api.gitCreateRepo(projectId, newRepoName.trim(), newRepoDesc.trim(), newRepoPrivate);
      toast.success(`Created ${r.full_name}`);
      setRemoteUrl(r.html_url);
      setNewRepoName(""); setNewRepoDesc(""); setShowCreateRepo(false);
      setGhRepos(prev => [r as unknown as GitHubRepo, ...prev]);
      await load();
    });
  }

  function doDisconnectGitHub() {
    setGhUser(null);
    setGhRepos([]);
    setGhReposLoaded(false);
  }

  async function doClone() {
    if (!cloneUrl.trim()) return;
    await run("clone", async () => {
      const r = await api.gitClone(projectId, cloneUrl.trim(), clonePat.trim(), cloneBranch.trim() || "main");
      toast.success(r.message);
      setCloneUrl(""); setClonePat("");
    });
  }

  async function doCreatePR() {
    if (!prTitle.trim()) { toast.error("PR title required"); return; }
    await run("pr", async () => {
      const r = await api.gitCreatePR(projectId, prTitle.trim(), prBody.trim(), currentBranch, prBase);
      toast.success(`PR #${r.pr_number} created`);
      window.open(r.pr_url, "_blank");
      setPrTitle(""); setPrBody("");
      api.gitListPRs(projectId).then(r2 => setPrs(r2.prs)).catch(() => {});
    });
  }

  // ── derived ──────────────────────────────────────────────────────────────────

  const isNotRepo    = config !== null && !config.is_git_repo;
  const totalChanges = (status?.staged.length ?? 0) +
                       (status?.unstaged.length ?? 0) +
                       (status?.untracked.length ?? 0);

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-card border-border flex flex-col p-0 gap-0 max-h-[88vh]">

        {/* header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <GitBranch className="h-4 w-4 text-primary shrink-0" />
          <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
            <span className="text-sm font-semibold shrink-0">Source Control</span>
            {config?.is_git_repo && (
              <>
                <span className="text-xs font-mono bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded shrink-0">
                  {currentBranch || "HEAD"}
                </span>
                {(status?.ahead ?? 0) > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] text-green-400 shrink-0">
                    <ArrowUp className="h-3 w-3" />{status!.ahead}
                  </span>
                )}
                {(status?.behind ?? 0) > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] text-amber-400 shrink-0">
                    <ArrowDown className="h-3 w-3" />{status!.behind}
                  </span>
                )}
                {config.remote_url && (
                  <span className="text-[10px] text-muted-foreground truncate hidden sm:block">
                    {config.remote_url.replace(/https?:\/\//, "").replace(/\.git$/, "")}
                  </span>
                )}
              </>
            )}
          </div>
          {/* push / pull / refresh */}
          <div className="flex items-center gap-0.5 shrink-0">
            {config?.is_git_repo && (
              <>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={doPull} disabled={busy !== null} title="Pull (rebase)">
                  {busy === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={doPush} disabled={busy !== null} title="Push">
                  {busy === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={load} disabled={loading} title="Refresh">
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* not-a-repo splash */}
        {isNotRepo && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-14 px-8">
            <GitBranch className="h-10 w-10 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground text-center">
              This dbt project is not tracked by Git.
            </p>
            <div className="flex gap-3">
              <Button onClick={doInit} disabled={busy !== null}>
                {busy === "init" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                Initialize repository
              </Button>
              <Button variant="outline" onClick={() => setTab("remote")}>
                Clone from GitHub
              </Button>
            </div>
          </div>
        )}

        {/* tabs + content */}
        {!isNotRepo && (
          <>
            {/* tab bar */}
            <div className="flex border-b border-border px-2 shrink-0">
              {(["changes", "branches", "history", "remote"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-3 py-2 text-xs font-medium capitalize transition-colors",
                    tab === t
                      ? "text-foreground border-b-2 border-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                  {t === "changes" && totalChanges > 0 && (
                    <span className="ml-1.5 text-[9px] bg-primary/20 text-primary rounded px-1">
                      {totalChanges}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">

              {/* ── CHANGES ── */}
              {tab === "changes" && (
                <div className="flex flex-col h-full min-h-0">
                  {loading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {/* staged */}
                      <SectionHeader
                        label="Staged"
                        count={status?.staged.length ?? 0}
                        action={
                          (status?.staged.length ?? 0) > 0
                            ? { label: "Unstage all", onClick: () => doUnstage(status!.staged.map(f => f.path)) }
                            : undefined
                        }
                      />
                      {(status?.staged ?? []).map(f => (
                        <FileRow
                          key={`s-${f.path}`}
                          path={f.path} statusCode={f.status} staged projectId={projectId}
                          onStage={() => {}}
                          onUnstage={() => doUnstage([f.path])}
                        />
                      ))}
                      {(status?.staged.length ?? 0) === 0 && (
                        <p className="text-[11px] text-muted-foreground px-4 py-1.5 italic">Nothing staged</p>
                      )}

                      {/* unstaged */}
                      <SectionHeader
                        label="Changes"
                        count={status?.unstaged.length ?? 0}
                        className="border-t border-border"
                        action={
                          (status?.unstaged.length ?? 0) > 0
                            ? { label: "Stage all", onClick: () => doStage(status!.unstaged.map(f => f.path)) }
                            : undefined
                        }
                      />
                      {(status?.unstaged ?? []).map(f => (
                        <FileRow
                          key={`u-${f.path}`}
                          path={f.path} statusCode={f.status} staged={false} projectId={projectId}
                          onStage={() => doStage([f.path])}
                          onUnstage={() => {}}
                        />
                      ))}
                      {(status?.unstaged.length ?? 0) === 0 && (
                        <p className="text-[11px] text-muted-foreground px-4 py-1.5 italic">No unstaged changes</p>
                      )}

                      {/* untracked */}
                      {(status?.untracked.length ?? 0) > 0 && (
                        <>
                          <SectionHeader
                            label="Untracked"
                            count={status!.untracked.length}
                            className="border-t border-border"
                            action={{ label: "Stage all", onClick: () => doStage(status!.untracked) }}
                          />
                          {status!.untracked.map(f => (
                            <FileRow
                              key={`t-${f}`}
                              path={f} statusCode="?" staged={false} projectId={projectId}
                              onStage={() => doStage([f])}
                              onUnstage={() => {}}
                            />
                          ))}
                        </>
                      )}

                      {/* commit bar — pinned at bottom */}
                      <div className="sticky bottom-0 border-t border-border bg-card p-3 space-y-2 shrink-0">
                        <textarea
                          value={commitMsg}
                          onChange={e => setCommitMsg(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doCommit(); }}
                          placeholder="Commit message… (Ctrl+Enter to commit)"
                          rows={2}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button size="sm" variant="outline" onClick={doStageAll} disabled={busy !== null}>
                            Stage all
                          </Button>
                          <Button size="sm" variant="outline" onClick={doStash} disabled={busy !== null} title="Stash all uncommitted changes">
                            {busy === "stash" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                            Stash
                          </Button>
                          <Button size="sm" variant="outline" onClick={doStashPop} disabled={busy !== null} title="Apply the most recent stash">
                            {busy === "stashpop" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                            Pop stash
                          </Button>
                          <div className="flex-1" />
                          <Button
                            size="sm"
                            onClick={doCommit}
                            disabled={busy !== null || !commitMsg.trim() || (status?.staged.length ?? 0) === 0}
                          >
                            {busy === "commit"
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                              : <GitCommit className="h-3.5 w-3.5 mr-1.5" />}
                            Commit
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── BRANCHES ── */}
              {tab === "branches" && (
                <div className="p-4 space-y-4">
                  {branches.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-6 italic">
                      No branches yet — make a first commit to create one.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {branches.map(b => (
                        <div
                          key={b}
                          onClick={() => b !== currentBranch && doCheckout(b)}
                          className={cn(
                            "group flex items-center justify-between px-3 py-2 rounded-md text-xs",
                            b === currentBranch
                              ? "bg-primary/10 text-primary border border-primary/20 cursor-default"
                              : "hover:bg-accent border border-transparent cursor-pointer",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <GitBranch className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-mono">{b}</span>
                          </div>
                          {b === currentBranch
                            ? <span className="text-[10px] font-medium">current</span>
                            : (
                              <button
                                title={`Delete ${b}`}
                                onClick={e => { e.stopPropagation(); doDeleteBranch(b); }}
                                className="text-red-400/60 hover:text-red-300 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )
                          }
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="border-t border-border pt-4 space-y-2">
                    <Label className="text-xs">
                      New branch from <span className="font-mono">{currentBranch || "HEAD"}</span>
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        value={newBranch}
                        onChange={e => setNewBranch(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && doCreateBranch()}
                        placeholder="feature/my-branch"
                        className="h-8 text-xs font-mono"
                      />
                      <Button
                        size="sm"
                        onClick={doCreateBranch}
                        disabled={!newBranch.trim() || busy !== null}
                      >
                        {busy === "newbranch"
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Plus className="h-3.5 w-3.5" />
                        }
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── HISTORY ── */}
              {tab === "history" && (
                <div>
                  {loading ? (
                    <div className="flex justify-center py-10">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (status?.commits.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-10 italic">No commits yet</p>
                  ) : (
                    status!.commits.map(c => (
                      <div
                        key={c.hash}
                        className="flex items-start gap-3 px-4 py-3 border-b border-border/40 hover:bg-accent/30"
                      >
                        <GitCommit className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs truncate">{c.message}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            <span className="font-mono text-primary/80">{c.short}</span>
                            {" · "}{c.author}{" · "}{c.date}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* ── REMOTE / SETTINGS ── */}
              {tab === "remote" && (
                <div className="p-4 space-y-6">

                  {/* ── GitHub account ── */}
                  <section className="space-y-3">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      GitHub Account
                    </h3>

                    {ghUser ? (
                      /* Connected */
                      <div className="flex items-center gap-3 p-3 rounded-lg border border-green-500/30 bg-green-500/5">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ghUser.avatar_url}
                          alt={ghUser.login}
                          className="h-9 w-9 rounded-full shrink-0 border border-border"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{ghUser.name}</p>
                          <a
                            href={ghUser.html_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                          >
                            @{ghUser.login}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {ghUser.public_repos} public · {ghUser.private_repos} private repos
                          </p>
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <span className="flex items-center gap-1 text-[10px] text-green-400">
                            <Check className="h-3 w-3" /> Connected
                          </span>
                          <button
                            onClick={doDisconnectGitHub}
                            className="text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Not connected — PAT entry */
                      <div className="space-y-2">
                        <div>
                          <Label className="text-xs">Personal Access Token</Label>
                          <Input
                            type="password"
                            value={pat}
                            onChange={e => setPat(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && pat.trim() && doVerifyPat()}
                            placeholder={config?.has_pat ? "PAT saved — re-enter to reconnect" : "ghp_…"}
                            className="h-8 text-xs font-mono mt-1"
                          />
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Create one at{" "}
                            <a
                              href="https://github.com/settings/tokens/new?scopes=repo"
                              target="_blank"
                              rel="noreferrer"
                              className="underline hover:text-foreground"
                            >
                              github.com/settings/tokens
                            </a>{" "}
                            with the <span className="font-mono">repo</span> scope.
                            Stored server-side only.
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={doVerifyPat}
                            disabled={busy !== null || !pat.trim()}
                          >
                            {busy === "verifypat"
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                              : <UserCircle2 className="h-3.5 w-3.5 mr-1.5" />}
                            Connect GitHub
                          </Button>
                          {config?.has_pat && !pat && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => api.gitGitHubUser(projectId).then(setGhUser).catch(() => toast.error("PAT invalid or expired"))}
                            >
                              Use saved PAT
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* ── Repositories (visible once connected) ── */}
                  {ghUser && (
                    <section className="border-t border-border pt-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Repositories
                        </h3>
                        {!ghReposLoaded && (
                          <button
                            onClick={doLoadRepos}
                            disabled={busy === "loadrepos"}
                            className="text-[10px] text-primary hover:text-primary/80"
                          >
                            {busy === "loadrepos" ? "Loading…" : "Load repos"}
                          </button>
                        )}
                      </div>

                      {/* use existing repo */}
                      {ghReposLoaded && (
                        <div className="space-y-2">
                          <Label className="text-xs">Use existing repository</Label>
                          <div className="flex gap-2">
                            <select
                              value={selectedRepo}
                              onChange={e => setSelectedRepo(e.target.value)}
                              className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                            >
                              <option value="">— select a repo —</option>
                              {ghRepos.map(r => (
                                <option key={r.full_name} value={r.full_name}>
                                  {r.private ? "🔒 " : "🌐 "}{r.full_name}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={doUseExistingRepo}
                              disabled={!selectedRepo || busy !== null}
                            >
                              {busy === "userepo" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set remote"}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* create new repo */}
                      <div className="rounded-lg border border-border overflow-hidden">
                        <button
                          onClick={() => setShowCreateRepo(v => !v)}
                          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-accent/50 transition-colors"
                        >
                          <span className="flex items-center gap-1.5">
                            <Plus className="h-3.5 w-3.5 text-primary" />
                            Create new repository
                          </span>
                          <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", showCreateRepo && "rotate-180")} />
                        </button>

                        {showCreateRepo && (
                          <div className="border-t border-border p-3 space-y-3 bg-muted/20">
                            <div>
                              <Label className="text-xs">Repository name</Label>
                              <Input
                                value={newRepoName}
                                onChange={e => setNewRepoName(e.target.value.replace(/\s+/g, "-").toLowerCase())}
                                placeholder="my-dbt-project"
                                className="h-8 text-xs font-mono mt-1"
                              />
                            </div>
                            <div>
                              <Label className="text-xs">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                              <Input
                                value={newRepoDesc}
                                onChange={e => setNewRepoDesc(e.target.value)}
                                placeholder="dbt project for…"
                                className="h-8 text-xs mt-1"
                              />
                            </div>
                            <div className="flex items-center gap-5">
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                  type="radio"
                                  checked={!newRepoPrivate}
                                  onChange={() => setNewRepoPrivate(false)}
                                  className="accent-primary"
                                />
                                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-xs">Public</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                  type="radio"
                                  checked={newRepoPrivate}
                                  onChange={() => setNewRepoPrivate(true)}
                                  className="accent-primary"
                                />
                                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-xs">Private</span>
                              </label>
                            </div>
                            <Button
                              className="w-full"
                              onClick={doCreateGitHubRepo}
                              disabled={busy !== null || !newRepoName.trim()}
                            >
                              {busy === "createrepo"
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                                : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                              Create on GitHub &amp; set as remote
                            </Button>
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {/* ── Remote URL (manual override) ── */}
                  <section className="border-t border-border pt-5 space-y-2">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Remote URL <span className="normal-case font-normal">(manual)</span>
                    </h3>
                    <Input
                      value={remoteUrl}
                      onChange={e => setRemoteUrl(e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                      className="h-8 text-xs font-mono"
                    />
                    <Button size="sm" variant="outline" onClick={doSaveRemote} disabled={busy !== null}>
                      {busy === "remote"
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                        : <Check className="h-3.5 w-3.5 mr-1.5" />}
                      Update remote URL
                    </Button>
                  </section>

                  {/* ── Secret scrubber ── */}
                  {config?.is_git_repo && (
                    <section className="border-t border-border pt-5 space-y-2">
                      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-red-400/80">
                        Repair
                      </h3>
                      <p className="text-[11px] text-muted-foreground">
                        If a push was blocked because a secret (e.g. a PAT) was committed, this rewrites
                        the entire git history to remove <span className="font-mono">.dbt_meta.json</span> from
                        every commit, then you can push normally.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        disabled={busy !== null}
                        onClick={async () => {
                          setBusy("scrub");
                          try {
                            const r = await api.gitScrubHistory(projectId);
                            toast.success(r.message);
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Scrub failed");
                          } finally { setBusy(null); }
                        }}
                      >
                        {busy === "scrub"
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                          : <X className="h-3.5 w-3.5 mr-1.5" />}
                        Scrub secret from history
                      </Button>
                    </section>
                  )}

                  {/* ── Clone ── */}
                  {!config?.is_git_repo && (
                    <section className="border-t border-border pt-5 space-y-3">
                      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Clone
                      </h3>
                      <div className="space-y-2">
                        <div>
                          <Label className="text-xs">Repository URL</Label>
                          <Input
                            value={cloneUrl}
                            onChange={e => setCloneUrl(e.target.value)}
                            placeholder="https://github.com/user/repo.git"
                            className="h-8 text-xs font-mono mt-1"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">PAT (if private repo)</Label>
                            <Input
                              type="password"
                              value={clonePat}
                              onChange={e => setClonePat(e.target.value)}
                              placeholder="ghp_…"
                              className="h-8 text-xs font-mono mt-1"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Branch</Label>
                            <Input
                              value={cloneBranch}
                              onChange={e => setCloneBranch(e.target.value)}
                              placeholder="main"
                              className="h-8 text-xs font-mono mt-1"
                            />
                          </div>
                        </div>
                        <Button className="w-full" onClick={doClone} disabled={busy !== null || !cloneUrl.trim()}>
                          {busy === "clone"
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                            : <Download className="h-3.5 w-3.5 mr-1.5" />}
                          Clone into this project
                        </Button>
                        <p className="text-[10px] text-muted-foreground">
                          Merges the remote history into the project folder. Existing dbt files are preserved.
                        </p>
                      </div>
                    </section>
                  )}

                  {/* ── Pull Requests ── */}
                  {config?.is_git_repo && config.has_pat && (
                    <section className="border-t border-border pt-5 space-y-3">
                      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Pull Requests
                      </h3>
                      <div className="rounded-lg border border-border p-3 space-y-2">
                        <p className="text-[10px] text-muted-foreground">
                          Open PR:{" "}
                          <span className="font-mono text-foreground">{currentBranch}</span>
                          {" → "}
                          <span className="font-mono text-foreground">{prBase}</span>
                        </p>
                        <Input value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="PR title" className="h-8 text-xs" />
                        <textarea
                          value={prBody}
                          onChange={e => setPrBody(e.target.value)}
                          placeholder="Description (optional)"
                          rows={2}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="flex items-center gap-2">
                          <Label className="text-xs shrink-0">Base</Label>
                          <Input value={prBase} onChange={e => setPrBase(e.target.value)} className="h-7 text-xs font-mono w-28" />
                          <div className="flex-1" />
                          <Button size="sm" onClick={doCreatePR} disabled={busy !== null || !prTitle.trim()}>
                            {busy === "pr" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <GitPullRequest className="h-3.5 w-3.5 mr-1.5" />}
                            Open PR
                          </Button>
                        </div>
                      </div>
                      {prs.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Open ({prs.length})</p>
                          {prs.map(pr => (
                            <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer"
                              className="flex items-start gap-2.5 px-3 py-2 rounded-md border border-border hover:bg-accent text-xs transition-colors"
                            >
                              <GitPullRequest className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <p className="truncate font-medium">{pr.title}</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">#{pr.number} · {pr.head} → {pr.base} · {pr.author}</p>
                              </div>
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                            </a>
                          ))}
                        </div>
                      )}
                    </section>
                  )}
                </div>
              )}

            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── section header helper ─────────────────────────────────────────────────────

function SectionHeader({
  label, count, action, className,
}: {
  label: string;
  count: number;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between px-3 py-1.5 bg-muted/30", className)}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} ({count})
      </span>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

// ── git status badge (for the sidebar) ───────────────────────────────────────

export function GitStatusBadge({
  projectId, onClick,
}: {
  projectId: string; onClick: () => void;
}) {
  const [config, setConfig] = useState<GitConfig | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!projectId) return;
    Promise.all([api.gitGetConfig(projectId), api.gitGetStatus(projectId)])
      .then(([c, s]) => { setConfig(c); setStatus(s); })
      .catch(() => {});
  }, [projectId]);

  const hasChanges = (status?.staged.length ?? 0) +
                     (status?.unstaged.length ?? 0) +
                     (status?.untracked.length ?? 0) > 0;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-full px-3 py-1.5"
      title="Open Source Control"
    >
      <GitBranch className="h-3 w-3 shrink-0" />
      {config?.is_git_repo ? (
        <>
          <span className="font-mono truncate">{status?.branch || "git"}</span>
          {hasChanges && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" title="Uncommitted changes" />}
          {(status?.ahead ?? 0) > 0 && (
            <span className="text-green-400 flex items-center gap-0.5 shrink-0">
              <ArrowUp className="h-2.5 w-2.5" />{status!.ahead}
            </span>
          )}
          {(status?.behind ?? 0) > 0 && (
            <span className="text-amber-400 flex items-center gap-0.5 shrink-0">
              <ArrowDown className="h-2.5 w-2.5" />{status!.behind}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground/60">No git</span>
      )}
    </button>
  );
}
