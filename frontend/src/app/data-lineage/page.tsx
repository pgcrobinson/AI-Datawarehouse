"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  GitBranch, ChevronRight, History, Loader2,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { DbtProject } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const DBT_PROJECT_KEY = "dwb_ds_project";
const NODE_W = 180;
const NODE_H = 48;
const GAP_X = 100;
const GAP_Y = 20;
const PAD = 48;

// ── types ─────────────────────────────────────────────────────────────────────

interface DagNode {
  id: string;
  name: string;
  type: "model" | "snapshot" | "source";
  sql: string | null;
}

interface DagEdge {
  source: string;
  target: string;
}

// ── layout algorithm ──────────────────────────────────────────────────────────

function computeLayout(nodes: DagNode[], edges: DagEdge[]): Map<string, { x: number; y: number }> {
  const parents = new Map<string, Set<string>>();
  nodes.forEach((n) => parents.set(n.id, new Set()));
  edges.forEach((e) => parents.get(e.target)?.add(e.source));

  // Longest-path layering with cycle guard
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  function getLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = [...(parents.get(id) ?? [])];
    const l = ps.length === 0 ? 0 : Math.max(...ps.map(getLayer)) + 1;
    visiting.delete(id);
    layerOf.set(id, l);
    return l;
  }
  nodes.forEach((n) => getLayer(n.id));

  // Group by layer
  const byLayer = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = layerOf.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  });

  const numLayers = Math.max(...[...layerOf.values(), 0]) + 1;
  const pos = new Map<string, { x: number; y: number }>();

  // Assign positions, using barycenter sort for layers > 0
  for (let l = 0; l < numLayers; l++) {
    const group = [...(byLayer.get(l) ?? [])].sort((a, b) => {
      if (l === 0) return a.localeCompare(b);
      const avg = (ids: string[]) =>
        ids.length === 0 ? 0 : ids.reduce((s, id) => s + (pos.get(id)?.y ?? 0), 0) / ids.length;
      return avg([...(parents.get(a) ?? [])]) - avg([...(parents.get(b) ?? [])]);
    });
    group.forEach((id, i) => {
      pos.set(id, { x: l * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) });
    });
  }
  return pos;
}

// ── color scheme ──────────────────────────────────────────────────────────────

function nodeColors(type: "model" | "snapshot" | "source") {
  switch (type) {
    case "model":    return { fill: "#052e16", stroke: "#16a34a", text: "#4ade80", dim: "#166534" };
    case "snapshot": return { fill: "#2e1065", stroke: "#7c3aed", text: "#c084fc", dim: "#4c1d95" };
    case "source":   return { fill: "#0f172a", stroke: "#475569", text: "#94a3b8", dim: "#1e293b" };
  }
}

// ── DAG SVG ───────────────────────────────────────────────────────────────────

interface DagCanvasProps {
  nodes: DagNode[];
  edges: DagEdge[];
  positions: Map<string, { x: number; y: number }>;
  focusedId: string | null;
  onNodeClick: (node: DagNode) => void;
}

