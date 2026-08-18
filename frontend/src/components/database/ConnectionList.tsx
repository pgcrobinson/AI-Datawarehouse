"use client";

import { useState } from "react";
import { Plug, Trash2, CheckCircle2, Server, FlaskConical, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { Connection, ConnectionConfig, DbType, AuthType } from "@/lib/types";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface Props {
  connections: Connection[];
  onChanged: () => void;
}

const DB_TYPE_LABELS: Record<DbType, string> = {
  azure_sql:  "Azure SQL",
  bigquery:   "BigQuery",
  snowflake:  "Snowflake",
  databricks: "Databricks",
};

const DB_TYPE_COLORS: Record<DbType, string> = {
  azure_sql:  "bg-blue-950 text-blue-300 border-blue-800",
  bigquery:   "bg-amber-950 text-amber-300 border-amber-800",
  snowflake:  "bg-sky-950 text-sky-300 border-sky-800",
  databricks: "bg-orange-950 text-orange-300 border-orange-800",
};

interface EditForm {
  name: string;
  server: string;
  database: string;
  auth_type: string;
  username: string;
  password: string;
  port: number;
  warehouse: string;
  schema_name: string;
  http_path: string;
  project_id: string;
  credentials_json: string;
}

function connectionSubtitle(c: Connection): string {
  const type = c.db_type ?? "azure_sql";
  if (type === "bigquery") {
    const parts = [c.project_id, c.database].filter(Boolean);
    return parts.length ? parts.join(" · ") : "BigQuery";
  }
  if (type === "snowflake") {
    const parts = [c.server, c.database, c.warehouse].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Snowflake";
  }
  if (type === "databricks") {
    const parts = [c.server, c.database || "hive_metastore"].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Databricks";
  }
  const parts = [c.server, c.database].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Azure SQL";
}

export function ConnectionList({ connections, onChanged }: Props) {
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [testing, setTesting]       = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [confirmId, setConfirmId]   = useState<string | null>(null);

  // Edit dialog state
  const [editConn, setEditConn]         = useState<Connection | null>(null);
  const [editForm, setEditForm]         = useState<EditForm | null>(null);
  const [editSaving, setEditSaving]     = useState(false);
  const [editTestState, setEditTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [editTestMsg, setEditTestMsg]   = useState("");

  async function testConn(id: string) {
    setTesting(id);
    setTestResult((r) => ({ ...r, [id]: { ok: false, msg: "" } }));
    try {
      const res = await api.testSavedConnection(id);
      setTestResult((r) => ({ ...r, [id]: { ok: res.success, msg: res.message } }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, msg: e instanceof Error ? e.message : "Error" } }));
    } finally {
      setTesting(null);
    }
  }

  async function activate(id: string) {
    setActivating(id);
    try {
      await api.activateConnection(id);
      toast.success("Connection activated");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setActivating(null);
    }
  }

  async function remove(id: string) {
    setDeleting(id);
    try {
      await api.deleteConnection(id);
      toast.success("Connection deleted");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setDeleting(null);
      setConfirmId(null);
    }
  }

  function openEdit(c: Connection) {
    setEditConn(c);
    setEditForm({
      name:             c.name,
      server:           c.server       ?? "",
      database:         c.database     ?? "",
      auth_type:        c.auth_type    ?? "sql_server",
      username:         c.username     ?? "",
      password:         "",
      port:             c.port         ?? 1433,
      warehouse:        c.warehouse    ?? "",
      schema_name:      c.schema_name  ?? "",
      http_path:        c.http_path    ?? "",
      project_id:       c.project_id   ?? "",
      credentials_json: "",
    });
    setEditTestState("idle");
    setEditTestMsg("");
  }

  function setField(k: keyof EditForm, v: string | number) {
    setEditForm((f) => f ? { ...f, [k]: v } : f);
  }

  async function handleEditTest() {
    if (!editConn || !editForm) return;
    setEditTestState("testing");
    try {
      const config: Partial<ConnectionConfig> = buildUpdatePayload(editConn, editForm, true);
      const res = await api.testConnection(config as Omit<ConnectionConfig, "name">);
      setEditTestState(res.success ? "ok" : "error");
      setEditTestMsg(res.message);
    } catch (e) {
      setEditTestState("error");
      setEditTestMsg(e instanceof Error ? e.message : "Test failed");
    }
  }

  function buildUpdatePayload(
    conn: Connection,
    form: EditForm,
    includeAll = false,
  ): Partial<ConnectionConfig> {
    const base: Partial<ConnectionConfig> = { name: form.name, db_type: conn.db_type };
    const dbType = conn.db_type;

    if (dbType === "azure_sql" || includeAll) {
      base.server    = form.server;
      base.database  = form.database;
      base.auth_type = form.auth_type as AuthType;
      base.username  = form.username;
      base.port      = Number(form.port);
    }
    if (dbType === "bigquery") {
      base.project_id = form.project_id;
      base.database   = form.database;
      if (form.credentials_json.trim()) base.credentials_json = form.credentials_json;
    }
    if (dbType === "snowflake") {
      base.server      = form.server;
      base.database    = form.database;
      base.schema_name = form.schema_name;
      base.warehouse   = form.warehouse;
      base.username    = form.username;
    }
    if (dbType === "databricks") {
      base.server    = form.server;
      base.http_path = form.http_path;
      base.database  = form.database;
    }
    // Only include password if the user actually typed one
    if (form.password) base.password = form.password;
    return base;
  }

  async function saveEdit() {
    if (!editConn || !editForm) return;
    if (!editForm.name.trim()) { toast.error("Connection name is required"); return; }
    setEditSaving(true);
    try {
      await api.updateConnection(editConn.id, buildUpdatePayload(editConn, editForm));
      toast.success("Connection updated");
      setEditConn(null);
      setEditForm(null);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setEditSaving(false);
    }
  }

  if (connections.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Server className="h-8 w-8 opacity-40" />
          <p className="text-sm">No connections yet. Add one above.</p>
        </CardContent>
      </Card>
    );
  }

  const dbType = editConn?.db_type ?? "azure_sql";

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Saved Connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {connections.map((c) => {
            const cDbType: DbType = (c.db_type ?? "azure_sql") as DbType;
            return (
              <div
                key={c.id}
                className={`flex items-center justify-between rounded-lg border px-4 py-3 transition-colors ${
                  c.is_active ? "border-primary/40 bg-primary/5" : "border-border bg-background"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{c.name}</span>
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${DB_TYPE_COLORS[cDbType]}`}>
                      {DB_TYPE_LABELS[cDbType]}
                    </span>
                    {c.is_active && (
                      <Badge variant="default" className="text-xs py-0">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {connectionSubtitle(c)}
                  </p>
                  {testResult[c.id]?.msg && (
                    <p className={`text-[11px] mt-1 ${testResult[c.id].ok ? "text-green-400" : "text-red-400"}`}>
                      {testResult[c.id].ok ? "✓ " : "✗ "}{testResult[c.id].msg}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => testConn(c.id)}
                    disabled={testing === c.id}
                    title="Test connection"
                  >
                    {testing === c.id
                      ? <Plug className="h-4 w-4 animate-pulse" />
                      : <FlaskConical className="h-4 w-4" />}
                  </Button>
                  {!c.is_active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => activate(c.id)}
                      disabled={activating === c.id}
                      title="Set as active connection"
                    >
                      <Plug className="h-4 w-4" />
                    </Button>
                  )}
                  {c.is_active && (
                    <CheckCircle2 className="h-4 w-4 text-primary mr-2" />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(c)}
                    title="Edit connection"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmId(c.id)}
                    disabled={deleting === c.id}
                    title="Delete connection"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Edit dialog ───────────────────────────────────────────────────────── */}
      <Dialog open={!!editConn} onOpenChange={(o) => { if (!o) { setEditConn(null); setEditForm(null); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Connection</DialogTitle>
            <DialogDescription>
              Update connection details or re-authenticate.
            </DialogDescription>
          </DialogHeader>

          {editForm && (
            <div className="space-y-4 py-2">
              {/* Connection name — always shown */}
              <div className="space-y-1.5">
                <Label>Connection name</Label>
                <Input
                  value={editForm.name}
                  onChange={(e) => setField("name", e.target.value)}
                />
              </div>

              {/* ── BigQuery ── */}
              {dbType === "bigquery" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Project ID</Label>
                    <Input
                      value={editForm.project_id}
                      onChange={(e) => setField("project_id", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Dataset</Label>
                    <Input
                      value={editForm.database}
                      onChange={(e) => setField("database", e.target.value)}
                    />
                  </div>

                  {/* Re-authenticate section */}
                  <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                    <p className="text-sm font-medium">Google Authentication</p>
                    {editConn?.oauth_connected && (
                      <p className="text-[12px] text-green-400">
                        ✓ Currently authenticated via Google OAuth
                      </p>
                    )}
                    <p className="text-[12px] text-muted-foreground">
                      Click below to re-run the Google sign-in flow and refresh your credentials.
                      This is required after an app restart or if the token has expired.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => {
                        const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
                        const params = new URLSearchParams({
                          name:       editForm.name       || editConn!.name,
                          project_id: editForm.project_id || editConn!.project_id || "",
                          dataset:    editForm.database   || editConn!.database   || "",
                          conn_id:    editConn!.id,
                        });
                        window.location.href = `${base}/api/database/bigquery/oauth/start?${params}`;
                      }}
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden>
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      Re-authenticate with Google
                    </Button>
                  </div>

                  <details className="group">
                    <summary className="text-[12px] text-muted-foreground cursor-pointer select-none hover:text-foreground list-none flex items-center gap-1.5">
                      <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                      Advanced: replace service account key
                    </summary>
                    <div className="mt-3 space-y-1.5">
                      <Label className="text-[12px]">Service account key JSON</Label>
                      <Textarea
                        placeholder={'{\n  "type": "service_account",\n  ...\n}'}
                        className="font-mono text-xs h-28 resize-none"
                        value={editForm.credentials_json}
                        onChange={(e) => setField("credentials_json", e.target.value)}
                      />
                    </div>
                  </details>
                </>
              )}

              {/* ── Azure SQL ── */}
              {dbType === "azure_sql" && (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-3 space-y-1.5">
                      <Label>Server</Label>
                      <Input
                        value={editForm.server}
                        onChange={(e) => setField("server", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        value={editForm.port}
                        onChange={(e) => setField("port", Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Database</Label>
                    <Input
                      value={editForm.database}
                      onChange={(e) => setField("database", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Authentication</Label>
                    <Select
                      value={editForm.auth_type}
                      onValueChange={(v) => setField("auth_type", v)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sql_server">SQL Server Authentication</SelectItem>
                        <SelectItem value="windows">Windows Authentication</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {editForm.auth_type === "sql_server" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Username</Label>
                        <Input
                          value={editForm.username}
                          onChange={(e) => setField("username", e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Password</Label>
                        <Input
                          type="password"
                          placeholder="Leave blank to keep current"
                          value={editForm.password}
                          onChange={(e) => setField("password", e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── Snowflake ── */}
              {dbType === "snowflake" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Account identifier</Label>
                    <Input
                      value={editForm.server}
                      onChange={(e) => setField("server", e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Database</Label>
                      <Input
                        value={editForm.database}
                        onChange={(e) => setField("database", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Schema</Label>
                      <Input
                        value={editForm.schema_name}
                        onChange={(e) => setField("schema_name", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Warehouse</Label>
                    <Input
                      value={editForm.warehouse}
                      onChange={(e) => setField("warehouse", e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Username</Label>
                      <Input
                        value={editForm.username}
                        onChange={(e) => setField("username", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Password</Label>
                      <Input
                        type="password"
                        placeholder="Leave blank to keep current"
                        value={editForm.password}
                        onChange={(e) => setField("password", e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* ── Databricks ── */}
              {dbType === "databricks" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Server hostname</Label>
                    <Input
                      value={editForm.server}
                      onChange={(e) => setField("server", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>HTTP path</Label>
                    <Input
                      value={editForm.http_path}
                      onChange={(e) => setField("http_path", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Catalog</Label>
                    <Input
                      value={editForm.database}
                      onChange={(e) => setField("database", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Personal access token</Label>
                    <Input
                      type="password"
                      placeholder="Leave blank to keep current"
                      value={editForm.password}
                      onChange={(e) => setField("password", e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* Test result */}
              {dbType !== "bigquery" && editTestState !== "idle" && (
                <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                  editTestState === "ok"
                    ? "bg-green-950/40 text-green-400"
                    : editTestState === "error"
                    ? "bg-red-950/40 text-red-400"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {editTestState === "testing" && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span className="truncate">{editTestState === "testing" ? "Testing…" : editTestMsg}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            {dbType !== "bigquery" && (
              <Button
                variant="outline"
                onClick={handleEditTest}
                disabled={editTestState === "testing" || editSaving}
                className="sm:mr-auto"
              >
                {editTestState === "testing" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Test
              </Button>
            )}
            <Button variant="outline" onClick={() => { setEditConn(null); setEditForm(null); }}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={editSaving}>
              {editSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ─────────────────────────────────────────────── */}
      <Dialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete connection?</DialogTitle>
            <DialogDescription>
              This will permanently remove the saved connection. You can always add it again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => confirmId && remove(confirmId)}
              disabled={!!deleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
