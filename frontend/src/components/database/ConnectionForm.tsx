"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ConnectionConfig, DbType, AuthType } from "@/lib/types";
import { toast } from "sonner";

interface Props {
  onSaved: () => void;
}

const DEFAULTS: Record<DbType, ConnectionConfig> = {
  azure_sql: {
    name: "", db_type: "azure_sql",
    server: "", database: "", auth_type: "sql_server",
    username: "", password: "", port: 1433,
  },
  bigquery: {
    name: "", db_type: "bigquery",
    project_id: "", database: "", credentials_json: "",
    auth_type: "sql_server", port: 443,
  },
  snowflake: {
    name: "", db_type: "snowflake",
    server: "", database: "", schema_name: "PUBLIC",
    warehouse: "", username: "", password: "",
    auth_type: "sql_server", port: 443,
  },
  databricks: {
    name: "", db_type: "databricks",
    server: "", http_path: "", password: "",
    database: "", auth_type: "sql_server", port: 443,
  },
};

const DB_TYPE_LABELS: Record<DbType, string> = {
  azure_sql:  "Azure SQL / SQL Server",
  bigquery:   "Google BigQuery",
  snowflake:  "Snowflake",
  databricks: "Databricks",
};

type TestState = "idle" | "testing" | "ok" | "error";

