"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import type { FullDesign, DesignVersion, Connection, BuildLogEntry, DesignTransform } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft, BookOpen, GitFork, Code2, Copy, Save, X,
  History, RotateCcw, Hammer, Loader2, CheckCircle2, AlertTriangle,
  XCircle, Info, Wand2, Filter, ChevronDown, ChevronUp, Eraser, Trash2, Check, Pencil, Sparkles,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import { TransformsTab } from "./TransformsTab";

const MermaidDiagram = dynamic(
  () => import("@/components/design/MermaidDiagram").then((m) => m.MermaidDiagram),
  { ssr: false, loading: () => <div className="min-h-[320px]" /> }
);

const BASE_URL = "http://localhost:8000/api";

// ── useSqlPanel must be declared before SqlPanel so its return type is resolvable ──

function useSqlPanel(initial: string, save: (s: string) => Promise<void>) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);

  const isDirty = value !== saved;

  // Call after external saves (regenerate, restore history) to mark panel as clean
  function setFresh(s: string) { setValue(s); setSaved(s); }
  function reset() { setValue(saved); }

  async function doSave() {
    if (!value.trim() || !isDirty) return;
    setSaving(true);
    try {
      await save(value);
      setSaved(value);
    } finally {
      setSaving(false);
    }
  }

  return { value, setValue, saved, isDirty, saving, doSave, reset, setFresh };
}

// ── Module-level components — must NOT be defined inside DesignDetail.
// Defining components inside another component causes React to treat them as
// a new type on every render, unmounting and remounting the DOM node (including
// textareas) on each keystroke which resets cursor position and scroll.

function ToggleBtn({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all select-none",
        value
          ? "bg-primary/15 text-primary border-primary/40 hover:bg-primary/20"
          : "bg-muted/40 text-muted-foreground border-border hover:bg-muted"
      )}
    >
      <span className={cn(
        "text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded",
        value ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20 text-muted-foreground"
      )}>
        {value ? "ON" : "OFF"}
      </span>
      {label}
    </button>
  );
}

function SqlPanel({
  panel, onHistory, copyLabel, extraOffset = 0,
}: {
  panel: ReturnType<typeof useSqlPanel>;
  onHistory: () => void;
  copyLabel: string;
  extraOffset?: number;
}) {
  const codeH = `calc(100vh - ${181 + extraOffset}px)`;
  return (
    <div>
      <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
        <span className="text-xs text-muted-foreground font-mono truncate mr-4">{copyLabel}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={onHistory}>
            <History className="h-3.5 w-3.5" /> History
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5"
            onClick={() => { navigator.clipboard.writeText(panel.value); toast.success("Copied to clipboard"); }}>
            <Copy className="h-3 w-3" /> Copy
          </Button>
          {panel.isDirty && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5"
              onClick={panel.reset} disabled={panel.saving}>
              <RotateCcw className="h-3.5 w-3.5" /> Revert
            </Button>
          )}
          <Button size="sm" className="h-7 text-xs gap-1.5"
            onClick={panel.doSave} disabled={panel.saving || !panel.isDirty}>
            {panel.saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      <div
        className="mx-6 my-3 rounded-lg border border-border bg-card overflow-hidden flex flex-col"
        style={{ height: codeH, minHeight: 400 }}
      >
        <textarea
          className="flex-1 w-full p-4 text-xs font-mono bg-background text-foreground/90 leading-relaxed resize-none focus:outline-none"
          value={panel.value}
          onChange={(e) => panel.setValue(e.target.value)}
          spellCheck={false}
          placeholder="No SQL saved yet."
        />
      </div>
    </div>
  );
}

