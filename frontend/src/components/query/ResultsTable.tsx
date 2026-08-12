"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CheckCircle2, Clock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { QueryResult } from "@/lib/types";

interface Props {
  result: QueryResult | null;
  loading: boolean;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

export function ResultsTable({ result, loading }: Props) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Reset to first page whenever results change
  useEffect(() => { setPage(0); }, [result]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground gap-2">
        <Clock className="h-4 w-4 animate-pulse" />
        Running query…
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Run a query to see results
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <pre className="whitespace-pre-wrap font-mono text-xs">{result.error}</pre>
        </div>
      </div>
    );
  }

  if (result.columns.length === 0) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-green-400">
        <CheckCircle2 className="h-4 w-4" />
        Query executed successfully. {result.row_count} row(s) affected.
        <span className="text-muted-foreground text-xs ml-2">
          ({result.execution_time_ms.toFixed(1)}ms)
        </span>
      </div>
    );
  }

  const totalRows = result.rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = result.rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const firstRow = safePage * pageSize + 1;
  const lastRow = Math.min(safePage * pageSize + pageRows.length, totalRows);

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-muted/30 text-xs text-muted-foreground shrink-0">
        <span className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-green-500" />
          {totalRows.toLocaleString()} row{totalRows !== 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {result.execution_time_ms.toFixed(1)}ms
        </span>
        <Badge variant="secondary" className="py-0 text-[10px]">
          {result.columns.length} col{result.columns.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Scrollable table — both axes */}
      <div className="flex-1 overflow-auto">
        <table className="text-xs border-collapse w-max min-w-full">
          <thead className="sticky top-0 z-10 bg-[hsl(var(--muted)/0.95)] backdrop-blur-sm">
            <tr>
              {/* Row number header */}
              <th className="text-right px-2 py-2 font-normal text-muted-foreground/50 border-b border-r border-border w-10 select-none">
                #
              </th>
              {result.columns.map((col) => (
                <th
                  key={col}
                  className="text-left px-3 py-2 font-semibold text-muted-foreground border-b border-r border-border whitespace-nowrap last:border-r-0"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => {
              const absoluteRow = safePage * pageSize + ri + 1;
              return (
                <tr
                  key={ri}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="text-right px-2 py-1.5 text-muted-foreground/40 border-r border-border text-[10px] select-none tabular-nums">
                    {absoluteRow}
                  </td>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-3 py-1.5 font-mono whitespace-nowrap border-r border-border/30 last:border-r-0 max-w-sm truncate"
                    >
                      {cell === null ? (
                        <span className="text-muted-foreground/50 italic">NULL</span>
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination bar */}
      <div className="flex items-center justify-between gap-4 px-4 py-2 border-t border-border bg-card shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => { setPageSize(Number(v)); setPage(0); }}
          >
            <SelectTrigger className="h-7 w-16 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-xs text-muted-foreground tabular-nums">
          {firstRow}–{lastRow} of {totalRows.toLocaleString()}
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon"
            className="h-7 w-7"
            onClick={() => setPage(0)}
            disabled={safePage === 0}
            title="First page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost" size="icon"
            className="h-7 w-7"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground px-2 tabular-nums">
            {safePage + 1} / {totalPages}
          </span>
          <Button
            variant="ghost" size="icon"
            className="h-7 w-7"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
            title="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost" size="icon"
            className="h-7 w-7"
            onClick={() => setPage(totalPages - 1)}
            disabled={safePage >= totalPages - 1}
            title="Last page"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
