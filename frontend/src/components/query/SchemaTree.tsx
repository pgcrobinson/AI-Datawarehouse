"use client";

import { useState, useEffect } from "react";
import {
  ChevronRight, ChevronDown, Table2, Layers, Columns,
  RefreshCw, KeyRound,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SchemaData, ColumnInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  onTableClick: (schema: string, table: string) => void;
  connectionId?: string;
}

interface TableNode {
  schema_name: string;
  table_name: string;
  table_type: string;
  columns?: ColumnInfo[];
  loadingColumns?: boolean;
  expanded?: boolean;
}

export function SchemaTree({ onTableClick, connectionId }: Props) {
  const [data, setData] = useState<SchemaData | null>(null);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tables, setTables] = useState<Record<string, TableNode[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadSchema() {
    setLoading(true);
    setError("");
    try {
      const result = await api.getSchema(connectionId);
      setData(result);
      const grouped: Record<string, TableNode[]> = {};
      for (const t of result.tables) {
        if (!grouped[t.schema_name]) grouped[t.schema_name] = [];
        grouped[t.schema_name].push({ ...t });
      }
      setTables(grouped);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schema");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSchema(); }, [connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSchema(schema: string) {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      next.has(schema) ? next.delete(schema) : next.add(schema);
      return next;
    });
  }

  async function toggleTable(schema: string, tableName: string) {
    const schemaNodes = tables[schema];
    const idx = schemaNodes.findIndex((t) => t.table_name === tableName);
    if (idx === -1) return;

    const node = schemaNodes[idx];
    if (node.expanded) {
      setTables((prev) => {
        const updated = [...prev[schema]];
        updated[idx] = { ...node, expanded: false };
        return { ...prev, [schema]: updated };
      });
      return;
    }

    if (!node.columns) {
      setTables((prev) => {
        const updated = [...prev[schema]];
        updated[idx] = { ...node, loadingColumns: true };
        return { ...prev, [schema]: updated };
      });
      try {
        const res = await api.getColumns(schema, tableName, connectionId);
        setTables((prev) => {
          const updated = [...prev[schema]];
          updated[idx] = { ...node, columns: res.columns, expanded: true, loadingColumns: false };
          return { ...prev, [schema]: updated };
        });
      } catch {
        setTables((prev) => {
          const updated = [...prev[schema]];
          updated[idx] = { ...node, loadingColumns: false };
          return { ...prev, [schema]: updated };
        });
      }
    } else {
      setTables((prev) => {
        const updated = [...prev[schema]];
        updated[idx] = { ...node, expanded: true };
        return { ...prev, [schema]: updated };
      });
    }
  }

  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">
        <p>{error}</p>
        <Button size="sm" variant="ghost" onClick={loadSchema} className="mt-2">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Schema</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={loadSchema} disabled={loading}>
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {!data && !loading && (
          <p className="text-xs text-muted-foreground p-3">No active connection</p>
        )}
        {loading && (
          <p className="text-xs text-muted-foreground p-3">Loading schema…</p>
        )}
        {data && (
          <div className="py-1">
            {Object.keys(tables).map((schema) => (
              <div key={schema}>
                <button
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-semibold hover:bg-accent transition-colors"
                  onClick={() => toggleSchema(schema)}
                >
                  {expandedSchemas.has(schema)
                    ? <ChevronDown className="h-3 w-3 shrink-0" />
                    : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <Layers className="h-3 w-3 shrink-0 text-primary" />
                  <span className="truncate">{schema}</span>
                  <span className="ml-auto text-muted-foreground font-normal">
                    {tables[schema].length}
                  </span>
                </button>

                {expandedSchemas.has(schema) && tables[schema].map((t) => (
                  <div key={t.table_name}>
                    <button
                      className="flex w-full items-center gap-1.5 pl-6 pr-3 py-1 text-xs hover:bg-accent transition-colors"
                      onClick={() => toggleTable(schema, t.table_name)}
                      onDoubleClick={() => onTableClick(schema, t.table_name)}
                      title="Double-click to insert SELECT into editor"
                    >
                      {t.expanded
                        ? <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                        : <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
                      <Table2 className="h-3 w-3 shrink-0 text-blue-400" />
                      <span className="truncate">{t.table_name}</span>
                      {t.table_type === "VIEW" && (
                        <span className="ml-auto text-muted-foreground text-[10px]">view</span>
                      )}
                    </button>

                    {t.expanded && t.columns && (
                      <div className="ml-8">
                        {t.columns.map((col) => (
                          <div
                            key={col.column_name}
                            className="flex items-center gap-1.5 pl-3 pr-3 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {col.is_primary_key
                              ? <KeyRound className="h-3 w-3 shrink-0 text-yellow-500" />
                              : <Columns className="h-3 w-3 shrink-0 opacity-40" />}
                            <span className="truncate">{col.column_name}</span>
                            <span className="ml-auto text-[10px] opacity-50 shrink-0">{col.data_type}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {t.loadingColumns && (
                      <p className="pl-10 text-[11px] text-muted-foreground py-0.5">Loading…</p>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
