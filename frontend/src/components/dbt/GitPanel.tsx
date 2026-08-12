"use client";

import { useState, useEffect, useCallback } from "react";
import {
  GitBranch, GitPullRequest, RefreshCw, ChevronDown, ChevronRight,
  ArrowUp, ArrowDown, Loader2, ExternalLink, X, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { GitConfig, GitStatus, GitPR } from "@/lib/types";

interface Props {
  projectId: string;
}

const STATUS_COLOR: Record<string, string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
};

export function GitPanel({ projectId }: Props) {
  const [config, setConfig]       = useState<GitConfig | null>(null);
  const [status, setStatus]       = useState<GitStatus | null>(null);
  const [loading, setLoading]     = useState(false);

  // Setup form
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pat, setPat]             = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [cloneMode, setCloneMode] = useState(false);
  const [cloneBranch, setCloneBranch] = useState("main");

  // Commit
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing]     = useState(false);
  const [pulling, setPulling]     = useState(false);

  // Branch
  const [newBranch, setNewBranch] = useState("");
  const [showBranchInput, setShowBranchInput] = useState(false);

  // PR dialog
  const [prs, setPrs]             = useState<GitPR[]>([]);
  const [showPRDialog, setShowPRDialog] = useState(false);
  const [prTitle, setPrTitle]     = useState("");
  const [prBody, setPrBody]       = useState("");
  const [prBase, setPrBase]       = useState("main");

  // Section collapse state
  const [stagedOpen, setStagedOpen]   = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [prsOpen, setPrsOpen]         = useState(false);

  // Feedback
  const [notice, setNotice] = useState<{ msg: string; err: boolean } | null>(null);

  function notify(msg: string, err = false) {
    setNotice({ msg, err });
    setTimeout(() => setNotice(null), 3500);
  }

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [cfg, stat] = await Promise.all([
        api.gitGetConfig(projectId),
        api.gitGetStatus(projectId),
      ]);
      setConfig(cfg);
      setStatus(stat);
      if (!remoteUrl) setRemoteUrl(cfg.remote_url || "");
    } catch {
      // silently ignore — project may not exist yet
    } finally {
      setLoading(false);
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  // Load PRs when section opened
  useEffect(() => {
    if (prsOpen && projectId) {
      api.gitListPRs(projectId).then(r => setPrs(r.prs)).catch(() => {});
    }
  }, [prsOpen, projectId]);

  // ── actions ──────────────────────────────────────────────────────────────

  async function handleSaveConfig() {
    try {
      await api.gitSetConfig(projectId, remoteUrl, pat);
      setPat("");
      notify("GitHub settings saved");
      setShowSetup(false);
      await refresh();
    } catch (e: unknown) { notify((e as Error).message || "Save failed", true); }
  }

  async function handleInit() {
    try {
      const r = await api.gitInit(projectId);
      notify(r.message);
      await refresh();
    } catch (e: unknown) { notify((e as Error).message || "Init failed", true); }
  }

  async function handleClone() {
    try {
      const r = await api.gitClone(projectId, remoteUrl, pat, cloneBranch);
      notify(r.message);
      setShowSetup(false);
      await refresh();
    } catch (e: unknown) { notify((e as Error).message || "Clone failed", true); }
  }

  async function handleStage(paths: string[]) {
    try { await api.gitStage(projectId, paths); await refresh(); }
    catch (e: unknown) { notify((e as Error).message, true); }
  }

  async function handleUnstage(paths: string[]) {
    try { await api.gitUnstage(projectId, paths); await refresh(); }
    catch (e: unknown) { notify((e as Error).message, true); }
  }

  async function handleStageAll() {
    try { await api.gitStageAll(projectId); await refresh(); }
    catch (e: unknown) { notify((e as Error).message, true); }
  }

  async function handleCommit(andPush = false) {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    try {
      await api.gitCommit(projectId, commitMsg.trim());
      setCommitMsg("");
      if (andPush) {
        setPushing(true);
        try { await api.gitPush(projectId); notify("Committed and pushed"); }
        catch (e: unknown) { notify((e as Error).message || "Push failed", true); }
        finally { setPushing(false); }
      } else {
        notify("Committed");
      }
      await refresh();
    } catch (e: unknown) { notify((e as Error).message || "Commit failed", true); }
    finally { setCommitting(false); }
  }

  async function handlePush() {
    setPushing(true);
    try { await api.gitPush(projectId); notify("Pushed to remote"); await refresh(); }
    catch (e: unknown) { notify((e as Error).message || "Push failed", true); }
    finally { setPushing(false); }
  }

  async function handlePull() {
    setPulling(true);
    try { await api.gitPull(projectId); notify("Pulled from remote"); await refresh(); }
    catch (e: unknown) { notify((e as Error).message || "Pull failed", true); }
    finally { setPulling(false); }
  }

  async function handleCreateBranch() {
    if (!newBranch.trim()) return;
    try {
      await api.gitBranch(projectId, newBranch.trim(), true);
      notify(`Switched to '${newBranch}'`);
      setNewBranch("");
      setShowBranchInput(false);
      await refresh();
    } catch (e: unknown) { notify((e as Error).message, true); }
  }

  async function handleCreatePR() {
    if (!prTitle.trim()) return;
    const head = status?.branch || "";
    if (!head) { notify("Cannot determine current branch", true); return; }
    if (head === prBase) { notify(`Head and base are both '${head}' — switch to a feature branch first`, true); return; }
    try {
      const r = await api.gitCreatePR(projectId, prTitle.trim(), prBody.trim(), head, prBase);
      setShowPRDialog(false);
      if (r.pr_url) window.open(r.pr_url, "_blank");
      notify(`PR #${r.pr_number} created`);
    } catch (e: unknown) { notify((e as Error).message || "PR creation failed", true); }
  }

  // ── derived ──────────────────────────────────────────────────────────────

  const isRepo     = status?.is_git_repo ?? false;
  const hasRemote  = !!(config?.remote_url);
  const hasPat     = !!(config?.has_pat);
  const hasStaged  = (status?.staged.length ?? 0) > 0;
  const totalUnsaved = (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0);
  const isFeatureBranch = isRepo && !!status?.branch
    && status.branch !== "main" && status.branch !== "master";

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex flex-col h-full overflow-hidden text-xs">

      {/* ── Branch header ── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono text-[11px] flex-1 truncate text-muted-foreground">
          {isRepo ? (status?.branch || "no branch") : "not a git repo"}
        </span>
        {isRepo && (status?.behind ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-yellow-400 text-[10px]">
            <ArrowDown className="h-2.5 w-2.5" />{status!.behind}
          </span>
        )}
        {isRepo && (status?.ahead ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-green-400 text-[10px]">
            <ArrowUp className="h-2.5 w-2.5" />{status!.ahead}
          </span>
        )}
        <button onClick={refresh} className="p-0.5 rounded hover:bg-accent transition-colors shrink-0">
          <RefreshCw className={cn("h-3 w-3 text-muted-foreground", loading && "animate-spin")} />
        </button>
      </div>

      {/* ── Notice bar ── */}
      {notice && (
        <div className={cn(
          "px-3 py-1 text-[11px] shrink-0 flex items-center justify-between gap-2",
          notice.err ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400",
        )}>
          <span className="flex-1 truncate">{notice.msg}</span>
          <button onClick={() => setNotice(null)}><X className="h-3 w-3" /></button>
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-2">

          {/* ── Setup / connect ── */}
          {(!isRepo || showSetup) && (
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {showSetup ? "GitHub settings" : "Connect to GitHub"}
                </p>
                {showSetup && (
                  <button onClick={() => setShowSetup(false)}>
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">Repository URL</label>
                <Input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/you/repo.git"
                  className="h-7 text-[11px] font-mono" />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">
                  Personal Access Token
                  <span className="ml-1 opacity-50">(repo scope)</span>
                </label>
                <Input type="password" value={pat} onChange={e => setPat(e.target.value)}
                  placeholder={hasPat ? "••••••• (blank to keep existing)" : "ghp_xxxxxxxxxxxx"}
                  className="h-7 text-[11px] font-mono" />
              </div>

              {cloneMode && (
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Branch to clone</label>
                  <Input value={cloneBranch} onChange={e => setCloneBranch(e.target.value)}
                    placeholder="main" className="h-7 text-[11px] font-mono" />
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <Button size="sm" className="h-6 text-[11px] px-2.5" onClick={handleSaveConfig}>
                  Save settings
                </Button>
                {!isRepo && (
                  <>
                    <Button size="sm" variant="outline" className="h-6 text-[11px] px-2.5" onClick={handleInit}>
                      Init repo
                    </Button>
                    <Button
                      size="sm" variant="outline" className="h-6 text-[11px] px-2.5"
                      onClick={() => cloneMode ? handleClone() : setCloneMode(true)}
                    >
                      {cloneMode ? "Clone now" : "Clone repo"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {isRepo && (
            <>
              {/* ── Remote actions ── */}
              {hasRemote ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="flex-1 h-7 text-[11px] gap-1"
                    onClick={handlePull} disabled={pulling}>
                    {pulling ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDown className="h-3 w-3" />}
                    Pull
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 h-7 text-[11px] gap-1"
                    onClick={handlePush} disabled={pushing}>
                    {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
                    Push
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground"
                    onClick={() => setShowSetup(s => !s)} title="GitHub settings">
                    ⚙
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px]"
                  onClick={() => setShowSetup(true)}>
                  Connect to GitHub remote
                </Button>
              )}

              {/* ── Staged changes ── */}
              <div className="rounded-md border border-border overflow-hidden">
                <button onClick={() => setStagedOpen(s => !s)}
                  className="flex items-center gap-1 w-full px-2 py-1.5 bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/50 transition-colors">
                  {stagedOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="flex-1 text-left">Staged ({status?.staged.length ?? 0})</span>
                  {(status?.staged.length ?? 0) > 0 && (
                    <button
                      onMouseDown={e => { e.stopPropagation(); handleUnstage(status!.staged.map(f => f.path)); }}
                      className="text-[10px] normal-case font-normal text-muted-foreground hover:text-foreground hover:underline mr-0.5"
                      title="Unstage all">
                      Unstage All
                    </button>
                  )}
                </button>
                {stagedOpen && (
                  <div className="divide-y divide-border/50">
                    {(status?.staged.length ?? 0) === 0 && (
                      <p className="px-3 py-2 text-[10px] text-muted-foreground/50 italic">Nothing staged — use + below to stage files</p>
                    )}
                    {status?.staged.map(f => (
                      <div key={f.path}
                        className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30 group transition-colors">
                        <span className={cn("font-mono text-[10px] w-3 shrink-0 font-bold", STATUS_COLOR[f.status] ?? "text-muted-foreground")}>
                          {f.status}
                        </span>
                        <span className="flex-1 truncate font-mono text-[10px] text-foreground/80" title={f.path}>
                          {f.path}
                        </span>
                        <button
                          onClick={() => handleUnstage([f.path])}
                          title="Unstage this file"
                          className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent hover:border-border transition-all">
                          − Unstage
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Unstaged + untracked ── */}
              <div className="rounded-md border border-border overflow-hidden">
                <button onClick={() => setChangesOpen(s => !s)}
                  className="flex items-center gap-1 w-full px-2 py-1.5 bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/50 transition-colors">
                  {changesOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="flex-1 text-left">Changes ({totalUnsaved})</span>
                  {totalUnsaved > 0 && (
                    <button
                      onMouseDown={e => { e.stopPropagation(); handleStageAll(); }}
                      className="text-[10px] normal-case font-normal text-primary hover:underline mr-0.5"
                      title="Stage all changes">
                      Stage All
                    </button>
                  )}
                </button>
                {changesOpen && (
                  <div className="divide-y divide-border/50">
                    {totalUnsaved === 0 && (
                      <p className="px-3 py-2 text-[10px] text-muted-foreground/50 italic">No unstaged changes</p>
                    )}
                    {status?.unstaged.map(f => (
                      <div key={`u-${f.path}`}
                        className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30 group transition-colors">
                        <span className={cn("font-mono text-[10px] w-3 shrink-0 font-bold", STATUS_COLOR[f.status] ?? "text-muted-foreground")}>
                          {f.status}
                        </span>
                        <span className="flex-1 truncate font-mono text-[10px] text-foreground/80" title={f.path}>
                          {f.path}
                        </span>
                        <button
                          onClick={() => handleStage([f.path])}
                          title="Stage this file"
                          className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-primary hover:bg-primary/10 border border-transparent hover:border-primary/30 transition-all">
                          + Stage
                        </button>
                      </div>
                    ))}
                    {status?.untracked.map(f => (
                      <div key={`t-${f}`}
                        className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30 group transition-colors">
                        <span className="font-mono text-[10px] w-3 shrink-0 font-bold text-muted-foreground/60">U</span>
                        <span className="flex-1 truncate font-mono text-[10px] text-foreground/80" title={f}>
                          {f}
                        </span>
                        <button
                          onClick={() => handleStage([f])}
                          title="Stage this file"
                          className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-primary hover:bg-primary/10 border border-transparent hover:border-primary/30 transition-all">
                          + Stage
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Commit form ── */}
              <div className="space-y-1.5">
                <Textarea
                  value={commitMsg}
                  onChange={e => setCommitMsg(e.target.value)}
                  placeholder={hasStaged ? "Commit message (Ctrl+Enter to commit)…" : "Stage changes to commit…"}
                  disabled={!hasStaged}
                  className="text-[11px] resize-none min-h-[48px] font-mono"
                  rows={2}
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleCommit(false);
                    }
                  }}
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="flex-1 h-6 text-[11px]"
                    disabled={!commitMsg.trim() || !hasStaged || committing}
                    onClick={() => handleCommit(false)}>
                    {committing && !pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Commit"}
                  </Button>
                  {hasRemote && (
                    <Button size="sm" variant="outline" className="flex-1 h-6 text-[11px]"
                      disabled={!commitMsg.trim() || !hasStaged || committing || pushing}
                      onClick={() => handleCommit(true)}>
                      {committing && pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Commit & Push"}
                    </Button>
                  )}
                </div>
              </div>

              {/* ── Branch ── */}
              <div className="space-y-1">
                <div className="flex items-center">
                  <span className="flex-1 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Branch</span>
                  <button onClick={() => setShowBranchInput(s => !s)}
                    className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
                    <Plus className="h-2.5 w-2.5" /> New
                  </button>
                </div>
                {showBranchInput && (
                  <div className="flex gap-1">
                    <Input value={newBranch} onChange={e => setNewBranch(e.target.value)}
                      placeholder="feature/my-branch" className="h-6 text-[11px] flex-1"
                      onKeyDown={e => e.key === "Enter" && handleCreateBranch()} />
                    <Button size="sm" className="h-6 px-2 text-[10px]" onClick={handleCreateBranch}>
                      Create
                    </Button>
                  </div>
                )}
                <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">{status?.branch}</span>
                </div>
              </div>

              {/* ── Recent commits ── */}
              <div>
                <button onClick={() => setCommitsOpen(s => !s)}
                  className="flex items-center gap-1 w-full py-0.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors">
                  {commitsOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  History
                </button>
                {commitsOpen && (
                  <div className="mt-0.5 space-y-1">
                    {(status?.commits.length ?? 0) === 0 && (
                      <p className="pl-4 text-[10px] text-muted-foreground/50">No commits yet</p>
                    )}
                    {status?.commits.map(c => (
                      <div key={c.hash} className="pl-4">
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono text-[9px] text-muted-foreground/40 shrink-0">{c.short}</span>
                          <span className="text-[11px] text-muted-foreground truncate">{c.message}</span>
                        </div>
                        <p className="text-[9px] text-muted-foreground/40 pl-[26px]">{c.author} · {c.date}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Pull Requests ── */}
              {hasRemote && hasPat && (
                <div>
                  <button onClick={() => setPrsOpen(s => !s)}
                    className="flex items-center gap-1 w-full py-0.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors">
                    {prsOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <span className="flex-1 text-left">Pull Requests</span>
                    {prsOpen && prs.length > 0 && (
                      <span className="text-[10px] normal-case font-normal">{prs.length} open</span>
                    )}
                  </button>
                  {prsOpen && (
                    <div className="mt-1 space-y-1">
                      {isFeatureBranch && (
                        <Button size="sm" variant="outline" className="w-full h-6 text-[11px] gap-1.5"
                          onClick={() => {
                            setPrTitle(`Merge ${status?.branch ?? ""} into main`);
                            setPrBase("main");
                            setShowPRDialog(true);
                          }}>
                          <GitPullRequest className="h-3 w-3" />
                          Create PR from {status?.branch}
                        </Button>
                      )}
                      {prs.length === 0 && (
                        <p className="pl-4 text-[10px] text-muted-foreground/50">No open pull requests</p>
                      )}
                      {prs.map(pr => (
                        <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer"
                          className="flex items-start gap-1.5 pl-4 py-0.5 rounded hover:bg-accent/40 transition-colors group">
                          <GitPullRequest className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-muted-foreground/50">#{pr.number}</span>
                              <span className="text-[11px] text-muted-foreground truncate group-hover:text-foreground">{pr.title}</span>
                            </div>
                            <p className="text-[9px] text-muted-foreground/40">{pr.head} → {pr.base} · {pr.author}</p>
                          </div>
                          <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/30 group-hover:text-muted-foreground shrink-0 mt-0.5 ml-auto" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* ── PR creation overlay ── */}
      {showPRDialog && (
        <div className="absolute inset-0 z-50 bg-background flex flex-col">
          {/* Dialog header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <GitPullRequest className="h-4 w-4 text-green-500" /> Create Pull Request
            </span>
            <button onClick={() => setShowPRDialog(false)}
              className="p-1 rounded hover:bg-accent transition-colors">
              <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
            </button>
          </div>

          {/* Dialog body */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">Title</label>
              <Input value={prTitle} onChange={e => setPrTitle(e.target.value)}
                className="h-8 text-sm text-foreground bg-background" autoFocus
                placeholder="e.g. Add staging models for orders" />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">Description <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Textarea value={prBody} onChange={e => setPrBody(e.target.value)}
                className="text-sm text-foreground bg-background resize-none" rows={4}
                placeholder="What does this PR change?" />
            </div>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Branches</p>
              <div className="flex items-center gap-2 text-xs text-foreground">
                <span className="text-muted-foreground">From</span>
                <code className="bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono text-[11px] border border-primary/20">
                  {status?.branch}
                </code>
                <span className="text-muted-foreground">into</span>
                <Input value={prBase} onChange={e => setPrBase(e.target.value)}
                  className="h-7 text-[11px] font-mono text-foreground bg-background w-28" />
              </div>
            </div>
          </div>

          {/* Error notice inside dialog */}
          {notice?.err && (
            <div className="mx-4 mb-1 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-start gap-2">
              <X className="h-3 w-3 shrink-0 mt-0.5" />
              <span>{notice.msg}</span>
            </div>
          )}

          {/* Dialog footer */}
          <div className="flex gap-2 px-4 py-3 border-t border-border shrink-0">
            <Button size="sm" className="flex-1 h-8 text-sm gap-1.5"
              disabled={!prTitle.trim() || (status?.branch || "") === prBase}
              onClick={handleCreatePR}>
              <ExternalLink className="h-3.5 w-3.5" /> Open on GitHub
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-sm text-foreground"
              onClick={() => setShowPRDialog(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
