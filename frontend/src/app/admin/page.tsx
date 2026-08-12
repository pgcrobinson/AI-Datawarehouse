"use client";

import { useState, useEffect, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Eye, EyeOff, Save, KeyRound, Bot, CheckCircle2, AlertCircle,
  Trash2, Plus, Users, Building2, Settings, Loader2,
  ScrollText, RefreshCw, Download, ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { AdminUser, Organisation, AISettingsResponse, LogEntry } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── AI Settings Tab ────────────────────────────────────────────────────────────
const MODELS = [
  { id: "claude-opus-4-8",  label: "Claude Opus 4.8",   desc: "Most capable — recommended" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", desc: "Balanced speed & intelligence" },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5",  desc: "Fastest & most affordable" },
];

function AISettingsTab() {
  const [current, setCurrent] = useState<AISettingsResponse | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-opus-4-8");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAISettings().then((s) => { setCurrent(s); setModel(s.model); })
      .catch(() => toast.error("Failed to load AI settings"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const payload: { model: string; anthropic_api_key?: string } = { model };
      if (apiKey.trim()) payload.anthropic_api_key = apiKey.trim();
      const updated = await api.saveAISettings(payload);
      setCurrent(updated); setApiKey("");
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><KeyRound className="h-4 w-4" />Anthropic API Key</CardTitle>
          <CardDescription className="text-xs">Used to call Claude for AI-driven warehouse generation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!loading && (current?.has_api_key ? (
            <Alert className="border-green-500/30 bg-green-500/10 py-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              <AlertDescription className="text-xs text-green-400">
                Key configured — <span className="font-mono">{current.masked_api_key}</span>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-yellow-500/30 bg-yellow-500/10 py-2">
              <AlertCircle className="h-3.5 w-3.5 text-yellow-500" />
              <AlertDescription className="text-xs text-yellow-400">No API key set.</AlertDescription>
            </Alert>
          ))}
          <div className="space-y-1.5">
            <Label className="text-xs">{current?.has_api_key ? "Replace API Key" : "API Key"}</Label>
            <div className="relative">
              <Input type={showKey ? "text" : "password"} placeholder="sk-ant-api03-…"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="pr-10 font-mono text-sm" />
              <button type="button" onClick={() => setShowKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" tabIndex={-1}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">Leave blank to keep existing key.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Bot className="h-4 w-4" />Default Model</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex items-center gap-2">
                    {m.label}
                    <span className="text-xs text-muted-foreground">— {m.desc}</span>
                    {m.id === "claude-opus-4-8" && <Badge variant="secondary" className="text-[9px] py-0">default</Badge>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-2">Active: <span className="font-mono">{current?.model ?? "—"}</span></p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || loading} className="gap-2">
          <Save className="h-4 w-4" />{saving ? "Saving…" : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}

// ── Users Tab ──────────────────────────────────────────────────────────────────
function UsersTab({ orgs }: { orgs: Organisation[] }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "designer", org_id: "" });

  useEffect(() => {
    api.listUsers().then(setUsers).catch(() => toast.error("Failed to load users")).finally(() => setLoading(false));
  }, []);

  function setField(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const payload = { ...form, org_id: form.org_id || undefined };
      const user = await api.createUser(payload);
      setUsers((u) => [...u, user]);
      setShowCreate(false);
      setForm({ email: "", name: "", password: "", role: "designer", org_id: "" });
      toast.success("User created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteUser(id);
      setUsers((u) => u.filter((x) => x.id !== id));
      toast.success("User deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{users.length} user{users.length !== 1 ? "s" : ""}</p>
        <Button size="sm" className="gap-2" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5" /> Add User
        </Button>
      </div>

      {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Name</th>
                <th className="px-4 py-2.5 text-left font-medium">Email</th>
                <th className="px-4 py-2.5 text-left font-medium">Role</th>
                <th className="px-4 py-2.5 text-left font-medium">Organisation</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-accent/20 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{u.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={u.role === "sysadmin" ? "default" : "secondary"} className="text-[10px]">
                      {u.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{u.org_name ?? "—"}</td>
                  <td className="px-2">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(u.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No users</p>
          )}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setField("name", e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setField("role", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="designer">Designer</SelectItem>
                  <SelectItem value="sysadmin">Sysadmin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Organisation <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={form.org_id} onValueChange={(v) => setField("org_id", v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />} Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Organisations Tab ──────────────────────────────────────────────────────────
function OrgsTab({ orgs, setOrgs }: { orgs: Organisation[]; setOrgs: React.Dispatch<React.SetStateAction<Organisation[]>> }) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const org = await api.createOrg(name.trim());
      setOrgs((o) => [...o, org]);
      setName(""); setShowCreate(false);
      toast.success("Organisation created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteOrg(id);
      setOrgs((o) => o.filter((x) => x.id !== id));
      toast.success("Organisation deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{orgs.length} organisation{orgs.length !== 1 ? "s" : ""}</p>
        <Button size="sm" className="gap-2" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5" /> Add Organisation
        </Button>
      </div>

      {orgs.length === 0 ? (
        <div className="rounded-lg border border-border p-10 text-center">
          <Building2 className="h-7 w-7 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">No organisations yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orgs.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
              <div>
                <p className="text-sm font-medium">{o.name}</p>
                <p className="text-xs text-muted-foreground">{o.user_count} user{o.user_count !== 1 ? "s" : ""}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(o.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New Organisation</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp" autoFocus required />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />} Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  info:  "bg-blue-500/15 text-blue-400 border-blue-500/30",
  warn:  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  error: "bg-red-500/15 text-red-400 border-red-500/30",
};

const CATEGORY_COLORS: Record<string, string> = {
  auth:  "bg-purple-500/10 text-purple-400",
  ai:    "bg-pink-500/10 text-pink-400",
  dbt:   "bg-green-500/10 text-green-400",
  git:   "bg-orange-500/10 text-orange-400",
  query: "bg-cyan-500/10 text-cyan-400",
  admin: "bg-yellow-500/10 text-yellow-400",
  error: "bg-red-500/10 text-red-400",
};

function LogsTab() {
  const [entries, setEntries]       = useState<LogEntry[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(false);
  const [expanded, setExpanded]     = useState<string | null>(null);

  const [filterLevel,    setFilterLevel]    = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterUser,     setFilterUser]     = useState("");
  const [filterSearch,   setFilterSearch]   = useState("");

  const PAGE_SIZE = 100;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const r = await api.listLogs({
        level:      filterLevel    || undefined,
        category:   filterCategory || undefined,
        user_email: filterUser     || undefined,
        search:     filterSearch   || undefined,
        page: p,
      });
      setEntries(r.entries);
      setTotal(r.total);
    } catch {
      toast.error("Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [filterLevel, filterCategory, filterUser, filterSearch, page]);

  useEffect(() => { load(1); setPage(1); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterLevel, filterCategory, filterUser, filterSearch]);

  useEffect(() => { load(page); }, [page, load]);

  async function handleClear() {
    if (!confirm("Delete all log entries? This cannot be undone.")) return;
    try {
      const r = await api.clearLogs();
      toast.success(`Cleared ${r.deleted} entries`);
      load(1); setPage(1);
    } catch { toast.error("Failed to clear logs"); }
  }

  function handleExport() {
    window.open(api.exportLogsUrl(filterLevel || undefined, filterCategory || undefined), "_blank");
  }

  function formatTs(ts: string) {
    return new Date(ts).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  return (
    <div className="space-y-4">
      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filterLevel || "all"} onValueChange={v => setFilterLevel(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="All levels" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterCategory || "all"} onValueChange={v => setFilterCategory(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {["auth","ai","dbt","git","query","admin","error"].map(c => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          placeholder="Filter by user…"
          className="h-8 text-xs w-44"
        />

        <Input
          value={filterSearch}
          onChange={e => setFilterSearch(e.target.value)}
          placeholder="Search messages…"
          className="h-8 text-xs w-48"
        />

        <div className="flex-1" />

        <span className="text-xs text-muted-foreground">{total.toLocaleString()} entries</span>

        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => load(page)} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={handleExport} title="Export CSV">
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 border-red-500/40 text-red-400 hover:bg-red-500/10" onClick={handleClear}>
          <Trash2 className="h-3.5 w-3.5" /> Clear all
        </Button>
      </div>

      {/* log table */}
      <div className="rounded-lg border border-border overflow-hidden">
        {loading && entries.length === 0 ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">No log entries match the current filters.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium w-36">Time</th>
                <th className="px-3 py-2 text-left font-medium w-16">Level</th>
                <th className="px-3 py-2 text-left font-medium w-20">Category</th>
                <th className="px-3 py-2 text-left font-medium">Message</th>
                <th className="px-3 py-2 text-left font-medium w-36">User</th>
                <th className="px-3 py-2 text-right font-medium w-20">Duration</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {entries.map(e => (
                <>
                  <tr
                    key={e.id}
                    onClick={() => setExpanded(ex => ex === e.id ? null : e.id)}
                    className={cn(
                      "hover:bg-accent/20 cursor-pointer transition-colors",
                      e.level === "error" && "bg-red-500/5",
                      e.level === "warn"  && "bg-amber-500/5",
                    )}
                  >
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                      {formatTs(e.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium", LEVEL_COLORS[e.level])}>
                        {e.level}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium", CATEGORY_COLORS[e.category] ?? "bg-muted text-muted-foreground")}>
                        {e.category}
                      </span>
                    </td>
                    <td className="px-3 py-2 max-w-0">
                      <p className="truncate">{e.message}</p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-0">{e.user_email ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground font-mono">
                      {e.duration_ms != null ? `${e.duration_ms}ms` : ""}
                    </td>
                    <td className="px-2 text-muted-foreground">
                      {e.detail ? (expanded === e.id
                        ? <ChevronDown className="h-3 w-3" />
                        : <ChevronRightIcon className="h-3 w-3" />
                      ) : null}
                    </td>
                  </tr>
                  {expanded === e.id && e.detail && (
                    <tr key={`${e.id}-detail`} className="bg-muted/20">
                      <td colSpan={7} className="px-4 py-3">
                        <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" className="h-7 w-7 p-0"
            onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main Admin Page ────────────────────────────────────────────────────────────
export default function AdminPage() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<Organisation[]>([]);

  useEffect(() => {
    if (user?.role === "sysadmin") {
      api.listOrgs().then(setOrgs).catch(() => {});
    }
  }, [user]);

  if (user?.role !== "sysadmin") {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Admin access required. Only sysadmin users can view this page.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Administration</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage users, organisations, and AI configuration.</p>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-3.5 w-3.5" /> Users
          </TabsTrigger>
          <TabsTrigger value="orgs" className="gap-2">
            <Building2 className="h-3.5 w-3.5" /> Organisations
          </TabsTrigger>
          <TabsTrigger value="ai" className="gap-2">
            <Settings className="h-3.5 w-3.5" /> AI Settings
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="h-3.5 w-3.5" /> Logs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4">
          <UsersTab orgs={orgs} />
        </TabsContent>
        <TabsContent value="orgs" className="mt-4">
          <OrgsTab orgs={orgs} setOrgs={setOrgs} />
        </TabsContent>
        <TabsContent value="ai" className="mt-4">
          <AISettingsTab />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <LogsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
