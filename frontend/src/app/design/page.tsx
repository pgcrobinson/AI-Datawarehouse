"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import type { Connection, TableInfo, DesignResponse, Project, FullDesign } from "@/lib/types";
import { DesignDetail } from "@/components/projects/DesignDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Wand2, Database, Table2, Check, AlertCircle, Loader2,
  BookOpen, GitFork, Code2, Copy, Save, FolderOpen, Hammer,
  Plus, LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const MermaidDiagram = dynamic(
  () => import("@/components/design/MermaidDiagram").then((m) => m.MermaidDiagram),
  { ssr: false, loading: () => <div className="min-h-[320px]" /> }
);

// Suspense wrapper required by Next.js 14 for useSearchParams
export default function DesignPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <DesignPageInner />
    </Suspense>
  );
}

function DesignPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [allTables, setAllTables] = useState<TableInfo[]>([]);
  const [schema, setSchema] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<DesignResponse | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);

  // Project state
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  // Design name
  const [designName, setDesignName] = useState("");

  // Target schema state
  const [targetSchemaMode, setTargetSchemaMode] = useState<"select" | "new">("select");
  const [targetSchema, setTargetSchema] = useState("");
  const [newSchemaName, setNewSchemaName] = useState("");

  // Save dialog state
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [generatingEtl, setGeneratingEtl] = useState(false);

  // After save (or loaded from URL params): transition to full DesignDetail view
  const [savedDesign, setSavedDesign] = useState<FullDesign | null>(null);
  const [savedProjectId, setSavedProjectId] = useState<string>("");
  const [initialTab, setInitialTab] = useState("erd");
  const [fromProjects, setFromProjects] = useState(false);
  const [loadingFromParams, setLoadingFromParams] = useState(false);

  // Load connections + projects
  useEffect(() => {
    api.listConnections().then((list) => {
      setConnections(list);
      const active = list.find((c) => c.is_active);
      if (active) setConnectionId(active.id);
    }).catch(() => {});
    api.listProjects().then((list) => {
      setProjects(list);
      if (list.length > 0) setProjectId(list[0].id);
    }).catch(() => {});
  }, []);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setCreatingProject(true);
    try {
      const created = await api.createProject(newProjectName.trim());
      setProjects((prev) => [...prev, { ...created, design_count: 0 }]);
      setProjectId(created.id);
      setNewProjectName("");
      setShowNewProject(false);
      toast.success("Project created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreatingProject(false);
    }
  }

  function resolvedTargetSchema(): string | undefined {
    if (targetSchemaMode === "new") return newSchemaName.trim() || undefined;
    return targetSchema || undefined;
  }

  // Load design from URL params when navigating from Projects page
  useEffect(() => {
    const urlProjectId = searchParams.get("projectId");
    const urlDesignId = searchParams.get("designId");
    if (!urlProjectId || !urlDesignId) return;

    setFromProjects(true);
    setLoadingFromParams(true);
    api.getDesign(urlProjectId, urlDesignId)
      .then((full) => {
        setSavedProjectId(urlProjectId);
        setSavedDesign(full);
      })
      .catch(() => toast.error("Failed to load design"))
      .finally(() => setLoadingFromParams(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load schemas + tables when connection changes
  useEffect(() => {
    if (!connectionId) {
      setSchemas([]); setAllTables([]); setSchema(""); setSelected(new Set());
      return;
    }
    setLoadingSchema(true);
    api.getSchema(connectionId)
      .then((data) => {
        setSchemas(data.schemas); setAllTables(data.tables);
        setSchema(data.schemas[0] ?? ""); setSelected(new Set());
      })
      .catch(() => toast.error("Failed to load schema"))
      .finally(() => setLoadingSchema(false));
  }, [connectionId]);

  const filteredTables = useMemo(
    () => allTables.filter((t) => t.schema_name === schema),
    [allTables, schema]
  );

  const allSelected =
    filteredTables.length > 0 &&
    filteredTables.every((t) => selected.has(`${t.schema_name}.${t.table_name}`));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredTables.forEach((t) => next.delete(`${t.schema_name}.${t.table_name}`));
      else filteredTables.forEach((t) => next.add(`${t.schema_name}.${t.table_name}`));
      return next;
    });
  }

  function toggleTable(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function handleGenerate() {
    if (selected.size === 0) { toast.error("Select at least one table"); return; }
    if (!prompt.trim()) { toast.error("Enter a prompt describing your requirements"); return; }
    setGenerating(true); setGenError(null);
    try {
      const tables = Array.from(selected).map((key) => {
        const dot = key.indexOf(".");
        return { schema_name: key.slice(0, dot), table_name: key.slice(dot + 1) };
      });
      const design = await api.generateDesign({
        connection_id: connectionId || undefined,
        tables,
        prompt: prompt.trim(),
        target_schema: resolvedTargetSchema(),
      });
      setResult(design);
      setSaveName(prompt.trim().slice(0, 60));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Generation failed";
      setGenError(msg); toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  async function saveAndTransition(pid: string, name: string, tab = "erd") {
    if (!result) return;
    setSaving(true);
    try {
      const saved = await api.saveDesign(pid, {
        name: name || designName.trim() || prompt.trim().slice(0, 60),
        connection_id: connectionId || undefined,
        target_schema: resolvedTargetSchema(),
        tables_json: JSON.stringify(Array.from(selected).map((key) => {
          const dot = key.indexOf(".");
          return { schema_name: key.slice(0, dot), table_name: key.slice(dot + 1) };
        })),
        prompt: prompt.trim(),
        narrative: result.narrative,
        mermaid_erd: result.mermaid_erd,
        sql_ddl: result.sql_ddl,
      });
      const full = await api.getDesign(pid, saved.id);
      setSavedProjectId(pid);
      setInitialTab(tab);
      setSavedDesign(full);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!projectId) { toast.error("Select a project first"); return; }
    setShowSave(false);
    await saveAndTransition(projectId, saveName.trim());
  }

  async function handleAutoSave(tab = "erd") {
    if (!projectId) { toast.error("Select a project in the left panel first"); return; }
    await saveAndTransition(projectId, prompt.trim().slice(0, 60), tab);
  }

  async function handleGenerateEtlAndSave() {
    if (!projectId) { toast.error("Select a project in the left panel first"); return; }
    if (!result) return;
    setSaving(true);
    try {
      const saved = await api.saveDesign(projectId, {
        name: designName.trim() || prompt.trim().slice(0, 60),
        connection_id: connectionId || undefined,
        target_schema: resolvedTargetSchema(),
        tables_json: JSON.stringify(Array.from(selected).map((key) => {
          const dot = key.indexOf(".");
          return { schema_name: key.slice(0, dot), table_name: key.slice(dot + 1) };
        })),
        prompt: prompt.trim(),
        narrative: result.narrative,
        mermaid_erd: result.mermaid_erd,
        sql_ddl: result.sql_ddl,
      });
      setSaving(false);
      setGeneratingEtl(true);
      await api.generateEtlSQL(projectId, saved.id, {});
      const full = await api.getDesign(projectId, saved.id);
      setSavedProjectId(projectId);
      setInitialTab("etl");
      setSavedDesign(full);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate ETL");
    } finally {
      setSaving(false);
      setGeneratingEtl(false);
    }
  }

  function copySQL() {
    if (!result) return;
    navigator.clipboard.writeText(result.sql_ddl);
    toast.success("Copied to clipboard");
  }

  // Loading design from URL params
  if (loadingFromParams) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Loading design…</p>
        </div>
      </div>
    );
  }

  // After saving (or loaded from URL params), hand off to DesignDetail
  if (savedDesign) {
    return (
      <DesignDetail
        design={savedDesign}
        projectId={savedProjectId}
        initialTab={initialTab}
        onBack={() => {
          if (fromProjects) {
            router.push("/projects");
          } else {
            setSavedDesign(null);
            setInitialTab("erd");
          }
        }}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ─── Left Configuration Panel ─── */}
      <aside className="w-72 flex-shrink-0 border-r border-border flex flex-col bg-card">
        <div className="px-4 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold">Design Configuration</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Set up your project, connection and target schema</p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

          {/* ── 1. Project ── */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <FolderOpen className="h-3 w-3" /> 1 · Project
            </p>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={projects.length === 0 ? "No projects yet" : "Select project…"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!showNewProject ? (
              <button
                onClick={() => setShowNewProject(true)}
                className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
              >
                <Plus className="h-3 w-3" /> Create new project
              </button>
            ) : (
              <form onSubmit={handleCreateProject} className="space-y-1.5">
                <Input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project name…"
                  className="h-7 text-xs"
                />
                <div className="flex gap-1.5">
                  <Button type="submit" size="sm" className="h-6 text-[10px] px-2 flex-1" disabled={creatingProject || !newProjectName.trim()}>
                    {creatingProject ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                    onClick={() => { setShowNewProject(false); setNewProjectName(""); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>

          {/* ── 2. Design Name ── */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <LayoutGrid className="h-3 w-3" /> 2 · Design Name
            </p>
            <Input
              value={designName}
              onChange={(e) => setDesignName(e.target.value)}
              placeholder="e.g. Sales Analytics DW v1"
              className="h-8 text-sm"
            />
          </div>

          {/* ── 3. Connection ── */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <Database className="h-3 w-3" /> 3 · Connection
            </p>
            <Select value={connectionId} onValueChange={setConnectionId} disabled={connections.length === 0}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={connections.length === 0 ? "No connections" : "Select…"} />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="flex items-center gap-2">
                      {c.name}
                      {c.is_active && <Badge variant="secondary" className="text-[9px] py-0 h-4">active</Badge>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── 4. Target Schema ── */}
          {connectionId && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Table2 className="h-3 w-3" /> 4 · Target Schema
              </p>
              <div className="flex gap-1 rounded-md border border-border overflow-hidden text-[10px]">
                <button
                  className={cn("flex-1 py-1 font-medium transition-colors",
                    targetSchemaMode === "select" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent")}
                  onClick={() => setTargetSchemaMode("select")}
                >
                  Select existing
                </button>
                <button
                  className={cn("flex-1 py-1 font-medium transition-colors",
                    targetSchemaMode === "new" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent")}
                  onClick={() => setTargetSchemaMode("new")}
                >
                  Create new
                </button>
              </div>
              {targetSchemaMode === "select" ? (
                loadingSchema ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading schemas…
                  </div>
                ) : schemas.length > 0 ? (
                  <Select value={targetSchema} onValueChange={setTargetSchema}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select schema…" />
                    </SelectTrigger>
                    <SelectContent>
                      {schemas.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-[10px] text-muted-foreground">No schemas found. Use "Create new" to add one.</p>
                )
              ) : (
                <Input
                  value={newSchemaName}
                  onChange={(e) => setNewSchemaName(e.target.value)}
                  placeholder="New schema name…"
                  className="h-8 text-sm"
                />
              )}
              {resolvedTargetSchema() && (
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                  Tables will be built in: <span className="font-mono font-semibold">{resolvedTargetSchema()}</span>
                </p>
              )}
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-border pt-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Source Data</p>
          </div>

          {/* Source Schema */}
          {schemas.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Schema</p>
              <Select value={schema} onValueChange={(s) => { setSchema(s); setSelected(new Set()); }}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {schemas.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Loading schema indicator for tables */}
          {loadingSchema && !connectionId && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading schema…
            </div>
          )}

          {/* Tables */}
          {!loadingSchema && filteredTables.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Table2 className="h-3 w-3" /> Tables
                  {selected.size > 0 && (
                    <Badge variant="secondary" className="text-[9px] py-0 h-4 ml-0.5">{selected.size}</Badge>
                  )}
                </p>
                <button onClick={toggleAll} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto rounded-md border border-border p-1 bg-background">
                {filteredTables.map((t) => {
                  const key = `${t.schema_name}.${t.table_name}`;
                  const isSelected = selected.has(key);
                  return (
                    <button key={key} onClick={() => toggleTable(key)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors",
                        isSelected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}>
                      <div className={cn("h-3.5 w-3.5 rounded border flex-shrink-0 flex items-center justify-center",
                        isSelected ? "border-primary bg-primary" : "border-muted-foreground/40")}>
                        {isSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      <span className="truncate text-xs">{t.table_name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Requirements */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Requirements</p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe your data warehouse requirements. E.g. 'Design a sales analytics warehouse with daily fact granularity. I need to analyse by product, customer, region, and time.'"
              className="w-full h-28 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring leading-relaxed"
            />
          </div>
        </div>

        {/* Generate button */}
        <div className="p-4 border-t border-border shrink-0">
          <Button onClick={handleGenerate} disabled={generating || selected.size === 0 || !prompt.trim()} className="w-full gap-2">
            {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Designing…</> : <><Wand2 className="h-4 w-4" /> Generate Design</>}
          </Button>
        </div>
      </aside>

      {/* ─── Right Results Panel ─── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Empty state */}
        {!result && !generating && !genError && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 p-8">
            <div className="rounded-full bg-primary/10 p-5">
              <Wand2 className="h-9 w-9 text-primary/50" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Ready to design your data warehouse</p>
              <p className="text-xs text-muted-foreground/60 max-w-xs">
                Select source tables on the left, describe your requirements, then click Generate Design.
              </p>
            </div>
          </div>
        )}

        {/* Generating */}
        {generating && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-9 w-9 animate-spin text-primary" />
            <div className="space-y-1 text-center">
              <p className="text-sm font-medium text-muted-foreground">Designing your data warehouse…</p>
              <p className="text-xs text-muted-foreground/60">Claude is analysing your schema — this takes 20–40 seconds</p>
            </div>
          </div>
        )}

        {/* Error */}
        {genError && !generating && (
          <div className="p-6 max-w-2xl">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{genError}</AlertDescription>
            </Alert>
          </div>
        )}

        {/* Results — 4-tab view */}
        {result && !generating && (
          <>
            {/* Design header bar */}
            <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{saveName || prompt.trim().slice(0, 80)}</p>
                <p className="text-xs text-muted-foreground">Generated design</p>
              </div>
            </div>

            {/* Tabs */}
            <Tabs defaultValue="erd">
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
                    <Badge variant="outline" className="text-[9px] py-0 h-4 border-yellow-500/50 text-yellow-500 ml-1">
                      needed
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="build" className="gap-2">
                    <Hammer className="h-3.5 w-3.5" /> Build
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* ERD */}
              <TabsContent value="erd">
                <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
                  <span className="text-xs text-muted-foreground">Entity Relationship Diagram</span>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" disabled={!projectId || saving}
                    onClick={() => { setSaveName(prompt.trim().slice(0, 60)); setShowSave(true); }}>
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Save to Project
                  </Button>
                </div>
                <div className="px-6 pt-3 pb-6 space-y-4">
                  <div className="rounded-lg border border-border bg-card overflow-hidden">
                    <MermaidDiagram code={result.mermaid_erd} canvasHeight="calc(100vh - 206px)" />
                  </div>
                  {result.narrative && (
                    <div className="space-y-2">
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        <BookOpen className="h-3.5 w-3.5 text-primary" /> Design Narrative
                      </h3>
                      <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                        {result.narrative}
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* DDL SQL */}
              <TabsContent value="ddl">
                <div className="flex items-center justify-between px-6 py-2 border-b border-border bg-muted/20">
                  <span className="text-xs text-muted-foreground font-mono">DDL — CREATE TABLE statements</span>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={copySQL}>
                      <Copy className="h-3 w-3" /> Copy
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" disabled={!projectId || saving}
                      onClick={() => { setSaveName(prompt.trim().slice(0, 60)); setShowSave(true); }}>
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Save to Project
                    </Button>
                  </div>
                </div>
                <div
                  className="mx-6 my-3 rounded-lg border border-border bg-card overflow-hidden flex flex-col"
                  style={{ height: "calc(100vh - 181px)", minHeight: 400 }}
                >
                  {result.sql_ddl ? (
                    <pre className="flex-1 p-4 text-xs font-mono overflow-auto whitespace-pre text-foreground/90 leading-relaxed">
                      {result.sql_ddl}
                    </pre>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                      No SQL generated.
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* ETL SQL */}
              <TabsContent value="etl">
                <div
                  className="flex flex-col items-center justify-center gap-4 text-center p-12"
                  style={{ height: "calc(100vh - 116px)" }}
                >
                  <div className="rounded-full bg-muted p-5">
                    <Wand2 className="h-8 w-8 text-muted-foreground/40" />
                  </div>
                  <div className="space-y-1 max-w-sm">
                    <p className="text-sm font-medium">Generate ETL SQL</p>
                    <p className="text-xs text-muted-foreground">
                      AI will generate INSERT … SELECT statements to load your source data into the warehouse.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="gap-2" disabled={!projectId || saving || generatingEtl}
                      onClick={() => { setSaveName(prompt.trim().slice(0, 60)); setShowSave(true); }}>
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Save to Project
                    </Button>
                    <Button size="sm" className="gap-2" onClick={handleGenerateEtlAndSave} disabled={saving || generatingEtl}>
                      {saving
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>
                        : generatingEtl
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating ETL…</>
                        : <><Wand2 className="h-3.5 w-3.5" /> Generate ETL SQL</>}
                    </Button>
                  </div>
                  {!projectId && (
                    <p className="text-[10px] text-yellow-500">Select a project in the left panel first.</p>
                  )}
                </div>
              </TabsContent>

              {/* Build */}
              <TabsContent value="build">
                <div
                  className="flex flex-col items-center justify-center gap-4 text-center p-12"
                  style={{ height: "calc(100vh - 116px)" }}
                >
                  <div className="rounded-full bg-muted p-5">
                    <Hammer className="h-8 w-8 text-muted-foreground/40" />
                  </div>
                  <div className="space-y-1 max-w-sm">
                    <p className="text-sm font-medium">Build Warehouse</p>
                    <p className="text-xs text-muted-foreground">
                      Execute DDL and ETL SQL against a target database to create and populate the warehouse.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="gap-2" disabled={!projectId || saving}
                      onClick={() => { setSaveName(prompt.trim().slice(0, 60)); setShowSave(true); }}>
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Save to Project
                    </Button>
                    <Button size="sm" className="gap-2" onClick={() => handleAutoSave("build")} disabled={saving}>
                      {saving
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>
                        : <><Hammer className="h-3.5 w-3.5" /> Continue to Build</>}
                    </Button>
                  </div>
                  {!projectId && (
                    <p className="text-[10px] text-yellow-500">Select a project in the left panel first.</p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

      {/* Save Dialog */}
      <Dialog open={showSave} onOpenChange={setShowSave}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Design</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Design Name</Label>
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Sales Analytics DW v1" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowSave(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !saveName.trim() || !projectId} className="gap-2">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
