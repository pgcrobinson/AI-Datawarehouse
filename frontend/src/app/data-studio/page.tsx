"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Play, Loader2, Database, Server, Save, Trash2,
  ChevronRight, Package, Hammer, FlaskConical, X, SlidersHorizontal,
  FilePlus2, Copy, History, ChevronDown, Wrench, Plus, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SchemaTree } from "@/components/query/SchemaTree";
import { ResultsTable } from "@/components/query/ResultsTable";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { QueryResult, Connection, DbtProject } from "@/lib/types";
import { GitDialog, GitStatusBadge } from "./GitPanel";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const SqlEditor = dynamic(
  () => import("@/components/query/SqlEditor").then((m) => m.SqlEditor),
  { ssr: false, loading: () => <div className="h-full bg-card" /> }
);

const SCHEMA_STORAGE_KEY = "dwb_default_schema";
const DBT_PROJECT_KEY    = "dwb_ds_project";
const SIDEBAR_W_KEY      = "dwb_ds_sidebar_w";
const EDITOR_H_KEY       = "dwb_ds_editor_h";

// ── dbt output line ───────────────────────────────────────────────────────────

interface DbtLine { line: string; done?: boolean; return_code?: number }

function dbtLineClass(line: string) {
  if (/error|fail/i.test(line)) return "text-red-400";
  if (/warn/i.test(line)) return "text-yellow-400";
  if (/ok|pass|success|done/i.test(line)) return "text-green-400";
  return "text-muted-foreground";
}

// ── model config helpers ──────────────────────────────────────────────────────

type Materialized = "table" | "view" | "incremental" | "ephemeral" | "snapshot";

interface ModelConfig {
  materialized: Materialized;
  uniqueKey: string;
  schema: string;
  alias: string;
  tags: string;
  preHook: string;
  postHook: string;
  // Snapshot (SCD) fields
  strategy: "timestamp" | "check";
  updatedAt: string;
  checkCols: string;
  invalidateHardDeletes: boolean;
}

const DEFAULT_CONFIG: ModelConfig = {
  materialized: "table",
  uniqueKey: "",
  schema: "",
  alias: "",
  tags: "",
  preHook: "",
  postHook: "",
  strategy: "timestamp",
  updatedAt: "",
  checkCols: "",
  invalidateHardDeletes: false,
};

function generateConfigPreview(cfg: ModelConfig): string {
  if (cfg.materialized === "snapshot") {
    const schema = cfg.schema.trim() || "snapshots";
    const key    = cfg.uniqueKey.trim() || "id";
    const parts  = [
      `        target_schema='${schema}'`,
      `        unique_key='${key}'`,
      `        strategy='${cfg.strategy}'`,
    ];
    if (cfg.strategy === "timestamp")
      parts.push(`        updated_at='${cfg.updatedAt.trim() || "updated_at"}'`);
    else if (cfg.checkCols.trim()) {
      const cols = cfg.checkCols.split(",").map((c) => `'${c.trim()}'`).filter((c) => c !== "''").join(", ");
      if (cols) parts.push(`        check_cols=[${cols}]`);
    }
    if (cfg.invalidateHardDeletes)
      parts.push("        invalidate_hard_deletes=True");
    return (
      "{% snapshot model_name %}\n\n" +
      "{{\n    config(\n" + parts.join(",\n") + "\n    )\n}}\n\n" +
      "SELECT ...\n\n" +
      "{% endsnapshot %}"
    );
  }
  const parts: string[] = [`    materialized='${cfg.materialized}'`];
  if (cfg.materialized === "incremental" && cfg.uniqueKey.trim())
    parts.push(`    unique_key='${cfg.uniqueKey.trim()}'`);
  if (cfg.schema.trim())   parts.push(`    schema='${cfg.schema.trim()}'`);
  if (cfg.alias.trim())    parts.push(`    alias='${cfg.alias.trim()}'`);
  if (cfg.tags.trim()) {
    const list = cfg.tags.split(",").map((t) => `'${t.trim()}'`).filter((t) => t !== "''").join(", ");
    if (list) parts.push(`    tags=[${list}]`);
  }
  if (cfg.preHook.trim())  parts.push(`    pre_hook='${cfg.preHook.trim()}'`);
  if (cfg.postHook.trim()) parts.push(`    post_hook='${cfg.postHook.trim()}'`);
  return `{{\n  config(\n${parts.join(",\n")}\n  )\n}}\n`;
}

function fromApiConfig(api: Record<string, unknown>): ModelConfig {
  return {
    materialized: (api.materialized as Materialized) || "table",
    uniqueKey: (api.unique_key as string) || "",
    schema: (api.schema as string) || "",
    alias: (api.alias as string) || "",
    tags: (api.tags as string) || "",
    preHook: (api.pre_hook as string) || "",
    postHook: (api.post_hook as string) || "",
    strategy: (api.strategy as "timestamp" | "check") || "timestamp",
    updatedAt: (api.updated_at as string) || "",
    checkCols: (api.check_cols as string) || "",
    invalidateHardDeletes: (api.invalidate_hard_deletes as boolean) || false,
  };
}

function toApiConfig(cfg: ModelConfig): Record<string, unknown> {
  return {
    materialized: cfg.materialized,
    unique_key: cfg.uniqueKey,
    schema: cfg.schema,
    alias: cfg.alias,
    tags: cfg.tags,
    pre_hook: cfg.preHook,
    post_hook: cfg.postHook,
    strategy: cfg.strategy,
    updated_at: cfg.updatedAt,
    check_cols: cfg.checkCols,
    invalidate_hard_deletes: cfg.invalidateHardDeletes,
  };
}

// ── model config dialog ───────────────────────────────────────────────────────

