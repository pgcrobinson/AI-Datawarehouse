"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import type {
  DesignTransform, TransformPayload, FullDesign, Connection, SchemaData,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Plus, Trash2, Loader2, Wand2, Save, ChevronDown, ChevronUp,
  Code2, Sparkles, AlertTriangle, CheckCircle2, Database,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── TransformDialog ───────────────────────────────────────────────────────────

function TransformDialog({
  design,
  projectId,
  transform,
  onSave,
  onClose,
}: {
  design: FullDesign;
  projectId: string;
  transform: DesignTransform | null;
  onSave: (saved: DesignTransform) => void;
  onClose: () => void;
}) {
  const isEdit = !!transform;

  // ── transform form state ──────────────────────────────────────────────────
  const [name, setName] = useState(transform?.name ?? "");
  const [description, setDescription] = useState(transform?.description ?? "");
  const [type, setType] = useState<"sql" | "ai_extract">(transform?.transform_type ?? "sql");
  const [sourceTable, setSourceTable] = useState(transform?.source_table ?? "");
  const [sourceColumns, setSourceColumns] = useState("");
  const [targetTable, setTargetTable] = useState(transform?.target_table ?? "");
  const [outputSql, setOutputSql] = useState(transform?.output_sql ?? "");
  const [configJson, setConfigJson] = useState(
    transform?.config_json ? JSON.stringify(JSON.parse(transform.config_json), null, 2) : ""
  );
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── source connection / schema / table ────────────────────────────────────
  const [allConnections, setAllConnections] = useState<Connection[]>([]);
  const [loadingConns, setLoadingConns] = useState(true);
  const [sourceConnId, setSourceConnId] = useState("");
  const [schemaData, setSchemaData] = useState<SchemaData | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [selectedSchema, setSelectedSchema] = useState("");

  // ── design & create target table ──────────────────────────────────────────
  const [savedId, setSavedId] = useState<string | null>(transform?.id ?? null);
  const [targetConnId, setTargetConnId] = useState("");
  const [targetDdl, setTargetDdl] = useState("");
  const [generatingDdl, setGeneratingDdl] = useState(false);
  const [creatingTable, setCreatingTable] = useState(false);
  const [tableCreated, setTableCreated] = useState(false);

  // load connections on mount
  useEffect(() => {
    api.listConnections()
      .then((conns) => {
        setAllConnections(conns);
        const active = conns.find((c) => c.is_active);
        if (active) {
          setSourceConnId(active.id);
          setTargetConnId(active.id);
        }
      })
      .catch(() => toast.error("Failed to load connections"))
      .finally(() => setLoadingConns(false));
  }, []);

  // fetch schema when source connection changes
  useEffect(() => {
    if (!sourceConnId) return;
    setLoadingSchema(true);
    setSchemaData(null);
    setSelectedSchema("");
    api.getSchema(sourceConnId)
      .then((data) => {
        setSchemaData(data);
        // try to pre-select schema from existing source_table
        const existingSchema = sourceTable.includes(".") ? sourceTable.split(".")[0] : "";
        const match = data.schemas.find((s) => s.toLowerCase() === existingSchema.toLowerCase());
        setSelectedSchema(match ?? data.schemas[0] ?? "");
      })
      .catch(() => toast.error("Failed to load schema"))
      .finally(() => setLoadingSchema(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceConnId]);

  const filteredTables = schemaData?.tables.filter(
    (t) => t.schema_name.toLowerCase() === selectedSchema.toLowerCase()
  ) ?? [];

  // ── generate SQL / config ─────────────────────────────────────────────────
  async function handleGenerate() {
    if (!description.trim()) { toast.error("Enter a description first"); return; }
    setGenerating(true);
    try {
      const result = await api.generateTransform(projectId, design.id, {
        name: name || "Transform",
        description,
        transform_type: type,
        source_table: sourceTable || undefined,
        source_columns: sourceColumns || undefined,
        target_table: targetTable || undefined,
      });
      if (result.output_sql) setOutputSql(result.output_sql);
      if (result.config_json)
        setConfigJson(JSON.stringify(JSON.parse(result.config_json), null, 2));
      toast.success("Generated — review and save");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // ── build payload ─────────────────────────────────────────────────────────
  function buildPayload(): TransformPayload | null {
    if (!name.trim()) { toast.error("Name is required"); return null; }
    let parsedConfigJson: string | undefined;
    if (type === "ai_extract" && configJson.trim()) {
      try {
        JSON.parse(configJson);
        parsedConfigJson = configJson.trim();
      } catch {
        toast.error("Config JSON is invalid");
        return null;
      }
    }
    return {
      name: name.trim(),
      description: description.trim() || undefined,
      transform_type: type,
      source_table: sourceTable.trim() || undefined,
      target_table: targetTable.trim() || undefined,
      output_sql: type === "sql" ? (outputSql.trim() || undefined) : undefined,
      config_json: type === "ai_extract" ? parsedConfigJson : undefined,
    };
  }

  // ── save transform ────────────────────────────────────────────────────────
  async function handleSave() {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      const effectiveId = savedId ?? (isEdit ? transform!.id : null);
      if (effectiveId) {
        await api.updateTransform(projectId, design.id, effectiveId, payload);
        const base = transform ?? {
          id: effectiveId, design_id: design.id,
          order_index: 0, created_at: new Date().toISOString(),
        };
        onSave({ ...base, ...payload, updated_at: new Date().toISOString() } as DesignTransform);
      } else {
        const created = await api.createTransform(projectId, design.id, payload);
        setSavedId(created.id);
        onSave({
          id: created.id, design_id: design.id,
          order_index: created.order_index,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...payload,
        } as DesignTransform);
      }
      toast.success(isEdit || savedId ? "Transform updated" : "Transform saved");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── auto-save before DDL generation (create mode only) ───────────────────
  async function doAutoSave(): Promise<string | null> {
    const payload = buildPayload();
    if (!payload) return null;
    try {
      const created = await api.createTransform(projectId, design.id, payload);
      const newT: DesignTransform = {
        id: created.id, design_id: design.id,
        order_index: created.order_index,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      } as DesignTransform;
      setSavedId(created.id);
      onSave(newT);
      return created.id;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auto-save failed");
      return null;
    }
  }

  // ── design & create target table ──────────────────────────────────────────
  async function handleGenerateDdl() {
    let id = savedId;
    if (!id) {
      toast.loading("Saving transform first…", { id: "autosave" });
      id = await doAutoSave();
      toast.dismiss("autosave");
      if (!id) return;
    }
    setGeneratingDdl(true);
    try {
      const result = await api.generateTargetTableDdl(projectId, design.id, id);
      const rawDdl = result.ddl.trim();
      // Extract table name, then prepend DROP TABLE IF EXISTS for safe re-runs
      const match = rawDdl.match(/CREATE\s+TABLE\s+(\S+)/i);
      const tableName = match ? match[1].replace(/[;(].*$/, "").trim() : null;
      const ddlWithDrop = tableName
        ? `DROP TABLE IF EXISTS ${tableName};\n\n${rawDdl}`
        : rawDdl;
      setTargetDdl(ddlWithDrop);
      if (tableName) setTargetTable(tableName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "DDL generation failed");
    } finally {
      setGeneratingDdl(false);
    }
  }

  async function handleCreateTable() {
    if (!targetConnId || !targetDdl.trim()) return;
    const id = savedId ?? (isEdit ? transform!.id : null);
    if (!id) return;
    setCreatingTable(true);
    try {
      await api.createTargetTable(projectId, design.id, id, {
        target_connection_id: targetConnId,
        ddl: targetDdl,
      });
      setTableCreated(true);
      toast.success("Table created successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create table");
    } finally {
      setCreatingTable(false);
    }
  }

  const hasOutput = type === "sql" ? !!outputSql.trim() : !!configJson.trim();

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Transform" : "New Transform"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="tf-name">Name</Label>
            <Input id="tf-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Extract Review Theme" autoFocus />
          </div>

          {/* Type */}
          <div className="space-y-1.5">
            <Label>Type</Label>
            <div className="flex gap-2">
              {(["sql", "ai_extract"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setType(t)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-all",
                    type === t
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                  )}>
                  {t === "sql"
                    ? <><Code2 className="h-3.5 w-3.5" /> SQL Transform</>
                    : <><Sparkles className="h-3.5 w-3.5" /> AI Extract</>}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {type === "sql"
                ? "Claude writes a T-SQL INSERT…SELECT once. Runs at build time with no further AI calls."
                : "Claude calls the AI at build time for each source row to extract structured data."}
            </p>
          </div>

          {/* ── Source section ── */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Source
            </Label>
            <div className="rounded-md border border-border p-3 space-y-3 bg-muted/10">

              {/* Connection */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Connection</Label>
                {loadingConns ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : (
                  <Select value={sourceConnId} onValueChange={setSourceConnId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select connection…" />
                    </SelectTrigger>
                    <SelectContent>
                      {allConnections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.is_active ? " (active)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Schema */}
              {sourceConnId && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Schema</Label>
                  {loadingSchema ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading schemas…
                    </div>
                  ) : (
                    <Select value={selectedSchema} onValueChange={setSelectedSchema}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select schema…" />
                      </SelectTrigger>
                      <SelectContent>
                        {schemaData?.schemas.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* Table */}
              {sourceConnId && selectedSchema && !loadingSchema ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Table</Label>
                  <Select value={sourceTable} onValueChange={setSourceTable}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select table…" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredTables.map((t) => (
                        <SelectItem
                          key={`${t.schema_name}.${t.table_name}`}
                          value={`${t.schema_name}.${t.table_name}`}>
                          {t.table_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {sourceTable && (
                    <p className="text-[10px] text-muted-foreground font-mono">{sourceTable}</p>
                  )}
                </div>
              ) : !sourceConnId ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Table (manual)</Label>
                  <Input value={sourceTable} onChange={(e) => setSourceTable(e.target.value)}
                    placeholder="e.g. dbo.CustomerReviews" className="h-8 text-sm" />
                </div>
              ) : null}
            </div>
          </div>

          {/* Source columns hint (ai_extract only) */}
          {type === "ai_extract" && (
            <div className="space-y-1.5">
              <Label htmlFor="tf-cols">
                Source Columns{" "}
                <span className="text-muted-foreground font-normal text-xs">(optional — helps AI)</span>
              </Label>
              <Input id="tf-cols" value={sourceColumns} onChange={(e) => setSourceColumns(e.target.value)}
                placeholder="e.g. ReviewId, review_text, rating" className="h-8 text-sm" />
            </div>
          )}

          {/* ── Target Table ── */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Target Table
            </Label>
            <div className="rounded-md border border-border p-3 space-y-3 bg-muted/10">

              {/* Show current table name if already set */}
              {targetTable && (
                <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
                  <Database className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <code className="text-xs font-mono text-foreground">{targetTable}</code>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                AI will design a <code className="text-[10px]">CREATE TABLE</code> statement
                based on this transform&apos;s output fields.
                {!savedId && !isEdit && (
                  <span className="text-yellow-500/80">
                    {" "}The transform will be auto-saved first.
                  </span>
                )}
              </p>

              {/* Target connection */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Connection</Label>
                {loadingConns ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : (
                  <Select value={targetConnId} onValueChange={setTargetConnId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select connection…" />
                    </SelectTrigger>
                    <SelectContent>
                      {allConnections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.is_active ? " (active)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Design DDL */}
              <Button variant="outline" size="sm" className="w-full gap-2"
                onClick={handleGenerateDdl} disabled={generatingDdl}>
                {generatingDdl
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Designing table…</>
                  : <><Wand2 className="h-3.5 w-3.5" /> Design Table with AI</>}
              </Button>

              {/* DDL textarea */}
              {targetDdl && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">CREATE TABLE Statement</Label>
                  <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>
                      <strong>Warning:</strong> This statement includes{" "}
                      <code className="text-[11px]">DROP TABLE IF EXISTS</code>. If the table
                      already exists on the target connection, it will be{" "}
                      <strong>permanently dropped and all data deleted</strong> before the new
                      table is created.
                    </span>
                  </div>
                  <textarea
                    value={targetDdl}
                    onChange={(e) => setTargetDdl(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Edit if needed. Table is created immediately — ensure it does not already exist.
                  </p>
                </div>
              )}

              {tableCreated && (
                <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-400">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  Table created — you can now run the transform.
                </div>
              )}

              {targetDdl && !tableCreated && (
                <Button size="sm" className="w-full gap-2"
                  onClick={handleCreateTable} disabled={creatingTable || !targetConnId}>
                  {creatingTable
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating…</>
                    : <><Database className="h-3.5 w-3.5" /> Create Table on Database</>}
                </Button>
              )}
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="tf-desc">
              {type === "sql" ? "What to do" : "What to extract"}
            </Label>
            <textarea
              id="tf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              placeholder={type === "sql"
                ? "e.g. Load customer reviews into FACT_REVIEW_THEME, deriving a category from the rating"
                : "e.g. Extract the main theme (e.g. Product Quality, Shipping) and a 1-sentence supporting snippet"}
            />
          </div>

          {/* Generate button */}
          <Button variant="outline" className="w-full gap-2" onClick={handleGenerate}
            disabled={generating || !description.trim()}>
            {generating
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating…</>
              : <><Wand2 className="h-4 w-4" /> Generate {type === "sql" ? "SQL" : "AI Config"}</>}
          </Button>

          {/* Output area */}
          {hasOutput && (
            <div className="space-y-1.5">
              <Label>{type === "sql" ? "Generated SQL" : "AI Extraction Config (JSON)"}</Label>
              <textarea
                value={type === "sql" ? outputSql : configJson}
                onChange={(e) =>
                  type === "sql" ? setOutputSql(e.target.value) : setConfigJson(e.target.value)
                }
                rows={10}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              />
              {type === "ai_extract" && (
                <p className="text-[11px] text-muted-foreground">
                  The <code className="text-[10px]">prompt_template</code> must contain{" "}
                  <code className="text-[10px]">{"{text}"}</code>.
                </p>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Saving…</>
              : <><Save className="h-3.5 w-3.5 mr-2" />{isEdit || savedId ? "Update Transform" : "Save Transform"}</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── TransformCard ─────────────────────────────────────────────────────────────

function TransformCard({
  transform,
  onEdit,
  onDelete,
}: {
  transform: DesignTransform;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isAi = transform.transform_type === "ai_extract";
  const hasContent = isAi ? !!transform.config_json : !!transform.output_sql;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isAi
            ? <Sparkles className="h-4 w-4 text-violet-400 flex-shrink-0" />
            : <Code2 className="h-4 w-4 text-blue-400 flex-shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{transform.name}</p>
            {transform.description && (
              <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{transform.description}</p>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge
                variant="outline"
                className={cn("text-[9px] py-0 h-4", isAi
                  ? "border-violet-500/40 text-violet-400"
                  : "border-blue-500/40 text-blue-400")}>
                {isAi ? "AI Extract" : "SQL Transform"}
              </Badge>
              {transform.source_table && (
                <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">
                  {transform.source_table}
                </span>
              )}
              {transform.target_table && (
                <>
                  <span className="text-[10px] text-muted-foreground">→</span>
                  <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">
                    {transform.target_table}
                  </span>
                </>
              )}
              {!hasContent ? (
                <Badge variant="outline" className="border-yellow-500/50 text-yellow-500 text-[9px] py-0 h-4">
                  <AlertTriangle className="h-2.5 w-2.5 mr-1" /> Not generated
                </Badge>
              ) : (
                <Badge variant="outline" className="border-green-500/40 text-green-500 text-[9px] py-0 h-4">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> Ready
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {hasContent && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
              onClick={() => setExpanded((v) => !v)}>
              {expanded
                ? <ChevronUp className="h-3.5 w-3.5" />
                : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button variant="ghost" size="sm"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && hasContent && (
        <div className="border-t border-border bg-muted/10 px-4 py-3">
          <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap overflow-x-auto max-h-48">
            {isAi
              ? JSON.stringify(JSON.parse(transform.config_json!), null, 2)
              : transform.output_sql}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── TransformsTab ─────────────────────────────────────────────────────────────

export function TransformsTab({ design, projectId }: { design: FullDesign; projectId: string }) {
  const [transforms, setTransforms] = useState<DesignTransform[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<DesignTransform | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    api.listTransforms(projectId, design.id)
      .then(setTransforms)
      .catch(() => toast.error("Failed to load transforms"))
      .finally(() => setLoading(false));
  }, [projectId, design.id]);

  function openCreate() { setEditing(null); setShowDialog(true); }
  function openEdit(t: DesignTransform) { setEditing(t); setShowDialog(true); }

  function handleSaved(saved: DesignTransform) {
    setTransforms((prev) => {
      const idx = prev.findIndex((t) => t.id === saved.id);
      return idx >= 0
        ? prev.map((t) => (t.id === saved.id ? saved : t))
        : [...prev, saved].sort((a, b) => a.order_index - b.order_index);
    });
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await api.deleteTransform(projectId, design.id, id);
      setTransforms((prev) => prev.filter((t) => t.id !== id));
      toast.success("Transform deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
        <p className="text-xs text-muted-foreground">
          Custom data transforms run after ETL — SQL or AI-powered extractions.
        </p>
        <Button size="sm" className="h-7 text-xs gap-1.5" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" /> Add Transform
        </Button>
      </div>

      <div className="px-6 pt-4 pb-6 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading transforms…
          </div>
        ) : transforms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center">
            <Sparkles className="h-7 w-7 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No transforms yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs mx-auto">
              Add a SQL Transform to reshape data with T-SQL, or an AI Extract to pull structured
              fields from unstructured text at build time.
            </p>
            <Button size="sm" className="mt-4 gap-2" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> Add your first transform
            </Button>
          </div>
        ) : (
          transforms.map((t) => (
            <div key={t.id} className={deletingId === t.id ? "opacity-50 pointer-events-none" : ""}>
              <TransformCard
                transform={t}
                onEdit={() => openEdit(t)}
                onDelete={() => handleDelete(t.id)}
              />
            </div>
          ))
        )}
      </div>

      {showDialog && (
        <TransformDialog
          design={design}
          projectId={projectId}
          transform={editing}
          onSave={handleSaved}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}