function DagCanvas({ nodes, edges, positions, focusedId, onNodeClick }: DagCanvasProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Build adjacency for hover highlight
  const connectedIds = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const s = new Set<string>();
    edges.forEach((e) => {
      if (e.source === hoveredId) s.add(e.target);
      if (e.target === hoveredId) s.add(e.source);
    });
    return s;
  }, [hoveredId, edges]);

  const allPos = [...positions.values()];
  if (allPos.length === 0) return null;

  const svgW = Math.max(...allPos.map((p) => p.x)) + NODE_W + PAD * 2;
  const svgH = Math.max(...allPos.map((p) => p.y)) + NODE_H + PAD * 2;

  return (
    <svg width={svgW} height={svgH} style={{ display: "block" }}>
      <defs>
        <marker id="arr" markerWidth="7" markerHeight="6" refX="6" refY="3" orient="auto">
          <polygon points="0 0, 7 3, 0 6" fill="#334155" />
        </marker>
        <marker id="arr-hi" markerWidth="7" markerHeight="6" refX="6" refY="3" orient="auto">
          <polygon points="0 0, 7 3, 0 6" fill="#64748b" />
        </marker>
      </defs>

      {/* Edges — drawn first so nodes render on top */}
      {edges.map((edge) => {
        const sp = positions.get(edge.source);
        const tp = positions.get(edge.target);
        if (!sp || !tp) return null;
        const sx = sp.x + NODE_W + PAD;
        const sy = sp.y + NODE_H / 2 + PAD;
        const tx = tp.x + PAD;
        const ty = tp.y + NODE_H / 2 + PAD;
        const cx = (sx + tx) / 2;
        const isHi =
          hoveredId === edge.source || hoveredId === edge.target ||
          focusedId === edge.source || focusedId === edge.target;
        return (
          <path
            key={`${edge.source}→${edge.target}`}
            d={`M${sx},${sy} C${cx},${sy} ${cx},${ty} ${tx},${ty}`}
            fill="none"
            stroke={isHi ? "#475569" : "#1e293b"}
            strokeWidth={isHi ? 2 : 1.5}
            markerEnd={`url(#${isHi ? "arr-hi" : "arr"})`}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((node) => {
        const p = positions.get(node.id);
        if (!p) return null;
        const x = p.x + PAD;
        const y = p.y + PAD;
        const c = nodeColors(node.type);
        const isFocused = node.id === focusedId;
        const isHovered = node.id === hoveredId;
        const isConnected = connectedIds.has(node.id);
        const dimmed = !!hoveredId && !isHovered && !isConnected;

        // Source nodes with schema.table get two-line display
        const dotIdx = node.type === "source" ? node.name.indexOf(".") : -1;
        const isTwoLine = dotIdx !== -1;
        const schemaLabel = isTwoLine ? node.name.slice(0, dotIdx) : null;
        const tableLabel = isTwoLine
          ? (node.name.slice(dotIdx + 1).length > 22 ? node.name.slice(dotIdx + 1, dotIdx + 22) + "…" : node.name.slice(dotIdx + 1))
          : null;
        const singleLabel = !isTwoLine
          ? (node.name.length > 22 ? node.name.slice(0, 21) + "…" : node.name)
          : null;

        return (
          <g
            key={node.id}
            transform={`translate(${x},${y})`}
            onClick={() => onNodeClick(node)}
            onMouseEnter={() => setHoveredId(node.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={{ cursor: node.sql ? "pointer" : "default" }}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={8}
              fill={dimmed ? c.dim : c.fill}
              stroke={c.stroke}
              strokeWidth={isFocused ? 2.5 : isHovered ? 2 : 1.5}
              opacity={dimmed ? 0.45 : 1}
            />
            {isTwoLine ? (
              <>
                {/* Schema prefix */}
                <text
                  x={NODE_W / 2} y={14}
                  textAnchor="middle" dominantBaseline="middle"
                  fontFamily="ui-monospace, monospace"
                  fontSize={9} fontWeight={400}
                  fill={dimmed ? "#1e293b" : "#64748b"}
                >
                  {schemaLabel}
                </text>
                {/* Table name */}
                <text
                  x={NODE_W / 2} y={29}
                  textAnchor="middle" dominantBaseline="middle"
                  fontFamily="ui-monospace, monospace"
                  fontSize={11} fontWeight={500}
                  fill={dimmed ? "#64748b" : c.text}
                >
                  {tableLabel}
                </text>
                {/* Badge */}
                <text
                  x={NODE_W / 2} y={43}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={9}
                  fill={dimmed ? "#1e293b" : "#475569"}
                >
                  source table
                </text>
              </>
            ) : (
              <>
                {/* Name */}
                <text
                  x={NODE_W / 2} y={NODE_H / 2 - 6}
                  textAnchor="middle" dominantBaseline="middle"
                  fontFamily="ui-monospace, monospace"
                  fontSize={11} fontWeight={500}
                  fill={dimmed ? "#64748b" : c.text}
                >
                  {singleLabel}
                </text>
                {/* Type badge */}
                <text
                  x={NODE_W / 2} y={NODE_H / 2 + 9}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={9}
                  fill={dimmed ? "#334155" : "#64748b"}
                >
                  {node.type}{node.sql ? " · click for SQL" : ""}
                </text>
              </>
            )}
            {/* Focus ring */}
            {isFocused && (
              <rect
                x={-3} y={-3}
                width={NODE_W + 6}
                height={NODE_H + 6}
                rx={11}
                fill="none"
                stroke={c.stroke}
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.6}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── SQL modal ─────────────────────────────────────────────────────────────────

function SqlModal({ node, onClose }: { node: DagNode | null; onClose: () => void }) {
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-card border-border flex flex-col max-h-[80vh]">
        {node && (
          <>
            <div className="shrink-0">
              <div className="flex items-center gap-2">
                {node.type === "snapshot"
                  ? <History className="h-4 w-4 text-purple-400" />
                  : <GitBranch className="h-4 w-4 text-green-400" />}
                <h2 className="text-base font-semibold font-mono">{node.name}</h2>
                <span className="text-[10px] border border-border rounded px-1.5 py-0.5 text-muted-foreground">
                  {node.type}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-auto min-h-0 mt-2">
              <pre className="bg-[#0d1117] rounded p-4 text-xs font-mono text-green-300 leading-relaxed whitespace-pre-wrap break-words">
                {node.sql || "(no SQL available)"}
              </pre>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function DataLineagePage() {
  const [dbtProjects, setDbtProjects] = useState<DbtProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(DBT_PROJECT_KEY) ?? "" : ""
  );
  const [nodes, setNodes] = useState<DagNode[]>([]);
  const [edges, setEdges] = useState<DagEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sqlModal, setSqlModal] = useState<DagNode | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const positions = useMemo(() => computeLayout(nodes, edges), [nodes, edges]);

  // Load projects on mount
  useEffect(() => {
    api.dsListProjects().then((r) => {
      setDbtProjects(r.projects);
      if (currentProjectId && !r.projects.find((p) => p.id === currentProjectId)) {
        const first = r.projects[0]?.id ?? "";
        setCurrentProjectId(first);
        if (first) localStorage.setItem(DBT_PROJECT_KEY, first);
        else localStorage.removeItem(DBT_PROJECT_KEY);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load lineage when project changes
  useEffect(() => {
    if (!currentProjectId) { setNodes([]); setEdges([]); return; }
    setLoading(true);
    setFocusedId(null);
    api.dsGetLineage(currentProjectId)
      .then((r) => { setNodes(r.nodes); setEdges(r.edges); })
      .catch(() => toast.error("Could not load lineage"))
      .finally(() => setLoading(false));
  }, [currentProjectId]);

  function selectProject(id: string) {
    if (id === currentProjectId) return;
    setCurrentProjectId(id);
    localStorage.setItem(DBT_PROJECT_KEY, id);
  }

  function focusNode(id: string) {
    setFocusedId(id);
    const p = positions.get(id);
    if (!p || !canvasRef.current) return;
    const el = canvasRef.current;
    el.scrollTo({
      left: Math.max(0, p.x + PAD + NODE_W / 2 - el.clientWidth / 2),
      top: Math.max(0, p.y + PAD + NODE_H / 2 - el.clientHeight / 2),
      behavior: "smooth",
    });
  }

  function handleNodeClick(node: DagNode) {
    setFocusedId(node.id);
    if (node.sql) setSqlModal(node);
  }

  const currentProject = dbtProjects.find((p) => p.id === currentProjectId);
  const dbtModels = nodes.filter((n) => n.type !== "source");

  return (
    <div className="flex h-screen overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div className="w-56 shrink-0 border-r border-border flex flex-col bg-card overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <GitBranch className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Data Lineage</span>
        </div>

        {/* Project picker */}
        <div className="border-b border-border shrink-0">
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Project</span>
          </div>
          {dbtProjects.length === 0 ? (
            <p className="px-3 pb-3 text-[10px] text-muted-foreground">
              No projects — create one in Data Studio
            </p>
          ) : (
            <div className="pb-1">
              {dbtProjects.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "flex items-center px-3 py-1.5 cursor-pointer text-xs hover:bg-accent",
                    currentProjectId === p.id && "text-primary bg-primary/10"
                  )}
                  onClick={() => selectProject(p.id)}
                >
                  <span className="truncate font-medium">{p.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Model list */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-border shrink-0">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Models ({dbtModels.length})
            </span>
          </div>
          <ScrollArea className="flex-1">
            {dbtModels.length === 0 ? (
              <p className="px-3 py-3 text-[10px] text-muted-foreground">
                {currentProjectId ? "No models in this project" : "Select a project"}
              </p>
            ) : (
              <div className="py-1">
                {dbtModels.map((n) => (
                  <div
                    key={n.id}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-xs hover:bg-accent",
                      focusedId === n.id && "text-primary bg-primary/10"
                    )}
                    onClick={() => focusNode(n.id)}
                  >
                    {n.type === "snapshot"
                      ? <History className="h-3 w-3 shrink-0 opacity-60" />
                      : <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
                    <span className="truncate font-mono">{n.name}</span>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Legend */}
        <div className="border-t border-border px-3 py-3 shrink-0">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Legend</p>
          {(
            [
              { type: "source" as const,   label: "Source table",   color: "#64748b" },
              { type: "model" as const,    label: "dbt model",      color: "#4ade80" },
              { type: "snapshot" as const, label: "Snapshot (SCD)", color: "#c084fc" },
            ]
          ).map(({ type, label, color }) => (
            <div key={type} className="flex items-center gap-2 mb-1">
              <div
                className="w-3 h-3 rounded-sm border shrink-0"
                style={{ borderColor: color, backgroundColor: nodeColors(type).fill }}
              />
              <span className="text-[10px] text-muted-foreground">{label}</span>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground mt-2 leading-tight">
            Click a model/snapshot node to view its SQL
          </p>
        </div>
      </div>

      {/* ── Canvas ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card shrink-0">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {currentProject ? currentProject.name : "No project selected"}
          </span>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {!loading && nodes.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {nodes.length} node{nodes.length !== 1 ? "s" : ""} · {edges.length} edge{edges.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* DAG viewport */}
        <div
          ref={canvasRef}
          className="flex-1 overflow-auto"
          style={{ background: "#060a12" }}
          onClick={(e) => { if (e.target === e.currentTarget) setFocusedId(null); }}
        >
          {!currentProjectId ? (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              Select a project to view its data lineage
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              No models yet — add models in Data Studio
            </div>
          ) : (
            <DagCanvas
              nodes={nodes}
              edges={edges}
              positions={positions}
              focusedId={focusedId}
              onNodeClick={handleNodeClick}
            />
          )}
        </div>
      </div>

      <SqlModal node={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}