export function ConnectionForm({ onSaved }: Props) {
  const [dbType, setDbType] = useState<DbType>("azure_sql");
  const [form, setForm] = useState<ConnectionConfig>(DEFAULTS.azure_sql);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (k: keyof ConnectionConfig, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  function handleTypeChange(t: DbType) {
    setDbType(t);
    setForm({ ...DEFAULTS[t], name: form.name });
    setTestState("idle");
    setTestMsg("");
  }

  async function handleTest() {
    setTestState("testing");
    try {
      const res = await api.testConnection(form);
      setTestState(res.success ? "ok" : "error");
      setTestMsg(res.message);
    } catch (e) {
      setTestState("error");
      setTestMsg(e instanceof Error ? e.message : "Unknown error");
    }
  }

  async function handleSave() {
    if (!form.name) { toast.error("Connection name is required"); return; }
    setSaving(true);
    try {
      await api.createConnection(form);
      toast.success(`Connection "${form.name}" saved`);
      setForm({ ...DEFAULTS[dbType], name: "" });
      setTestState("idle");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Connection</CardTitle>
        <CardDescription>Add a data warehouse or database connection</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Connection name */}
        <div className="space-y-1.5">
          <Label>Connection name</Label>
          <Input
            placeholder="e.g. Production DW"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>

        {/* Database type selector */}
        <div className="space-y-1.5">
          <Label>Database type</Label>
          <Select value={dbType} onValueChange={(v) => handleTypeChange(v as DbType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DB_TYPE_LABELS) as DbType[]).map((t) => (
                <SelectItem key={t} value={t}>{DB_TYPE_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* ── Azure SQL fields ─────────────────────────────────────────────── */}
        {dbType === "azure_sql" && (
          <>
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-3 space-y-1.5">
                <Label>Server</Label>
                <Input
                  placeholder="myserver.database.windows.net"
                  value={form.server ?? ""}
                  onChange={(e) => set("server", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Port</Label>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => set("port", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Database</Label>
              <Input
                placeholder="my_database"
                value={form.database ?? ""}
                onChange={(e) => set("database", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Authentication</Label>
              <Select
                value={form.auth_type}
                onValueChange={(v) => set("auth_type", v as AuthType)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sql_server">SQL Server Authentication</SelectItem>
                  <SelectItem value="windows">Windows Authentication</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.auth_type === "sql_server" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Username</Label>
                  <Input value={form.username ?? ""} onChange={(e) => set("username", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <Input type="password" value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} />
                </div>
              </div>
            )}
          </>
        )}

        {/* ── BigQuery fields ──────────────────────────────────────────────── */}
        {dbType === "bigquery" && (
          <>
            <div className="space-y-1.5">
              <Label>Project ID</Label>
              <Input
                placeholder="my-gcp-project"
                value={form.project_id ?? ""}
                onChange={(e) => set("project_id", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Dataset</Label>
              <Input
                placeholder="my_dataset"
                value={form.database ?? ""}
                onChange={(e) => set("database", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                The BigQuery dataset dbt will use as its default schema.
              </p>
            </div>

            {/* Primary auth: Connect with Google */}
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium">Authentication</p>
              <p className="text-[12px] text-muted-foreground">
                Sign in with your Google account to authorize access to BigQuery.
                No service account key required.
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                disabled={!form.name || !form.project_id || !form.database}
                onClick={() => {
                  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
                  const params = new URLSearchParams({
                    name:       form.name,
                    project_id: form.project_id ?? "",
                    dataset:    form.database ?? "",
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
                Connect with Google
              </Button>
              {(!form.name || !form.project_id || !form.database) && (
                <p className="text-[11px] text-amber-500/80">
                  Fill in connection name, project ID, and dataset before connecting.
                </p>
              )}
            </div>

            {/* Secondary: service account key */}
            <details className="group">
              <summary className="text-[12px] text-muted-foreground cursor-pointer select-none hover:text-foreground list-none flex items-center gap-1.5">
                <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                Advanced: use a service account key instead
              </summary>
              <div className="mt-3 space-y-3">
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 flex gap-2">
                  <Info className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-300/80">
                    Requires your GCP admin to allow service account key creation.
                    Use "Connect with Google" above if keys are blocked by your organisation policy.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Service account key JSON</Label>
                  <Textarea
                    placeholder={'{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'}
                    className="font-mono text-xs h-32 resize-none"
                    value={form.credentials_json ?? ""}
                    onChange={(e) => set("credentials_json", e.target.value)}
                  />
                </div>
              </div>
            </details>
          </>
        )}

        {/* ── Snowflake fields ─────────────────────────────────────────────── */}
        {dbType === "snowflake" && (
          <>
            <div className="space-y-1.5">
              <Label>Account identifier</Label>
              <Input
                placeholder="orgname-accountname"
                value={form.server ?? ""}
                onChange={(e) => set("server", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Found in Snowflake under Admin → Accounts (e.g. <span className="font-mono">xy12345.eu-west-1</span>)
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Database</Label>
                <Input
                  placeholder="MY_DATABASE"
                  value={form.database ?? ""}
                  onChange={(e) => set("database", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Schema</Label>
                <Input
                  placeholder="PUBLIC"
                  value={form.schema_name ?? "PUBLIC"}
                  onChange={(e) => set("schema_name", e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Warehouse</Label>
              <Input
                placeholder="COMPUTE_WH"
                value={form.warehouse ?? ""}
                onChange={(e) => set("warehouse", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input value={form.username ?? ""} onChange={(e) => set("username", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Password</Label>
                <Input type="password" value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} />
              </div>
            </div>
          </>
        )}

        {/* ── Databricks fields ────────────────────────────────────────────── */}
        {dbType === "databricks" && (
          <>
            <div className="space-y-1.5">
              <Label>Server hostname</Label>
              <Input
                placeholder="adb-1234567890.12.azuredatabricks.net"
                value={form.server ?? ""}
                onChange={(e) => set("server", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>HTTP path</Label>
              <Input
                placeholder="/sql/1.0/warehouses/abc1234def"
                value={form.http_path ?? ""}
                onChange={(e) => set("http_path", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Found in Databricks under SQL Warehouses → your warehouse → Connection details
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Catalog</Label>
              <Input
                placeholder="hive_metastore"
                value={form.database ?? ""}
                onChange={(e) => set("database", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Personal access token</Label>
              <Input
                type="password"
                placeholder="dapi..."
                value={form.password ?? ""}
                onChange={(e) => set("password", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Generate one in Databricks under Settings → Developer → Access tokens
              </p>
            </div>
          </>
        )}

        {/* Test result banner */}
        {testState !== "idle" && (
          <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
            testState === "ok"
              ? "bg-green-950/40 text-green-400"
              : testState === "error"
              ? "bg-red-950/40 text-red-400"
              : "bg-muted text-muted-foreground"
          }`}>
            {testState === "testing" && <Loader2 className="h-4 w-4 animate-spin" />}
            {testState === "ok"      && <CheckCircle2 className="h-4 w-4" />}
            {testState === "error"   && <XCircle className="h-4 w-4" />}
            <span className="truncate">{testState === "testing" ? "Testing…" : testMsg}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="outline" onClick={handleTest} disabled={testState === "testing"}>
            {testState === "testing" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Test Connection
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save Connection
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