function ModelConfigDialog({
  open, onClose, current, onApply,
}: { open: boolean; onClose: () => void; current: ModelConfig; onApply: (cfg: ModelConfig) => void }) {
  const [cfg, setCfg] = useState<ModelConfig>(DEFAULT_CONFIG);
  useEffect(() => { if (open) setCfg({ ...current }); }, [open, current]);

  const set = <K extends keyof ModelConfig>(k: K, v: ModelConfig[K]) =>
    setCfg((prev) => ({ ...prev, [k]: v }));

  const field = (label: string, hint: string, node: React.ReactNode) => (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {node}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-card border-border flex flex-col max-h-[90vh]">
        <h2 className="text-base font-semibold">Model configuration</h2>
        <p className="text-xs text-muted-foreground -mt-1">
          Settings are written as a <code className="font-mono bg-muted px-1 rounded">{"{{ config(...) }}"}</code> block at the top of the file.
        </p>

        <div className="overflow-y-auto flex-1 space-y-4 mt-2 pr-1">
          {field("Type", "", (
            <div className="grid grid-cols-5 gap-1.5">
              {(["table", "view", "incremental", "ephemeral", "snapshot"] as Materialized[]).map((m) => (
                <button
                  key={m}
                  onClick={() => set("materialized", m)}
                  className={cn(
                    "rounded border px-2 py-1.5 text-xs font-mono transition-colors",
                    cfg.materialized === m
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          ))}

          {/* ── Snapshot (SCD) fields ── */}
          {cfg.materialized === "snapshot" && (<>
            <div className="rounded border border-border/60 bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
              Snapshots capture slowly changing dimension history. dbt adds <code className="font-mono">dbt_valid_from</code> / <code className="font-mono">dbt_valid_to</code> columns automatically. Run with <strong>dbt snapshot</strong>.
            </div>

            {field("Strategy", "How dbt detects row changes.", (
              <div className="grid grid-cols-2 gap-1.5">
                {(["timestamp", "check"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => set("strategy", s)}
                    className={cn(
                      "rounded border px-3 py-1.5 text-xs font-mono transition-colors",
                      cfg.strategy === s
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            ))}

            {field(
              "Unique key",
              "Primary key column that identifies each row.",
              <Input value={cfg.uniqueKey} onChange={(e) => set("uniqueKey", e.target.value)}
                placeholder="id" className="h-8 text-xs font-mono" />
            )}

            {cfg.strategy === "timestamp" && field(
              "Updated at column",
              "Timestamp column dbt uses to detect new versions of a row.",
              <Input value={cfg.updatedAt} onChange={(e) => set("updatedAt", e.target.value)}
                placeholder="updated_at" className="h-8 text-xs font-mono" />
            )}

            {cfg.strategy === "check" && field(
              "Check columns",
              "Comma-separated columns — dbt re-snapshots a row when any of these change.",
              <Input value={cfg.checkCols} onChange={(e) => set("checkCols", e.target.value)}
                placeholder="status, amount" className="h-8 text-xs font-mono" />
            )}

            {field(
              "Target schema",
              "Schema where the snapshot table is created (defaults to 'snapshots').",
              <Input value={cfg.schema} onChange={(e) => set("schema", e.target.value)}
                placeholder="snapshots" className="h-8 text-xs font-mono" />
            )}

            <div className="flex items-center gap-2">
              <input
                id="invalidate-hd"
                type="checkbox"
                checked={cfg.invalidateHardDeletes}
                onChange={(e) => set("invalidateHardDeletes", e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <label htmlFor="invalidate-hd" className="text-xs cursor-pointer select-none">
                Invalidate hard deletes
                <span className="ml-1 text-muted-foreground">(close open snapshot rows when source row is deleted)</span>
              </label>
            </div>
          </>)}

          {/* ── Standard model fields ── */}
          {cfg.materialized !== "snapshot" && (<>
            {cfg.materialized === "incremental" && field(
              "Unique key",
              "Column(s) used to match existing rows for merging.",
              <Input value={cfg.uniqueKey} onChange={(e) => set("uniqueKey", e.target.value)}
                placeholder="id  or  id, updated_at" className="h-8 text-xs font-mono" />
            )}

            {field(
              "Schema override",
              "Leave blank to use the project default schema.",
              <Input value={cfg.schema} onChange={(e) => set("schema", e.target.value)}
                placeholder="e.g. marts" className="h-8 text-xs font-mono" />
            )}

            {field(
              "Alias",
              "Output table name — leave blank to use the model file name.",
              <Input value={cfg.alias} onChange={(e) => set("alias", e.target.value)}
                placeholder="e.g. dim_customers" className="h-8 text-xs font-mono" />
            )}

            {field(
              "Tags",
              "Comma-separated. Used for filtering with dbt run --select tag:finance.",
              <Input value={cfg.tags} onChange={(e) => set("tags", e.target.value)}
                placeholder="e.g. finance, daily" className="h-8 text-xs font-mono" />
            )}

            <div className="grid grid-cols-2 gap-3">
              {field("Pre-hook SQL", "", (
                <Input value={cfg.preHook} onChange={(e) => set("preHook", e.target.value)}
                  placeholder="e.g. TRUNCATE staging.tmp" className="h-8 text-xs font-mono" />
              ))}
              {field("Post-hook SQL", "", (
                <Input value={cfg.postHook} onChange={(e) => set("postHook", e.target.value)}
                  placeholder="e.g. GRANT SELECT ..." className="h-8 text-xs font-mono" />
              ))}
            </div>
          </>)}
        </div>

        {/* Preview */}
        <div className="mt-3">
          <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wide font-semibold">Preview</p>
          <pre className="bg-[#0d1117] rounded p-3 text-[11px] font-mono text-green-300 whitespace-pre overflow-x-auto">
            {generateConfigPreview(cfg)}
          </pre>
        </div>

        <div className="flex justify-end gap-2 mt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onApply(cfg); onClose(); }}>
            Apply to editor
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── save model dialog ─────────────────────────────────────────────────────────

function SaveModelDialog({
  open, onClose, onSave, initial, existingModels, isSnapshot,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  initial: string;
  existingModels: { name: string; type: "model" | "snapshot" }[];
  isSnapshot: boolean;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);

  const normalized = name.trim();
  const thisType   = isSnapshot ? "snapshot" : "model";
  const otherType  = isSnapshot ? "model"    : "snapshot";

  const conflict   = normalized ? existingModels.find(m => m.name === normalized && m.type !== thisType) : null;
  const isOverwrite = normalized ? existingModels.find(m => m.name === normalized && m.type === thisType) : null;

  function handleSave() {
    if (!normalized || conflict) return;
    onSave(normalized);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-card border-border">
        <h2 className="text-base font-semibold">Save as dbt {thisType}</h2>
        <p className="text-xs text-muted-foreground">Name (lowercase, underscores only)</p>
        <div className="space-y-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="my_model"
            autoFocus
            className={conflict ? "border-red-500 focus-visible:ring-red-500" : ""}
          />
          {conflict && (
            <p className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              A {otherType} named &ldquo;{normalized}&rdquo; already exists — choose a different name.
            </p>
          )}
          {!conflict && isOverwrite && (
            <p className="text-xs text-amber-400">
              This will overwrite the existing {thisType}.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!normalized || !!conflict} onClick={handleSave}>
            <Save className="h-3.5 w-3.5 mr-1.5" /> Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── setup dbt dialog ──────────────────────────────────────────────────────────

function SetupDbtDialog({
  open, onClose, onSetup, connections, selectedConnectionId,
}: {
  open: boolean; onClose: () => void;
  onSetup: (name: string, connId: string, schema: string) => Promise<void>;
  connections: Connection[]; selectedConnectionId: string;
}) {
  const [name, setName] = useState("analytics");
  const [connId, setConnId] = useState(selectedConnectionId);
  const [schema, setSchema] = useState("dbo");
  const [saving, setSaving] = useState(false);

  const selectedConn = connections.find((c) => c.id === connId);
  const isBigQuery = selectedConn?.db_type === "bigquery";

  useEffect(() => {
    if (!open) return;
    setConnId(selectedConnectionId);
  }, [open, selectedConnectionId]);

  useEffect(() => {
    const conn = connections.find((c) => c.id === connId);
    if (conn?.db_type === "bigquery") {
      setSchema(conn.database ?? "");
    } else {
      setSchema("dbo");
    }
  }, [connId, connections]);

  async function handleSetup() {
    if (!name.trim() || !connId) return;
    setSaving(true);
    try { await onSetup(name.trim(), connId, schema || (isBigQuery ? "" : "dbo")); onClose(); }
    catch { /* errors toasted by caller */ }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-card border-border space-y-3">
        <h2 className="text-base font-semibold">New dbt project</h2>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Project name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="analytics" autoFocus />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Connection</label>
          <Select value={connId} onValueChange={setConnId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {isBigQuery ? "Target dataset" : "Target schema"}
          </label>
          <Input
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            placeholder={isBigQuery ? "my_dataset" : "dbo"}
          />
          <p className="text-[10px] text-muted-foreground">
            {isBigQuery
              ? "BigQuery dataset where dbt will materialise models"
              : "Schema where dbt will materialise models"}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!name.trim() || !connId || saving} onClick={handleSetup}>
            {saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Create project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── dbt command dropdown ──────────────────────────────────────────────────────

interface DbtMenuProps {
  disabled: boolean;
  running: boolean;
  currentModel: string | null;
  onRun: (command: string, select?: string) => void;
  onStop: () => void;
}

function DbtMenu({ disabled, running, currentModel, onRun, onStop }: DbtMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function run(command: string, select?: string) {
    setOpen(false);
    onRun(command, select);
  }

  const sections: { label: string; items: { icon: React.ReactNode; label: string; cmd: string; select?: string; title?: string }[] }[] = [
    {
      label: "Run",
      items: [
        { icon: <Package className="h-3.5 w-3.5" />, label: "Run all models", cmd: "run" },
        ...(currentModel ? [{ icon: <Package className="h-3.5 w-3.5 text-blue-400" />, label: `Run: ${currentModel}`, cmd: "run", select: currentModel }] : []),
      ],
    },
    {
      label: "Build",
      items: [
        { icon: <Hammer className="h-3.5 w-3.5" />, label: "Build all", cmd: "build" },
        ...(currentModel ? [{ icon: <Hammer className="h-3.5 w-3.5 text-blue-400" />, label: `Build: ${currentModel}`, cmd: "build", select: currentModel }] : []),
      ],
    },
    {
      label: "Other",
      items: [
        { icon: <FlaskConical className="h-3.5 w-3.5" />, label: "Test all", cmd: "test" },
        { icon: <History className="h-3.5 w-3.5" />, label: "Run all snapshots", cmd: "snapshot" },
      ],
    },
  ];

  return (
    <div className="relative" ref={ref}>
      {running ? (
        <Button size="sm" variant="destructive" onClick={onStop}>
          <X className="h-3.5 w-3.5 mr-1.5" /> Stop
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5 mr-1.5" />}
          dbt
          <ChevronDown className="h-3 w-3 ml-1" />
        </Button>
      )}

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] rounded-md border bg-popover shadow-md text-sm">
          {sections.map((section, si) => (
            <div key={si}>
              {si > 0 && <div className="border-t my-1" />}
              <div className="px-2 py-1 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                {section.label}
              </div>
              {section.items.map((item, ii) => (
                <button
                  key={ii}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent hover:text-accent-foreground rounded-sm text-left"
                  onClick={() => run(item.cmd, item.select)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── resize handle ────────────────────────────────────────────────────────────

function ResizeHandle({
  direction,
  onMouseDown,
}: {
  direction: "col" | "row";
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={cn(
        "shrink-0 flex items-center justify-center group z-10 select-none transition-colors",
        direction === "col"
          ? "w-1 cursor-col-resize hover:bg-primary/30 bg-border"
          : "h-1 cursor-row-resize hover:bg-primary/30 bg-border",
      )}
    >
      <div
        className={cn(
          "rounded-full bg-border group-hover:bg-primary/70 transition-colors",
          direction === "col" ? "h-10 w-0.5" : "w-10 h-0.5",
        )}
      />
    </div>
  );
}

// ── dbt tests ────────────────────────────────────────────────────────────────

interface ColTest {
  _id:  string;
  name: string;
  notNull:        boolean;
  unique:         boolean;
  acceptedValues: { enabled: boolean; values: string };
  relationships:  { enabled: boolean; to: string; field: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSchemaTests(schemaModels: any[], modelName: string): ColTest[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = schemaModels.find((m: any) => m.name === modelName);
  if (!entry?.columns) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return entry.columns.map((col: any) => {
    const tests: unknown[] = col.tests || [];
    const isStr  = (t: unknown, k: string) => t === k;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isObj  = (t: unknown, k: string): t is Record<string, any> =>
      typeof t === "object" && t !== null && k in t;
    const avTest = tests.find(t => isObj(t, "accepted_values"));
    const relTest = tests.find(t => isObj(t, "relationships"));
    return {
      _id:    crypto.randomUUID(),
      name:   col.name ?? "",
      notNull: tests.some(t => isStr(t, "not_null")    || isObj(t, "not_null")),
      unique:  tests.some(t => isStr(t, "unique")       || isObj(t, "unique")),
      acceptedValues: {
        enabled: !!avTest,
        values: isObj(avTest, "accepted_values")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? ((avTest as any).accepted_values?.values ?? []).join(", ")
          : "",
      },
      relationships: {
        enabled: !!relTest,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        to:    isObj(relTest, "relationships") ? (relTest as any).relationships?.to    ?? "" : "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        field: isObj(relTest, "relationships") ? (relTest as any).relationships?.field ?? "" : "",
      },
    };
  });
}

function buildSchemaEntry(modelName: string, cols: ColTest[]) {
  return {
    name: modelName,
    columns: cols
      .filter(c => c.name.trim())
      .map(c => {
        const tests: unknown[] = [];
        if (c.notNull) tests.push("not_null");
        if (c.unique)  tests.push("unique");
        if (c.acceptedValues.enabled && c.acceptedValues.values.trim())
          tests.push({ accepted_values: {
            values: c.acceptedValues.values.split(",").map(v => v.trim()).filter(Boolean),
          }});
        if (c.relationships.enabled && c.relationships.to.trim() && c.relationships.field.trim())
          tests.push({ relationships: {
            to:    c.relationships.to.trim(),
            field: c.relationships.field.trim(),
          }});
        return { name: c.name.trim(), tests };
      })
      .filter(c => (c.tests as unknown[]).length > 0),
  };
}

// ── column test row ───────────────────────────────────────────────────────────

function ColumnTestRow({ col, modelNames, onChange, onDelete }: {
  col: ColTest;
  modelNames: string[];
  onChange: (patch: Partial<ColTest>) => void;
  onDelete: () => void;
}) {
  const setAv  = (patch: Partial<ColTest["acceptedValues"]>) =>
    onChange({ acceptedValues: { ...col.acceptedValues, ...patch } });
  const setRel = (patch: Partial<ColTest["relationships"]>) =>
    onChange({ relationships: { ...col.relationships, ...patch } });

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      {/* Column name */}
      <div className="flex items-center gap-2">
        <Input
          value={col.name}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="column_name"
          className="font-mono text-sm h-8 flex-1"
        />
        <button onClick={onDelete} className="shrink-0 text-red-400 hover:text-red-300 transition-colors">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Test checkboxes */}
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {([
          ["not_null",        "notNull",               col.notNull]            as const,
          ["unique",          "unique",                col.unique]             as const,
          ["accepted_values", "acceptedValues.enabled", col.acceptedValues.enabled] as const,
          ["relationships",   "relationships.enabled", col.relationships.enabled]  as const,
        ] as [string, string, boolean][]).map(([label, key, checked]) => (
          <label key={label} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => {
                if (key === "notNull")               onChange({ notNull: e.target.checked });
                else if (key === "unique")           onChange({ unique: e.target.checked });
                else if (key === "acceptedValues.enabled") setAv({ enabled: e.target.checked });
                else                                 setRel({ enabled: e.target.checked });
              }}
              className="rounded border-border accent-primary h-3.5 w-3.5"
            />
            <span className="font-mono">{label}</span>
          </label>
        ))}
      </div>

      {/* accepted_values config */}
      {col.acceptedValues.enabled && (
        <div className="pl-3 border-l-2 border-primary/40 space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Allowed values <span className="font-normal normal-case">(comma-separated)</span>
          </Label>
          <Input
            value={col.acceptedValues.values}
            onChange={e => setAv({ values: e.target.value })}
            placeholder="active, inactive, pending"
            className="h-8 text-xs font-mono"
          />
        </div>
      )}

      {/* relationships config */}
      {col.relationships.enabled && (
        <div className="pl-3 border-l-2 border-purple-500/40 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">References model</Label>
              <div className="relative">
                <Input
                  value={col.relationships.to}
                  onChange={e => setRel({ to: e.target.value })}
                  placeholder="ref('other_model')"
                  className="h-8 text-xs font-mono pr-1"
                  list={`rel-models-${col._id}`}
                />
                <datalist id={`rel-models-${col._id}`}>
                  {modelNames.map(n => (
                    <option key={n} value={`ref('${n}')`} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Field</Label>
              <Input
                value={col.relationships.field}
                onChange={e => setRel({ field: e.target.value })}
                placeholder="id"
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Type a model name to see suggestions, e.g. <span className="font-mono">ref(&apos;customers&apos;)</span>
          </p>
        </div>
      )}
    </div>
  );
}

// ── tests dialog ──────────────────────────────────────────────────────────────

function TestsDialog({ open, onClose, modelName, projectId, modelNames, onRunTests }: {
  open: boolean;
  onClose: () => void;
  modelName: string;
  projectId: string;
  modelNames: string[];
  onRunTests: () => void;
}) {
  const [cols,       setCols]       = useState<ColTest[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [savedCount, setSavedCount] = useState(0); // tests already in schema.yml

  useEffect(() => {
    if (!open || !modelName || !projectId) return;
    setCols([]);   // clear stale data immediately
    setLoading(true);
    api.dsGetSchema(projectId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(data => {
        const parsed = parseSchemaTests((data.models ?? []) as any[], modelName);
        setCols(parsed);
        setSavedCount(parsed.reduce((n, c) => {
          let t = 0;
          if (c.notNull) t++;
          if (c.unique)  t++;
          if (c.acceptedValues.enabled) t++;
          if (c.relationships.enabled)  t++;
          return n + t;
        }, 0));
      })
      .catch(() => { setCols([]); setSavedCount(0); })
      .finally(() => setLoading(false));
  }, [open, modelName, projectId]);

  function addColumn() {
    setCols(prev => [...prev, {
      _id: crypto.randomUUID(),
      name: "",
      notNull: false,
      unique: false,
      acceptedValues: { enabled: false, values: "" },
      relationships:  { enabled: false, to: "", field: "" },
    }]);
  }

  async function doSave(): Promise<boolean> {
    setSaving(true);
    try {
      const schemaData = await api.dsGetSchema(projectId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const otherModels = (schemaData.models ?? []).filter((m: any) => m.name !== modelName);
      const entry = buildSchemaEntry(modelName, cols);
      const models = entry.columns.length ? [...otherModels, entry] : otherModels;
      await api.dsSaveSchema({ version: 2, models }, projectId);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    const ok = await doSave();
    if (ok) {
      toast.success("Tests saved to schema.yml");
      onClose();
    }
  }

  async function handleRunTests() {
    const ok = await doSave();
    if (ok) {
      toast.success("Tests saved — running…");
      onClose();
      onRunTests();
    }
  }

  const testCount = cols.reduce((n, c) => {
    let t = 0;
    if (c.notNull) t++;
    if (c.unique)  t++;
    if (c.acceptedValues.enabled) t++;
    if (c.relationships.enabled)  t++;
    return n + t;
  }, 0);

  const isEditing = savedCount > 0;

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-card border-border flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-purple-400" />
              {isEditing ? "Edit tests" : "Configure tests"} —{" "}
              <span className="font-mono text-primary">{modelName}</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Saved to <span className="font-mono">models/schema.yml</span>
              {isEditing && (
                <span className="ml-2 text-purple-400 font-medium">
                  {savedCount} saved test{savedCount !== 1 ? "s" : ""} — editing
                </span>
              )}
              {!isEditing && testCount > 0 && (
                <span className="ml-2 text-foreground font-medium">{testCount} test{testCount !== 1 ? "s" : ""} configured</span>
              )}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={handleRunTests} disabled={saving}>
            {saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              : <Play className="h-3.5 w-3.5 mr-1.5 text-green-400" />
            }
            Save &amp; run
          </Button>
        </div>

        {/* Column rows */}
        <div className="flex-1 overflow-y-auto mt-3 space-y-2 pr-1">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : cols.length === 0 ? (
            <div className="flex flex-col items-center py-10 gap-3 text-muted-foreground">
              <FlaskConical className="h-8 w-8 opacity-20" />
              <p className="text-sm">No columns configured yet</p>
              <Button size="sm" variant="outline" onClick={addColumn}>
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Add first column
              </Button>
            </div>
          ) : cols.map(col => (
            <ColumnTestRow
              key={col._id}
              col={col}
              modelNames={modelNames.filter(n => n !== modelName)}
              onChange={patch => setCols(prev => prev.map(c => c._id === col._id ? { ...c, ...patch } : c))}
              onDelete={() => setCols(prev => prev.filter(c => c._id !== col._id))}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-border mt-2 shrink-0">
          <Button size="sm" variant="outline" onClick={addColumn} disabled={loading}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add column
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || loading}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              <Save className="h-3.5 w-3.5 mr-1.5" /> {isEditing ? "Update tests" : "Save tests"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function DataStudioPage() {
  const [sql, setSql] = useState("SELECT TOP 100 *\nFROM ");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [sourceConnectionId, setSourceConnectionId] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [defaultSchema, setDefaultSchema] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(SCHEMA_STORAGE_KEY) ?? "" : ""
  );

  // model config (stored separately from SQL)
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ ...DEFAULT_CONFIG });

  // dbt state
  const [dbtProjects, setDbtProjects] = useState<DbtProject[]>([]);
  const [dbtInstalled, setDbtInstalled] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(DBT_PROJECT_KEY) ?? "" : ""
  );
  const [models, setModels] = useState<{ name: string; type: "model" | "snapshot" }[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [dbtOutput, setDbtOutput] = useState<DbtLine[]>([]);
  const [dbtRunning, setDbtRunning] = useState(false);
  const dbtAbortRef = useRef<AbortController | null>(null);

  // UI state
  const [outputTab, setOutputTab] = useState<"results" | "dbt">("results");
  const [saveOpen, setSaveOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [testsOpen, setTestsOpen] = useState(false);
  const [testsModel, setTestsModel] = useState<string>("");
  const [gitOpen, setGitOpen] = useState(false);

  // Resizable panes
  const [sidebarW, setSidebarW] = useState(() =>
    typeof window !== "undefined" ? Number(localStorage.getItem(SIDEBAR_W_KEY) || 224) : 224
  );
  const [editorH, setEditorH] = useState(() =>
    typeof window !== "undefined" ? Number(localStorage.getItem(EDITOR_H_KEY) || 224) : 224
  );
  const dragRef = useRef<{ kind: "col" | "row"; startPos: number; startVal: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "col") {
        const w = Math.min(480, Math.max(140, d.startVal + (e.clientX - d.startPos)));
        setSidebarW(w);
        localStorage.setItem(SIDEBAR_W_KEY, String(w));
      } else {
        const h = Math.min(640, Math.max(80, d.startVal + (e.clientY - d.startPos)));
        setEditorH(h);
        localStorage.setItem(EDITOR_H_KEY, String(h));
      }
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const dbtOutputRef = useRef<HTMLDivElement>(null);

  // Load connections
  useEffect(() => {
    api.listConnections().then((conns) => {
      setConnections(conns);
      const active = conns.find((c) => c.is_active);
      if (active) setSelectedConnectionId(active.id);
    }).catch(() => {});
  }, []);

  // Load schemas when connection changes
  useEffect(() => {
    if (!selectedConnectionId) { setSchemas([]); return; }
    api.getSchema(selectedConnectionId).then((s) => setSchemas(s.schemas)).catch(() => setSchemas([]));
  }, [selectedConnectionId]);

  // Load projects on mount; if stored project id is gone, fall back to first
  useEffect(() => {
    api.dsListProjects().then((r) => {
      setDbtProjects(r.projects);
      setDbtInstalled(r.dbt_installed);
      if (currentProjectId && !r.projects.find((p) => p.id === currentProjectId)) {
        const first = r.projects[0]?.id ?? "";
        setCurrentProjectId(first);
        if (first) localStorage.setItem(DBT_PROJECT_KEY, first);
        else localStorage.removeItem(DBT_PROJECT_KEY);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload models whenever the selected project changes
  useEffect(() => {
    if (!currentProjectId) { setModels([]); return; }
    refreshModels();
  }, [currentProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function refreshModels() {
    if (!currentProjectId) return;
    api.dsListModels(currentProjectId).then((r) => setModels(r.models)).catch(() => {});
  }

  function handleSchemaChange(value: string) {
    const next = value === "__none__" ? "" : value;
    setDefaultSchema(next);
    if (next) localStorage.setItem(SCHEMA_STORAGE_KEY, next);
    else localStorage.removeItem(SCHEMA_STORAGE_KEY);
  }

  const selectedConn = connections.find((c) => c.id === selectedConnectionId) ?? null;

  async function runQuery() {
    if (!sql.trim() || !selectedConnectionId) return;
    setRunning(true);
    setOutputTab("results");
    try {
      const res = await api.executeQuery(sql, selectedConnectionId, defaultSchema || undefined);
      setResult(res);
      if (res.error) toast.error("Query returned an error");
      else toast.success(`${res.row_count} row${res.row_count !== 1 ? "s" : ""} · ${res.execution_time_ms.toFixed(1)}ms`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    } finally {
      setRunning(false);
    }
  }

  async function saveModel(name: string) {
    setSaveOpen(false);
    if (!currentProjectId) { toast.error("No dbt project selected"); return; }
    try {
      const res = await api.dsSaveModel(name, sql, toApiConfig(modelConfig), currentProjectId);
      setCurrentModel(res.name);
      toast.success(`Saved as ${res.name}`);
      refreshModels();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function loadModel(name: string, type: "model" | "snapshot") {
    if (!currentProjectId) return;
    try {
      const m = await api.dsGetModel(name, type, currentProjectId);
      setSql(m.sql);
      setCurrentModel(m.name);
      setModelConfig(m.config ? fromApiConfig(m.config) : { ...DEFAULT_CONFIG });
    } catch {
      toast.error("Could not load model");
    }
  }

  async function deleteModel(name: string, type: "model" | "snapshot") {
    if (!currentProjectId) return;
    try {
      await api.dsDeleteModel(name, type, currentProjectId);
      if (currentModel === name) {
        setCurrentModel(null);
        setModelConfig({ ...DEFAULT_CONFIG });
      }
      refreshModels();
    } catch {
      toast.error(`Could not delete ${name}`);
    }
  }

  function handleNewModel() {
    setSql(
      "-- Tip: reference other models with ref('model_name')\n\n" +
      "SELECT\n    *\nFROM "
    );
    setCurrentModel(null);
    setModelConfig({ ...DEFAULT_CONFIG });
    setResult(null);
  }

  async function handleCopyRef(name: string) {
    await navigator.clipboard.writeText(`{{ ref('${name}') }}`);
    toast.success(`Copied ref('${name}')`);
  }

  async function runDbtCommand(command: string, select?: string) {
    if (!currentProjectId) { toast.error("No dbt project selected"); return; }
    dbtAbortRef.current?.abort();
    const ctrl = new AbortController();
    dbtAbortRef.current = ctrl;
    setDbtRunning(true);
    setDbtOutput([]);
    setOutputTab("dbt");
    try {
      const res = await api.dsRunCommand(
        command,
        selectedConnectionId || undefined,
        select ?? undefined,
        ctrl.signal,
        currentProjectId,
        sourceConnectionId || undefined,
      );
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const obj: DbtLine = JSON.parse(part);
            setDbtOutput((prev) => [...prev, obj]);
            if (obj.done) {
              if (obj.return_code === 0) toast.success(`dbt ${command} succeeded`);
              else toast.error(`dbt ${command} failed (exit ${obj.return_code})`);
            }
          } catch { /* ignore malformed lines */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error("dbt command failed");
    } finally {
      setDbtRunning(false);
    }
  }

  useEffect(() => {
    if (dbtOutputRef.current) dbtOutputRef.current.scrollTop = dbtOutputRef.current.scrollHeight;
  }, [dbtOutput]);

  async function handleSetup(name: string, connId: string, schema: string) {
    try {
      const { id } = await api.dsCreateProject(name, connId, schema);
      const r = await api.dsListProjects();
      setDbtProjects(r.projects);
      setDbtInstalled(r.dbt_installed);
      setCurrentProjectId(id);
      localStorage.setItem(DBT_PROJECT_KEY, id);
      setCurrentModel(null);
      setModels([]);
      toast.success(`Project "${name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Setup failed");
      throw e;
    }
  }

  function selectProject(id: string) {
    if (id === currentProjectId) return;
    setCurrentProjectId(id);
    localStorage.setItem(DBT_PROJECT_KEY, id);
    setCurrentModel(null);
    setModelConfig({ ...DEFAULT_CONFIG });
    setResult(null);
    setDbtOutput([]);
  }

  async function deleteProject(id: string) {
    const project = dbtProjects.find((p) => p.id === id);
    try {
      await api.dsDeleteProject(id);
      const updated = dbtProjects.filter((p) => p.id !== id);
      setDbtProjects(updated);
      if (currentProjectId === id) {
        const next = updated[0]?.id ?? "";
        setCurrentProjectId(next);
        if (next) localStorage.setItem(DBT_PROJECT_KEY, next);
        else localStorage.removeItem(DBT_PROJECT_KEY);
        setCurrentModel(null);
        setModels([]);
        setModelConfig({ ...DEFAULT_CONFIG });
      }
      toast.success(`Deleted "${project?.name}"`);
    } catch {
      toast.error("Could not delete project");
    }
  }

  const dbtInitialized = !!currentProjectId && dbtProjects.some((p) => p.id === currentProjectId);

  const handleTableClick = useCallback((schema: string, table: string) => {
    setSql(`SELECT TOP 100 *\nFROM [${schema}].[${table}]`);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">

      {/* ── Left sidebar ───────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex flex-col bg-card overflow-hidden"
        style={{ width: sidebarW }}
      >

        {/* dbt Projects */}
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">dbt Projects</span>
            <button
              onClick={() => setSetupOpen(true)}
              className="text-muted-foreground hover:text-foreground"
              title="New project"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          {dbtProjects.length === 0 ? (
            <p className="px-3 pb-3 text-[10px] text-muted-foreground">
              No projects —{" "}
              <button onClick={() => setSetupOpen(true)} className="underline hover:text-foreground">
                set up dbt
              </button>
            </p>
          ) : (
            <div className="pb-1">
              {dbtProjects.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "group flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs hover:bg-accent",
                    currentProjectId === p.id && "text-primary bg-primary/10"
                  )}
                  onClick={() => selectProject(p.id)}
                >
                  <span className="truncate font-medium">{p.name}</span>
                  <button
                    title="Delete project"
                    onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                    className="opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <Trash2 className="h-3 w-3 text-red-400 hover:text-red-600" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Models */}
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Models</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleNewModel}
                className="text-muted-foreground hover:text-foreground"
                title="New model"
              >
                <FilePlus2 className="h-3 w-3" />
              </button>
              <button
                onClick={() => setSaveOpen(true)}
                className="text-muted-foreground hover:text-foreground"
                title="Save current SQL as a model"
              >
                <Save className="h-3 w-3" />
              </button>
            </div>
          </div>
          {models.length === 0 ? (
            <p className="px-3 pb-3 text-[10px] text-muted-foreground">No models yet — save a query to get started</p>
          ) : (
            <div className="pb-1">
              {models.map(({ name, type }) => (
                <div
                  key={`${type}-${name}`}
                  className={cn(
                    "group flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs hover:bg-accent",
                    currentModel === name && "text-primary bg-primary/10"
                  )}
                  onClick={() => loadModel(name, type)}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {type === "snapshot"
                      ? <History className="h-3 w-3 shrink-0 opacity-60" />
                      : <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
                    <span className="truncate font-mono">{name}</span>
                    {type === "snapshot" && (
                      <span className="shrink-0 text-[9px] text-muted-foreground border border-border rounded px-1">scd</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      title={`Copy {{ ref('${name}') }}`}
                      onClick={(e) => { e.stopPropagation(); handleCopyRef(name); }}
                      className="opacity-0 group-hover:opacity-100"
                    >
                      <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                    {type === "model" && (
                      <button
                        title="Configure tests"
                        onClick={(e) => { e.stopPropagation(); setTestsModel(name); setTestsOpen(true); }}
                        className="opacity-0 group-hover:opacity-100"
                      >
                        <FlaskConical className="h-3 w-3 text-purple-400 hover:text-purple-300" />
                      </button>
                    )}
                    <button
                      title="Delete"
                      onClick={(e) => { e.stopPropagation(); deleteModel(name, type); }}
                    >
                      <Trash2 className="h-3 w-3 text-red-400 hover:text-red-600" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Source control status */}
        {currentProjectId && (
          <div className="border-t border-border">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Source Control</span>
            </div>
            <GitStatusBadge projectId={currentProjectId} onClick={() => setGitOpen(true)} />
          </div>
        )}

        {/* Schema tree */}
        <ScrollArea className="flex-1">
          <SchemaTree onTableClick={handleTableClick} connectionId={selectedConnectionId || undefined} />
        </ScrollArea>
      </div>

      {/* ── Sidebar resize handle ───────────────────────────────────────────── */}
      <ResizeHandle
        direction="col"
        onMouseDown={(e) => {
          dragRef.current = { kind: "col", startPos: e.clientX, startVal: sidebarW };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          e.preventDefault();
        }}
      />

      {/* ── Main area ──────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card shrink-0 flex-wrap">

          <Button size="sm" onClick={runQuery} disabled={running || !selectedConnectionId}>
            {running
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Play className="mr-1.5 h-4 w-4" />}
            Run
          </Button>
          <span className="text-xs text-muted-foreground hidden sm:block">Ctrl+Enter</span>

          <div className="h-4 w-px bg-border" />

          <Button size="sm" variant="outline" onClick={() => setSaveOpen(true)}>
            <Save className="h-3.5 w-3.5 mr-1.5" /> Save model
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfigOpen(true)}
            title="Set dbt model configuration (materialization, schema, alias, tags…)"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" /> Config
          </Button>
          {modelConfig.materialized !== "table" && (
            <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-mono text-primary">
              {modelConfig.materialized}
            </span>
          )}

          <div className="h-4 w-px bg-border" />

          {dbtInitialized ? (
            <>
              <DbtMenu
                disabled={!dbtInstalled}
                running={dbtRunning}
                currentModel={currentModel}
                onRun={(cmd, select) => runDbtCommand(cmd, select)}
                onStop={() => dbtAbortRef.current?.abort()}
              />
              {currentModel && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setTestsModel(currentModel); setTestsOpen(true); }}
                  title="Configure dbt tests for this model"
                >
                  <FlaskConical className="h-3.5 w-3.5 mr-1.5 text-purple-400" /> Tests
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> New dbt project
            </Button>
          )}

          <div className="flex-1" />

          {/* Write connection picker */}
          <div className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Select value={selectedConnectionId} onValueChange={(v) => { setSelectedConnectionId(v); setSourceConnectionId(""); }}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="Select connection…" />
              </SelectTrigger>
              <SelectContent>
                {connections.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    No connections — <a href="/database-config" className="underline">configure one</a>
                  </div>
                )}
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Write-to picker — BigQuery cross-project: read from above, write here */}
          {(() => {
            const bqTargets = connections.filter((c) => c.id !== selectedConnectionId && c.db_type === "bigquery");
            if (selectedConn?.db_type !== "bigquery" || bqTargets.length === 0) return null;
            return (
              <div className="flex items-center gap-1.5" title="dbt reads data from the connection above and writes model output into this project">
                <span className="text-[10px] text-muted-foreground shrink-0">write to</span>
                <Select value={sourceConnectionId || "__none__"} onValueChange={(v) => setSourceConnectionId(v === "__none__" ? "" : v)}>
                  <SelectTrigger className="h-8 w-36 text-xs">
                    <SelectValue placeholder="Same project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs text-muted-foreground">Same project</SelectItem>
                    {bqTargets.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })()}

          {/* Default schema picker */}
          {schemas.length > 0 && (
            <Select value={defaultSchema || "__none__"} onValueChange={handleSchemaChange}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue placeholder="Schema…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" className="text-xs text-muted-foreground">No default</SelectItem>
                {schemas.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {selectedConn && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded px-2 py-1">
              <Server className="h-3 w-3 shrink-0" />
              <span className="font-mono">{selectedConn.database}</span>
            </div>
          )}
        </div>

        {/* Editor */}
        <div
          className="shrink-0 overflow-hidden bg-[#1d2433]"
          style={{ height: editorH }}
        >
          <SqlEditor value={sql} onChange={setSql} onExecute={runQuery} />
        </div>

        {/* Editor / output resize handle */}
        <ResizeHandle
          direction="row"
          onMouseDown={(e) => {
            dragRef.current = { kind: "row", startPos: e.clientY, startVal: editorH };
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
          }}
        />

        {/* Output area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-1 px-4 border-b border-border bg-card shrink-0">
            {(["results", "dbt"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setOutputTab(t)}
                className={cn(
                  "px-3 py-2 text-xs font-medium transition-colors",
                  outputTab === t
                    ? "text-foreground border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "results" ? "Results" : "dbt Output"}
                {t === "dbt" && dbtRunning && (
                  <Loader2 className="inline h-3 w-3 animate-spin ml-1.5" />
                )}
              </button>
            ))}
          </div>

          {outputTab === "results" ? (
            <div className="flex-1 overflow-hidden">
              <ResultsTable result={result} loading={running} />
            </div>
          ) : (
            <div
              ref={dbtOutputRef}
              className="flex-1 overflow-auto bg-[#0d1117] p-4 font-mono text-xs leading-relaxed"
            >
              {dbtOutput.length === 0 && !dbtRunning && (
                <p className="text-muted-foreground">dbt output will appear here when you run a command.</p>
              )}
              {dbtOutput.map((entry, i) =>
                entry.done ? (
                  <p key={i} className={cn("font-semibold mt-2", entry.return_code === 0 ? "text-green-400" : "text-red-400")}>
                    {entry.return_code === 0 ? "✓ Done" : `✗ Failed (exit ${entry.return_code})`}
                  </p>
                ) : (
                  <p key={i} className={dbtLineClass(entry.line)}>{entry.line}</p>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <ModelConfigDialog
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        current={modelConfig}
        onApply={setModelConfig}
      />
      <SaveModelDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        onSave={saveModel}
        initial={currentModel ?? ""}
        existingModels={models}
        isSnapshot={modelConfig.materialized === "snapshot"}
      />
      <SetupDbtDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSetup={handleSetup}
        connections={connections}
        selectedConnectionId={selectedConnectionId}
      />
      <GitDialog
        open={gitOpen}
        onClose={() => setGitOpen(false)}
        projectId={currentProjectId}
      />
      <TestsDialog
        open={testsOpen}
        onClose={() => setTestsOpen(false)}
        modelName={testsModel}
        projectId={currentProjectId}
        modelNames={models.filter(m => m.type === "model").map(m => m.name)}
        onRunTests={() => {
          setOutputTab("dbt");
          runDbtCommand("test", testsModel || undefined);
        }}
      />
    </div>
  );
}
