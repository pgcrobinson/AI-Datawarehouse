"use client";

import { useState } from "react";
import { Plug, Trash2, CheckCircle2, Server, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Connection, DbType } from "@/lib/types";
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
  // azure_sql default
  const parts = [c.server, c.database].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Azure SQL";
}

export function ConnectionList({ connections, onChanged }: Props) {
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [testing, setTesting]       = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [confirmId, setConfirmId]   = useState<string | null>(null);

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

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Saved Connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {connections.map((c) => {
            const dbType: DbType = (c.db_type ?? "azure_sql") as DbType;
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
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${DB_TYPE_COLORS[dbType]}`}>
                      {DB_TYPE_LABELS[dbType]}
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
