"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { Project, SavedDesign } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Trash2, FolderOpen, Loader2, ChevronRight, FileCode2, ArrowLeft, Pencil,
} from "lucide-react";
import { toast } from "sonner";

type View = "projects" | "designs";

export default function ProjectsPage() {
  const router = useRouter();
  const [view, setView] = useState<View>("projects");

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const [openProject, setOpenProject] = useState<Project | null>(null);
  const [designs, setDesigns] = useState<SavedDesign[]>([]);
  const [loadingDesigns, setLoadingDesigns] = useState(false);

  const [editingDesignId, setEditingDesignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renaming, setRenaming] = useState(false);

  async function loadProjects() {
    try {
      setProjects(await api.listProjects());
    } catch {
      toast.error("Failed to load projects");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadProjects(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createProject(newName.trim(), newDesc.trim() || undefined);
      setNewName(""); setNewDesc(""); setShowCreate(false);
      await loadProjects();
      toast.success("Project created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteProject(id: string) {
    try {
      await api.deleteProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
      toast.success("Project deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  async function openProjectView(project: Project) {
    setOpenProject(project);
    setLoadingDesigns(true);
    setView("designs");
    try {
      setDesigns(await api.listDesigns(project.id));
    } catch {
      toast.error("Failed to load designs");
    } finally {
      setLoadingDesigns(false);
    }
  }

  function openDesignView(design: SavedDesign) {
    if (!openProject) return;
    router.push(`/design?projectId=${openProject.id}&designId=${design.id}`);
  }

  async function handleRenameDesign(designId: string) {
    if (!openProject) return;
    const newName = editingName.trim();
    const original = designs.find((d) => d.id === designId)?.name ?? "";
    if (!newName || newName === original) { setEditingDesignId(null); return; }
    setRenaming(true);
    try {
      await api.renameDesign(openProject.id, designId, newName);
      setDesigns((prev) => prev.map((d) => d.id === designId ? { ...d, name: newName } : d));
      toast.success("Design renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setRenaming(false);
      setEditingDesignId(null);
    }
  }

  async function handleDeleteDesign(designId: string) {
    if (!openProject) return;
    try {
      await api.deleteDesign(openProject.id, designId);
      setDesigns((d) => d.filter((x) => x.id !== designId));
      toast.success("Design deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  function fmt(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric", month: "short", year: "numeric",
    });
  }

  // ── Designs list ──────────────────────────────────────────────────────────────
  if (view === "designs" && openProject) {
    return (
      <div className="p-6 max-w-4xl space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5 -ml-2"
            onClick={() => { setView("projects"); setOpenProject(null); }}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{openProject.name}</h1>
            {openProject.description && (
              <p className="text-sm text-muted-foreground">{openProject.description}</p>
            )}
          </div>
        </div>

        {loadingDesigns ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading designs…
          </div>
        ) : designs.length === 0 ? (
          <div className="rounded-lg border border-border p-12 text-center">
            <FileCode2 className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No designs saved yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Go to Design and save a generated design to this project.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {designs.map((d) => (
              <div key={d.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-accent/30 transition-colors">

                {editingDesignId === d.id ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FileCode2 className="h-4 w-4 text-primary/60 flex-shrink-0" />
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameDesign(d.id);
                        if (e.key === "Escape") setEditingDesignId(null);
                      }}
                      onBlur={() => handleRenameDesign(d.id)}
                      disabled={renaming}
                      className="flex-1 min-w-0 text-sm font-medium bg-background border border-ring rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                ) : (
                  <button
                    className="flex items-center gap-3 flex-1 text-left min-w-0"
                    onClick={() => openDesignView(d)}
                  >
                    <FileCode2 className="h-4 w-4 text-primary/60 flex-shrink-0" />
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-sm font-medium truncate">{d.name}</p>
                      {d.prompt && (
                        <p className="text-xs text-muted-foreground line-clamp-1 max-w-lg">{d.prompt}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground/60">Saved {fmt(d.created_at)}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/40 ml-auto flex-shrink-0" />
                  </button>
                )}

                <div className="flex items-center gap-0.5 ml-2 flex-shrink-0">
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    disabled={editingDesignId !== null && editingDesignId !== d.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingName(d.name);
                      setEditingDesignId(d.id);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); handleDeleteDesign(d.id); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Project list ──────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Organise your warehouse designs into projects.
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> New Project
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-border p-16 text-center">
          <FolderOpen className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No projects yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Create a project to start saving your designs.
          </p>
          <Button size="sm" className="mt-4 gap-2" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> New Project
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <div key={p.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-accent/30 transition-colors">
              <button
                className="flex items-center gap-3 flex-1 text-left"
                onClick={() => openProjectView(p)}
              >
                <FolderOpen className="h-4 w-4 text-primary/60 flex-shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">{fmt(p.created_at)}</p>
                </div>
                <Badge variant="secondary" className="ml-auto mr-2 text-[10px]">
                  {p.design_count} design{p.design_count !== 1 ? "s" : ""}
                </Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground/40" />
              </button>
              <Button
                variant="ghost" size="icon"
                className="h-7 w-7 ml-2 text-muted-foreground hover:text-destructive flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Name</Label>
              <Input id="proj-name" value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Sales Analytics DW" autoFocus required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-desc">
                Description <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="proj-desc" value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Brief description…" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