function TableSelectDialog({
  open, title, actionLabel, confirmVariant = "default", warning, onClose, onConfirm, warehouseTables,
}: {
  open: boolean;
  title: string;
  actionLabel: string;
  confirmVariant?: "default" | "destructive";
  warning?: string;
  warehouseTables: Array<{ schema: string; table: string }>;
  onClose: () => void;
  onConfirm: (tables: Array<{ schema: string; table: string }>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [schemaFilter, setSchemaFilter] = useState<string>("__all__");

  const schemas = Array.from(new Set(warehouseTables.map(t => t.schema))).sort();
  const visible = schemaFilter === "__all__"
    ? warehouseTables
    : warehouseTables.filter(t => t.schema === schemaFilter);

  const allVisibleSel = visible.length > 0 && visible.every(t => selected.has(`${t.schema}.${t.table}`));

  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSel) {
        visible.forEach(t => next.delete(`${t.schema}.${t.table}`));
      } else {
        visible.forEach(t => next.add(`${t.schema}.${t.table}`));
      }
      return next;
    });
  }

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {warning && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {warning}
          </div>
        )}

        <div className="space-y-2">
          {schemas.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">Schema</span>
              <button
                onClick={() => setSchemaFilter("__all__")}
                className={cn(
                  "px-2 py-0.5 rounded text-xs font-medium border transition-colors",
                  schemaFilter === "__all__"
                    ? "bg-primary/15 text-primary border-primary/40"
                    : "bg-muted/40 text-muted-foreground border-border hover:bg-muted"
                )}
              >
                All schemas
              </button>
              {schemas.map(s => (
                <button
                  key={s}
                  onClick={() => setSchemaFilter(s)}
                  className={cn(
                    "px-2 py-0.5 rounded text-xs font-medium border font-mono transition-colors",
                    schemaFilter === s
                      ? "bg-primary/15 text-primary border-primary/40"
                      : "bg-muted/40 text-muted-foreground border-border hover:bg-muted"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {selected.size} of {warehouseTables.length} selected
              {schemaFilter !== "__all__" && ` · showing ${visible.length} in ${schemaFilter}`}
            </p>
            <button onClick={toggleAll}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
              {allVisibleSel ? "Deselect visible" : "Select visible"}
            </button>
          </div>

          <div className="rounded-lg border border-border bg-background max-h-64 overflow-y-auto p-1 space-y-0.5">
            {visible.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3 text-center">No tables found in DDL.</p>
            ) : (
              visible.map(t => {
                const key = `${t.schema}.${t.table}`;
                const isSel = selected.has(key);
                return (
                  <button key={key} onClick={() => toggle(key)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors",
                      isSel
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}>
                    <div className={cn(
                      "h-3.5 w-3.5 rounded border flex-shrink-0 flex items-center justify-center",
                      isSel ? "border-primary bg-primary" : "border-muted-foreground/40"
                    )}>
                      {isSel && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <span className="font-mono">{key}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={confirmVariant}
            disabled={selected.size === 0}
            onClick={() => {
              const tables = Array.from(selected).map(key => {
                const dot = key.indexOf(".");
                return { schema: key.slice(0, dot), table: key.slice(dot + 1) };
              });
              onConfirm(tables);
              onClose();
            }}
          >
            {actionLabel} ({selected.size})
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── RunTransformsDialog ───────────────────────────────────────────────────────

function RunTransformsDialog({
  open, projectId, designId, onClose, onRun,
}: {
  open: boolean;
  projectId: string;
  designId: string;
  onClose: () => void;
  onRun: (transformIds: string[], rowLimitOverride?: number) => void;
}) {
  const [transforms, setTransforms] = useState<DesignTransform[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("all");
  const [rowLimit, setRowLimit] = useState("100");

  useEffect(() => {
    if (!open) return;
    setSelectedId("all");
    setRowLimit("100");
    setLoading(true);
    api.listTransforms(projectId, designId)
      .then(setTransforms)
      .catch(() => toast.error("Failed to load transforms"))
      .finally(() => setLoading(false));
  }, [open, projectId, designId]);

  const selectedTransforms = selectedId === "all"
    ? transforms
    : transforms.filter((t) => t.id === selectedId);

  const hasAiExtract = selectedTransforms.some((t) => t.transform_type === "ai_extract");

  function handleRun() {
    const ids = selectedTransforms.map((t) => t.id);
    onRun(ids, hasAiExtract ? (parseInt(rowLimit, 10) || 100) : undefined);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" /> Run Transforms
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : transforms.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No transforms defined for this design.</p>
        ) : (
          <div className="space-y-4 mt-2">
            {/* Transform selector */}
            <div className="space-y-1.5">
              <Label>Select transform</Label>
              <div className="space-y-1.5">
                <button type="button" onClick={() => setSelectedId("all")}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-md border text-sm text-left transition-all",
                    selectedId === "all"
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                  )}>
                  <span className="flex-1 font-medium">All transforms</span>
                  <Badge variant="secondary" className="text-[9px] py-0 h-4">{transforms.length}</Badge>
                </button>
                {transforms.map((t) => (
                  <button key={t.id} type="button" onClick={() => setSelectedId(t.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 rounded-md border text-sm text-left transition-all",
                      selectedId === t.id
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                    )}>
                    {t.transform_type === "ai_extract"
                      ? <Sparkles className="h-3.5 w-3.5 text-violet-400 flex-shrink-0" />
                      : <Code2 className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />}
                    <span className="flex-1 truncate">{t.name}</span>
                    <Badge variant="outline" className={cn(
                      "text-[9px] py-0 h-4",
                      t.transform_type === "ai_extract"
                        ? "border-violet-500/40 text-violet-400"
                        : "border-blue-500/40 text-blue-400"
                    )}>
                      {t.transform_type === "ai_extract" ? "AI Extract" : "SQL"}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>

            {/* Row limit — only shown when an AI Extract is included */}
            {hasAiExtract && (
              <div className="space-y-1.5">
                <Label htmlFor="rt-limit">Row limit</Label>
                <div className="flex items-center gap-2">
                  <Input id="rt-limit" type="number" min={1} max={10000}
                    value={rowLimit} onChange={(e) => setRowLimit(e.target.value)}
                    className="h-8 text-sm w-28" />
                  <span className="text-xs text-muted-foreground">rows from source</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Limits how many source rows the AI processes. Lower values are faster and cheaper for testing.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleRun} disabled={loading || transforms.length === 0} className="gap-2">
            <Wand2 className="h-3.5 w-3.5" /> Run
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface Props {
  design: FullDesign;
  projectId: string;
  onBack: () => void;
  initialTab?: string;
}

export function DesignDetail({ design, projectId, onBack, initialTab }: Props) {
  const ddl = useSqlPanel(design.sql_ddl ?? "", async (sql) => {
    await api.updateDesignSQL(projectId, design.id, sql);
    toast.success("DDL saved — previous version stored in history");
  });

  const etl = useSqlPanel(design.etl_sql ?? "", async (sql) => {
    await api.updateEtlSQL(projectId, design.id, sql);
    toast.success("ETL SQL saved — previous version stored in history");
  });

  // Design rename (ERD tab)
  const [currentName, setCurrentName] = useState(design.name);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(design.name);
  const [titleSaving, setTitleSaving] = useState(false);

  // Live ERD — kept in local state so it can be refreshed without a page reload
  const [mermaidErd, setMermaidErd] = useState(design.mermaid_erd ?? "");
  const [refreshingErd, setRefreshingErd] = useState(false);
  // ERD tab has its own connection picker — defaults to design's saved connection or active one
  const [erdConnId, setErdConnId] = useState(design.connection_id ?? "");

  async function handleRefreshErd() {
    if (!erdConnId) { toast.error("Select a connection to read the schema from"); return; }
    setRefreshingErd(true);
    try {
      const result = await api.refreshErd(projectId, design.id, erdConnId);
      setMermaidErd(result.mermaid_erd);
      toast.success("ERD refreshed from live schema");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh ERD");
    } finally {
      setRefreshingErd(false);
    }
  }

  async function saveTitle() {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === currentName) { setEditingTitle(false); return; }
    setTitleSaving(true);
    try {
      await api.renameDesign(projectId, design.id, trimmed);
      setCurrentName(trimmed);
      setEditingTitle(false);
      toast.success("Design renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setTitleSaving(false);
    }
  }

  // Version history (shared dialog, discriminated by type)
  const [historyType, setHistoryType] = useState<"ddl" | "etl">("ddl");
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Build
  const [connections, setConnections] = useState<Connection[]>([]);
  const [targetConn, setTargetConn] = useState("");
  const [buildTargetSchema, setBuildTargetSchema] = useState(design.target_schema ?? "");
  const [dropIfExists, setDropIfExists] = useState(false);
  const [includeKeys, setIncludeKeys] = useState(true);
  const [includeIndexes, setIncludeIndexes] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [tableFilters, setTableFilters] = useState<Record<string, string>>({});
  const [building, setBuilding] = useState(false);
  const [addingKeys, setAddingKeys] = useState(false);
  const [addingIndexes, setAddingIndexes] = useState(false);
  const [droppingKeys, setDroppingKeys] = useState(false);
  const [droppingIndexes, setDroppingIndexes] = useState(false);
  const [buildLog, setBuildLog] = useState<BuildLogEntry[] | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // AI debug state
  const [debugging, setDebugging] = useState(false);
  const [debugResult, setDebugResult] = useState<{ diagnosis: string; fixed_ddl: string | null; fixed_etl: string | null } | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  // Maintenance dialogs
  const [showTruncateDialog, setShowTruncateDialog] = useState(false);
  const [showDropDialog, setShowDropDialog] = useState(false);
  const [maintainRunning, setMaintainRunning] = useState(false);
  const [runningTransforms, setRunningTransforms] = useState(false);
  const [showRunTransformsDialog, setShowRunTransformsDialog] = useState(false);

  // Parse warehouse tables from DDL for maintenance dialogs
  const warehouseTables = useMemo(() => {
    if (!design.sql_ddl) return [];
    const matches = Array.from(design.sql_ddl.matchAll(
      /CREATE\s+TABLE\s+(?:\[?(\w+)\]?\.)?\[?(\w+)\]?/gi
    ));
    return matches.map(m => ({ schema: m[1] || "dbo", table: m[2] }));
  }, [design.sql_ddl]);

  // DDL regeneration
  const [regenDdl, setRegenDdl] = useState(false);

  async function handleRegenerateDdl() {
    setRegenDdl(true);
    try {
      const result = await api.regenerateDDL(projectId, design.id);
      ddl.setFresh(result.sql_ddl);
      toast.success("DDL regenerated — previous version stored in history");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "DDL regeneration failed");
    } finally {
      setRegenDdl(false);
    }
  }

  // ETL generation
  const [generating, setGenerating] = useState(false);
  const [showGenDialog, setShowGenDialog] = useState(false);
  const [genFilters, setGenFilters] = useState<Record<string, string>>({});

  const sourceTables: Array<{ schema_name: string; table_name: string }> =
    design.tables_json ? JSON.parse(design.tables_json) : [];

  useEffect(() => {
    api.listConnections().then((list) => {
      setConnections(list);
      const active = list.find((c) => c.is_active);
      if (active) {
        setTargetConn(active.id);
        setErdConnId((prev) => prev || active.id);
      }
    }).catch(() => {});
  }, []);

  // ── Version history helpers ────────────────────────────────────────────────

  async function openHistory(type: "ddl" | "etl") {
    setHistoryType(type);
    setShowHistory(true);
    setLoadingVersions(true);
    try {
      const v = type === "ddl"
        ? await api.listVersions(projectId, design.id)
        : await api.listEtlVersions(projectId, design.id);
      setVersions(v);
    } catch {
      toast.error("Failed to load version history");
    } finally {
      setLoadingVersions(false);
    }
  }

  async function restoreVersion(v: DesignVersion) {
    setRestoringId(v.id);
    try {
      const full = historyType === "ddl"
        ? await api.getVersion(projectId, design.id, v.id)
        : await api.getEtlVersion(projectId, design.id, v.id);
      if (!full.sql_ddl) return;
      if (historyType === "ddl") {
        await api.updateDesignSQL(projectId, design.id, full.sql_ddl);
        ddl.setFresh(full.sql_ddl);
      } else {
        await api.updateEtlSQL(projectId, design.id, full.sql_ddl);
        etl.setFresh(full.sql_ddl);
      }
      setShowHistory(false);
      toast.success(`Restored to version ${v.version_number}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoringId(null);
    }
  }

  // ── ETL generation ─────────────────────────────────────────────────────────

  async function handleGenerateEtl() {
    setGenerating(true);
    setShowGenDialog(false);
    try {
      const result = await api.generateEtlSQL(projectId, design.id, genFilters);
      etl.setFresh(result.etl_sql);
      toast.success("ETL SQL generated and saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "ETL generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // ── Build (streaming) ──────────────────────────────────────────────────────

  async function streamToLog(
    url: string,
    body: object,
    onDone: () => void,
  ) {
    const token = typeof window !== "undefined" ? localStorage.getItem("dwb_token") : null;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: "Request failed" }));
        toast.error(err.detail ?? "Request failed");
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as BuildLogEntry;
            setBuildLog((prev) => [...(prev ?? []), entry]);
            logEndRef.current?.scrollIntoView({ behavior: "smooth" });
          } catch { /* skip malformed */ }
        }
      }
      if (buffer.trim()) {
        try { setBuildLog((prev) => [...(prev ?? []), JSON.parse(buffer) as BuildLogEntry]); } catch {}
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setBuildLog((prev) => [...(prev ?? []), { step: "Stopped", status: "warn", message: "Cancelled by user" }]);
      } else {
        toast.error(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      abortRef.current = null;
      onDone();
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleBuild() {
    if (!targetConn) { toast.error("Select a target connection"); return; }
    setBuilding(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/build`,
      {
        target_connection_id: targetConn,
        target_schema: buildTargetSchema.trim() || undefined,
        drop_if_exists: dropIfExists,
        include_keys: includeKeys,
        include_indexes: includeIndexes,
        table_filters: Object.keys(tableFilters).length > 0 ? tableFilters : undefined,
      },
      () => setBuilding(false),
    );
  }

  async function handleAddKeys() {
    if (!targetConn) { toast.error("Select a target connection"); return; }
    setAddingKeys(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/add-keys`,
      { target_connection_id: targetConn },
      () => setAddingKeys(false),
    );
  }

  async function handleAddIndexes() {
    if (!targetConn) { toast.error("Select a target connection"); return; }
    setAddingIndexes(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/add-indexes`,
      { target_connection_id: targetConn },
      () => setAddingIndexes(false),
    );
  }

  async function handleDropKeys() {
    if (!targetConn) { toast.error("Select a target connection"); return; }
    setDroppingKeys(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/drop-keys`,
      { target_connection_id: targetConn },
      () => setDroppingKeys(false),
    );
  }

  async function handleDropIndexes() {
    if (!targetConn) { toast.error("Select a target connection"); return; }
    setDroppingIndexes(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/drop-indexes`,
      { target_connection_id: targetConn },
      () => setDroppingIndexes(false),
    );
  }

  async function handleRunTransforms(transformIds: string[], rowLimitOverride?: number) {
    if (!targetConn) { toast.error("Select a target connection first"); return; }
    setRunningTransforms(true);
    setBuildLog([]);
    await streamToLog(
      `${BASE_URL}/projects/${projectId}/designs/${design.id}/run-transforms`,
      { target_connection_id: targetConn, transform_ids: transformIds, row_limit_override: rowLimitOverride },
      () => setRunningTransforms(false),
    );
  }

  // ── Maintenance: truncate / drop selected tables ───────────────────────────

  async function handleMaintain(
    action: "truncate-tables" | "drop-tables",
    tables: Array<{ schema: string; table: string }>,
  ) {
    if (!targetConn) { toast.error("Select a target connection first"); return; }
    setMaintainRunning(true);
    setBuildLog([]);
    const token = typeof window !== "undefined" ? localStorage.getItem("dwb_token") : null;
    try {
      const response = await fetch(
        `${BASE_URL}/projects/${projectId}/designs/${design.id}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ target_connection_id: targetConn, tables }),
        }
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: "Operation failed" }));
        toast.error(err.detail ?? "Operation failed");
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as BuildLogEntry;
            setBuildLog((prev) => [...(prev ?? []), entry]);
            logEndRef.current?.scrollIntoView({ behavior: "smooth" });
          } catch { }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setMaintainRunning(false);
    }
  }

  async function handleDebugSql() {
    if (!buildLog) return;
    const errors = buildLog
      .filter((e) => e.status === "error")
      .map((e) => e.message || e.step);
    if (errors.length === 0) return;
    setDebugging(true);
    setDebugResult(null);
    try {
      const result = await api.debugSql(projectId, design.id, errors);
      setDebugResult(result);
      setShowDebug(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI debug failed");
    } finally {
      setDebugging(false);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  const logIcon = (status: BuildLogEntry["status"]) => ({
    ok: <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0 mt-0.5" />,
    warn: <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />,
    error: <XCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />,
    info: <Info className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" />,
  }[status]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate">{currentName}</h1>
          {design.prompt && (
            <p className="text-xs text-muted-foreground truncate max-w-2xl">{design.prompt}</p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground hidden sm:block">
          Saved {fmt(design.created_at)}
        </span>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={initialTab ?? "erd"}>
        <div className="px-6 pt-3 border-b border-border">
          <TabsList>
            <TabsTrigger value="erd" className="gap-2">
              <GitFork className="h-3.5 w-3.5" /> ERD
            </TabsTrigger>
            <TabsTrigger value="ddl" className="gap-2">
              <Code2 className="h-3.5 w-3.5" /> DDL SQL
            </TabsTrigger>
            <TabsTrigger value="etl" className="gap-2">
              <Wand2 className="h-3.5 w-3.5" /> ETL SQL
              {!etl.value && (
                <Badge variant="outline" className="text-[9px] py-0 h-4 border-yellow-500/50 text-yellow-500">
                  needed
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="transforms" className="gap-2">
              <Wand2 className="h-3.5 w-3.5" /> Transforms
            </TabsTrigger>
            <TabsTrigger value="build" className="gap-2">
              <Hammer className="h-3.5 w-3.5" /> Build
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── ERD ── */}
        <TabsContent value="erd">
          {/* ERD header bar — rename design */}
          <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
            {editingTitle ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle();
                    if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(currentName); }
                  }}
                  disabled={titleSaving}
                  className="flex-1 text-sm bg-background border border-ring rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5"
                  onClick={() => { setEditingTitle(false); setTitleDraft(currentName); }}
                  disabled={titleSaving}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </Button>
                <Button size="sm" className="h-7 text-xs gap-1.5"
                  onClick={saveTitle} disabled={titleSaving || !titleDraft.trim()}>
                  {titleSaving
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Save className="h-3.5 w-3.5" />}
                  Save Name
                </Button>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Entity Relationship Diagram</p>
                <div className="flex items-center gap-2">
                  <Select value={erdConnId} onValueChange={setErdConnId}>
                    <SelectTrigger className="h-7 text-xs w-44">
                      <SelectValue placeholder="Select connection…" />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.is_active ? " (active)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5"
                    onClick={handleRefreshErd} disabled={refreshingErd || !erdConnId}
                    title="Refresh ERD from live DB schema — no AI tokens used">
                    {refreshingErd
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing…</>
                      : <><RefreshCw className="h-3.5 w-3.5" /> Refresh from DB</>}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5"
                    onClick={() => { setTitleDraft(currentName); setEditingTitle(true); }}>
                    <Pencil className="h-3.5 w-3.5" /> Rename Design
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="px-6 pt-4 pb-6">
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              {mermaidErd
                ? <MermaidDiagram code={mermaidErd} />
                : <p className="p-6 text-sm text-muted-foreground">No ERD saved. Select a connection on the Build tab then click &quot;Refresh from DB&quot;.</p>}
            </div>
            {design.narrative && (
              <div className="mt-4 space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <BookOpen className="h-3.5 w-3.5 text-primary" /> Design Narrative
                </h3>
                <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {design.narrative}
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── DDL SQL ── */}
        <TabsContent value="ddl">
          <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
            <p className="text-xs text-muted-foreground">
              CREATE TABLE statements for all warehouse tables.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="gap-2 shrink-0 ml-4 h-7 text-xs"
              onClick={handleRegenerateDdl}
              disabled={regenDdl}
            >
              {regenDdl
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Wand2 className="h-3.5 w-3.5" />}
              {ddl.value ? "Regenerate DDL" : "Generate DDL"}
            </Button>
          </div>
          <SqlPanel
            panel={ddl}
            onHistory={() => openHistory("ddl")}
            copyLabel="DDL — CREATE TABLE statements"
            extraOffset={44}
          />
        </TabsContent>

        {/* ── ETL SQL ── */}
        <TabsContent value="etl">
          <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
            <p className="text-xs text-muted-foreground">
              INSERT … SELECT statements that load source tables into the warehouse.
              {!etl.value && " Use Generate to create this automatically."}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="gap-2 shrink-0 ml-4 h-7 text-xs"
              onClick={() => { setGenFilters({}); setShowGenDialog(true); }}
              disabled={generating}
            >
              {generating
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Wand2 className="h-3.5 w-3.5" />}
              {etl.value ? "Re-generate" : "Generate ETL SQL"}
            </Button>
          </div>
          {/* ETL SqlPanel: extra 44px for the header bar above it */}
          <SqlPanel
            panel={etl}
            onHistory={() => openHistory("etl")}
            copyLabel="ETL — INSERT … SELECT loading statements"
            extraOffset={44}
          />
        </TabsContent>

        {/* ── Build ── */}
        <TabsContent value="build">

          {/* ── Save ETL strip ── */}
          <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
            <p className="text-xs text-muted-foreground">
              {etl.isDirty ? "ETL SQL has unsaved changes." : "ETL SQL is up to date."}
            </p>
            <div className="flex items-center gap-1.5">
              {etl.isDirty && (
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5"
                  onClick={etl.reset} disabled={etl.saving}>
                  <RotateCcw className="h-3.5 w-3.5" /> Revert
                </Button>
              )}
              <Button size="sm" className="h-7 text-xs gap-1.5"
                onClick={etl.doSave} disabled={etl.saving || !etl.isDirty}>
                {etl.saving
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Save className="h-3.5 w-3.5" />}
                Save ETL
              </Button>
            </div>
          </div>

          {/* ── Compact config bar ── */}
          <div className="shrink-0 px-6 py-4 border-b border-border bg-card space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Connection */}
              <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                <Label className="shrink-0 text-xs whitespace-nowrap">Target DB</Label>
                <Select value={targetConn} onValueChange={setTargetConn}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Select connection…" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          {c.name}
                          {c.is_active && (
                            <Badge variant="secondary" className="text-[9px] py-0 h-4">active</Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Target schema */}
              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-xs whitespace-nowrap">Target Schema</Label>
                <Input
                  value={buildTargetSchema}
                  onChange={(e) => setBuildTargetSchema(e.target.value)}
                  placeholder="dbo"
                  className="h-8 text-sm w-28 font-mono"
                />
              </div>

              {/* Build option toggles */}
              <ToggleBtn label="Drop existing" value={dropIfExists} onChange={() => setDropIfExists(v => !v)} />
              <ToggleBtn label="Include keys" value={includeKeys} onChange={() => setIncludeKeys(v => !v)} />
              <ToggleBtn label="Include indexes" value={includeIndexes} onChange={() => setIncludeIndexes(v => !v)} />

              {/* Filters toggle */}
              {sourceTables.length > 0 && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 shrink-0"
                  onClick={() => setShowFilters((v) => !v)}>
                  <Filter className="h-3.5 w-3.5" />
                  Row filters
                  {showFilters ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {Object.values(tableFilters).some((v) => v.trim()) && (
                    <Badge variant="secondary" className="text-[9px] py-0 h-4 ml-0.5">active</Badge>
                  )}
                </Button>
              )}

              {/* ETL missing badge */}
              {!etl.value && (
                <Badge variant="outline" className="border-yellow-500/50 text-yellow-500 text-[10px] shrink-0">
                  <AlertTriangle className="h-3 w-3 mr-1" /> No ETL SQL
                </Badge>
              )}

              {/* Build / Stop — pushed to far right */}
              {(building || runningTransforms) ? (
                <Button variant="destructive" onClick={handleStop} className="gap-2 ml-auto shrink-0">
                  <XCircle className="h-4 w-4" /> Stop
                </Button>
              ) : (
                <Button onClick={handleBuild} disabled={!targetConn || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning}
                  className="gap-2 ml-auto shrink-0">
                  <Hammer className="h-4 w-4" /> Build
                </Button>
              )}
            </div>

            {/* Maintenance row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                Maintenance
              </span>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs shrink-0"
                onClick={() => setShowTruncateDialog(true)}
                disabled={!targetConn || building || addingKeys || addingIndexes || maintainRunning || warehouseTables.length === 0}>
                <Eraser className="h-3.5 w-3.5" /> Truncate Tables…
              </Button>
              <Button variant="outline" size="sm"
                className="h-7 gap-1.5 text-xs shrink-0 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => setShowDropDialog(true)}
                disabled={!targetConn || building || addingKeys || addingIndexes || maintainRunning || warehouseTables.length === 0}>
                <Trash2 className="h-3.5 w-3.5" /> Drop Tables…
              </Button>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs shrink-0"
                onClick={handleAddKeys}
                disabled={!targetConn || building || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning}>
                {addingKeys
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding Keys…</>
                  : <><Check className="h-3.5 w-3.5" /> Add Keys</>}
              </Button>
              <Button variant="outline" size="sm"
                className="h-7 gap-1.5 text-xs shrink-0 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={handleDropKeys}
                disabled={!targetConn || building || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning}>
                {droppingKeys
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Dropping Keys…</>
                  : <><X className="h-3.5 w-3.5" /> Drop Keys</>}
              </Button>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs shrink-0"
                onClick={handleAddIndexes}
                disabled={!targetConn || building || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning}>
                {addingIndexes
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding Indexes…</>
                  : <><Check className="h-3.5 w-3.5" /> Add Indexes</>}
              </Button>
              <Button variant="outline" size="sm"
                className="h-7 gap-1.5 text-xs shrink-0 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={handleDropIndexes}
                disabled={!targetConn || building || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning}>
                {droppingIndexes
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Dropping Indexes…</>
                  : <><X className="h-3.5 w-3.5" /> Drop Indexes</>}
              </Button>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs shrink-0"
                onClick={() => setShowRunTransformsDialog(true)}
                disabled={!targetConn || building || addingKeys || addingIndexes || droppingKeys || droppingIndexes || maintainRunning || runningTransforms}>
                {runningTransforms
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running Transforms…</>
                  : <><Wand2 className="h-3.5 w-3.5" /> Run Transforms</>}
              </Button>
              {(maintainRunning || runningTransforms) && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Running…
                </span>
              )}
            </div>

            {/* Filters panel */}
            {showFilters && sourceTables.length > 0 && (
              <div className="rounded-lg border border-border bg-background px-4 py-3 space-y-2">
                <p className="text-[10px] text-muted-foreground">
                  Add WHERE clauses to limit rows loaded per source table. These are applied when you
                  Generate ETL SQL — useful for keeping large FACT tables small during testing.
                </p>
                <div className="grid gap-1.5">
                  {sourceTables.map((t) => {
                    const key = `${t.schema_name}.${t.table_name}`;
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground w-52 truncate shrink-0">
                          {key}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">WHERE</span>
                        <Input
                          className="h-7 text-xs font-mono"
                          placeholder="e.g. OrderDate >= '2024-01-01'"
                          value={tableFilters[key] ?? ""}
                          onChange={(e) => setTableFilters((prev) => ({ ...prev, [key]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Build log — explicit height so it fills the page ── */}
          {/* 100vh minus: header(64) + tab-bar(52) + config-bar(~80) + log-header(41) + margins(12) */}
          <div
            className="mx-6 my-3 rounded-lg border border-border overflow-hidden flex flex-col"
            style={{ height: "calc(100vh - 249px)", minHeight: 300 }}
          >
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-muted/20 shrink-0">
              <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                Build Log
              </span>
              {building && (
                <span className="flex items-center gap-1.5 text-xs text-blue-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> Running…
                </span>
              )}
              {buildLog && !building && (
                <span className="text-[10px] text-muted-foreground">
                  {buildLog.filter((e) => e.status === "ok").length} ok ·{" "}
                  {buildLog.filter((e) => e.status === "error").length} error(s) ·{" "}
                  {buildLog.filter((e) => e.status === "warn").length} warning(s)
                </span>
              )}
              {buildLog && !building && buildLog.some((e) => e.status === "error") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] gap-1 ml-auto border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={handleDebugSql}
                  disabled={debugging}
                >
                  {debugging
                    ? <><Loader2 className="h-3 w-3 animate-spin" /> Diagnosing…</>
                    : <><Sparkles className="h-3 w-3" /> Debug with AI</>}
                </Button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5 bg-[#0d0d0d]">
              {!buildLog && !building ? (
                <div className="flex items-center justify-center h-32 text-muted-foreground/40 text-sm font-sans">
                  Click Build to start — output will stream here in real time.
                </div>
              ) : (
                (buildLog ?? []).map((entry, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-3 px-2 py-1 rounded",
                      entry.status === "info" && "bg-blue-950/30 mt-2 mb-0.5",
                      entry.status === "error" && "bg-red-950/30",
                    )}
                  >
                    <span className="mt-0.5 shrink-0">{logIcon(entry.status)}</span>
                    <div className="flex-1 min-w-0">
                      <span className={cn(
                        "break-all",
                        entry.status === "error" && "text-red-400",
                        entry.status === "warn" && "text-yellow-400",
                        entry.status === "ok" && "text-green-300",
                        entry.status === "info" && "text-blue-300 font-semibold",
                      )}>
                        {entry.step}
                      </span>
                      {entry.message && entry.message !== entry.step && (
                        <span className="text-muted-foreground/60 ml-3 break-all">
                          {entry.message}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </TabsContent>

        {/* ── Transforms ── */}
        <TabsContent value="transforms">
          <TransformsTab design={design} projectId={projectId} />
        </TabsContent>

      </Tabs>

      {/* AI Debug dialog */}
      <Dialog open={showDebug} onOpenChange={setShowDebug}>
        <DialogContent className="max-w-2xl flex flex-col max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-destructive" /> AI Diagnosis
            </DialogTitle>
          </DialogHeader>
          {debugResult && (
            <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
              {debugResult.diagnosis && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Root Cause</p>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm whitespace-pre-wrap leading-relaxed">
                    {debugResult.diagnosis}
                  </div>
                </div>
              )}
              {debugResult.fixed_ddl && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fixed DDL</p>
                    <Button size="sm" className="h-6 text-[10px] gap-1" onClick={async () => {
                      if (!debugResult.fixed_ddl) return;
                      try {
                        await api.updateDesignSQL(projectId, design.id, debugResult.fixed_ddl);
                        ddl.setFresh(debugResult.fixed_ddl);
                        toast.success("DDL updated with AI fix");
                        setShowDebug(false);
                      } catch { toast.error("Failed to apply fix"); }
                    }}>
                      <Check className="h-3 w-3" /> Apply to DDL
                    </Button>
                  </div>
                  <pre className="rounded-md border border-border bg-[#0d0d0d] p-3 text-xs font-mono overflow-x-auto max-h-48 leading-relaxed text-foreground/80">
                    {debugResult.fixed_ddl}
                  </pre>
                </div>
              )}
              {debugResult.fixed_etl && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fixed ETL</p>
                    <Button size="sm" className="h-6 text-[10px] gap-1" onClick={async () => {
                      if (!debugResult.fixed_etl) return;
                      try {
                        await api.updateEtlSQL(projectId, design.id, debugResult.fixed_etl);
                        etl.setFresh(debugResult.fixed_etl);
                        toast.success("ETL updated with AI fix");
                        setShowDebug(false);
                      } catch { toast.error("Failed to apply fix"); }
                    }}>
                      <Check className="h-3 w-3" /> Apply to ETL
                    </Button>
                  </div>
                  <pre className="rounded-md border border-border bg-[#0d0d0d] p-3 text-xs font-mono overflow-x-auto max-h-48 leading-relaxed text-foreground/80">
                    {debugResult.fixed_etl}
                  </pre>
                </div>
              )}
              {!debugResult.fixed_ddl && !debugResult.fixed_etl && (
                <p className="text-sm text-muted-foreground">
                  The AI could not generate a fix automatically. Review the diagnosis above and edit the DDL/ETL manually.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Version history dialog */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="max-w-md flex flex-col max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              {historyType === "ddl" ? "DDL" : "ETL"} Version History
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Each save snapshots the previous SQL. Click Restore to revert to any version.
          </p>
          <div className="flex-1 overflow-y-auto mt-2 space-y-2 min-h-0">
            {loadingVersions ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : versions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No saved versions yet.
              </p>
            ) : (
              versions.map((v) => (
                <div key={v.id}
                  className="rounded-lg border border-border bg-card px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary" className="text-[10px]">v{v.version_number}</Badge>
                    <Button variant="ghost" size="sm" className="h-6 text-xs gap-1.5"
                      disabled={restoringId === v.id}
                      onClick={() => restoreVersion(v)}>
                      {restoringId === v.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <RotateCcw className="h-3 w-3" />}
                      Restore
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Saved by <span className="font-medium text-foreground">{v.edited_by_name}</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">{fmt(v.created_at)}</p>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Generate ETL dialog */}
      <Dialog open={showGenDialog} onOpenChange={setShowGenDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4" /> Generate ETL SQL
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            AI will generate INSERT … SELECT statements mapping your source tables to the warehouse
            schema. Optionally add WHERE clause filters to limit rows per source table.
          </p>

          {sourceTables.length > 0 ? (
            <div className="space-y-2 mt-2">
              <Label className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5" /> Row filters (optional)
              </Label>
              <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                {sourceTables.map((t) => {
                  const key = `${t.schema_name}.${t.table_name}`;
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-xs font-mono text-muted-foreground w-44 truncate shrink-0">
                        {key}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">WHERE</span>
                      <Input
                        className="h-7 text-xs font-mono"
                        placeholder="e.g. Year = 2024"
                        value={genFilters[key] ?? ""}
                        onChange={(e) => setGenFilters((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Filters are embedded in the generated SQL and can be edited afterwards.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic mt-2">
              No source table information available for this design.
            </p>
          )}

          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" onClick={() => setShowGenDialog(false)}>Cancel</Button>
            <Button onClick={handleGenerateEtl} className="gap-2">
              <Wand2 className="h-3.5 w-3.5" /> Generate
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <TableSelectDialog
        open={showTruncateDialog}
        title="Truncate Tables"
        actionLabel="Truncate"
        warning="FK constraints are disabled per table, tables are truncated, then constraints are re-enabled. Data is permanently deleted."
        warehouseTables={warehouseTables}
        onClose={() => setShowTruncateDialog(false)}
        onConfirm={(tables) => handleMaintain("truncate-tables", tables)}
      />

      <TableSelectDialog
        open={showDropDialog}
        title="Drop Tables"
        actionLabel="Drop"
        confirmVariant="destructive"
        warning="FK constraints referencing selected tables are dropped first, then the tables are permanently removed."
        warehouseTables={warehouseTables}
        onClose={() => setShowDropDialog(false)}
        onConfirm={(tables) => handleMaintain("drop-tables", tables)}
      />

      <RunTransformsDialog
        open={showRunTransformsDialog}
        projectId={projectId}
        designId={design.id}
        onClose={() => setShowRunTransformsDialog(false)}
        onRun={handleRunTransforms}
      />
    </div>
  );
}
