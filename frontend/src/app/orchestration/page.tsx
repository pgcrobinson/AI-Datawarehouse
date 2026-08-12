"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Clock, Play, Pause, Trash2, Plus, RefreshCw, ChevronDown,
  ChevronRight, CheckCircle2, XCircle, Loader2, Calendar,
  AlertTriangle, Activity, Zap, Timer, Pencil, Search, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { OrchestratorSchedule, OrchestratorRun, OrchestratorStats, DbtProject } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(iso?: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "overdue";
  const m = Math.floor(diff / 60000);
  if (m < 60)  return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtDuration(s?: number | null): string {
  if (s == null) return "—";
  if (s < 60)   return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ── timezone list ─────────────────────────────────────────────────────────────

const TIMEZONES = [
  { label: "UTC",                         value: "UTC" },
  { label: "Eastern Time (US)",           value: "America/New_York" },
  { label: "Central Time (US)",           value: "America/Chicago" },
  { label: "Mountain Time (US)",          value: "America/Denver" },
  { label: "Pacific Time (US)",           value: "America/Los_Angeles" },
  { label: "Alaska",                      value: "America/Anchorage" },
  { label: "Hawaii",                      value: "Pacific/Honolulu" },
  { label: "São Paulo (BRT)",             value: "America/Sao_Paulo" },
  { label: "London (GMT/BST)",            value: "Europe/London" },
  { label: "Central Europe (CET/CEST)",   value: "Europe/Paris" },
  { label: "Eastern Europe (EET/EEST)",   value: "Europe/Helsinki" },
  { label: "Moscow (MSK)",                value: "Europe/Moscow" },
  { label: "Dubai (GST)",                 value: "Asia/Dubai" },
  { label: "India (IST)",                 value: "Asia/Kolkata" },
  { label: "Indochina (ICT)",             value: "Asia/Bangkok" },
  { label: "Singapore / Malaysia (SGT)",  value: "Asia/Singapore" },
  { label: "Hong Kong (HKT)",             value: "Asia/Hong_Kong" },
  { label: "Japan (JST)",                 value: "Asia/Tokyo" },
  { label: "China (CST)",                 value: "Asia/Shanghai" },
  { label: "Sydney (AEST/AEDT)",          value: "Australia/Sydney" },
  { label: "Auckland (NZST/NZDT)",        value: "Pacific/Auckland" },
];

// ── schedule description helpers ──────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function h24ToH12(h24: number): { hour: number; ampm: "AM" | "PM" } {
  if (h24 === 0)   return { hour: 12, ampm: "AM" };
  if (h24 < 12)   return { hour: h24, ampm: "AM" };
  if (h24 === 12) return { hour: 12,  ampm: "PM" };
  return { hour: h24 - 12, ampm: "PM" };
}

function h12ToH24(hour: number, ampm: "AM" | "PM"): number {
  if (ampm === "AM") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  const r = n % 10;
  if (r === 1) return `${n}st`;
  if (r === 2) return `${n}nd`;
  if (r === 3) return `${n}rd`;
  return `${n}th`;
}

function tzLabel(tz: string): string {
  return TIMEZONES.find(t => t.value === tz)?.label ?? tz;
}

function describeSchedule(cron: string, tz = "UTC"): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [mnStr, hrStr, domStr, , dowStr] = p;
  const tzSuffix = tz && tz !== "UTC" ? ` · ${tzLabel(tz)}` : " · UTC";
  if (hrStr === "*")           return "Every hour";
  if (hrStr.startsWith("*/")) return `Every ${hrStr.slice(2)} hours`;
  const h24 = parseInt(hrStr);
  const mn  = parseInt(mnStr) || 0;
  if (isNaN(h24)) return cron;
  const { hour, ampm } = h24ToH12(h24);
  const timeStr = `${hour}:${String(mn).padStart(2, "0")} ${ampm}`;
  if (domStr !== "*")   return `${ordinal(parseInt(domStr))} of each month at ${timeStr}${tzSuffix}`;
  if (dowStr === "1-5") return `Weekdays (Mon–Fri) at ${timeStr}${tzSuffix}`;
  if (dowStr !== "*") {
    const days = dowStr.split(",").map(Number).sort().map(d => DAY_NAMES[d] ?? d).join(", ");
    return `${days} at ${timeStr}${tzSuffix}`;
  }
  return `Every day at ${timeStr}${tzSuffix}`;
}

// ── status chips ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-blue-950 text-blue-300 border border-blue-800">
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> running
      </span>
    );
  if (status === "success")
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-950 text-green-300 border border-green-800">
        <CheckCircle2 className="h-2.5 w-2.5" /> success
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-red-950 text-red-300 border border-red-800">
        <XCircle className="h-2.5 w-2.5" /> failed
      </span>
    );
  return <span className="text-muted-foreground text-xs">{status}</span>;
}

// ── log viewer ────────────────────────────────────────────────────────────────

function LogLine({ line }: { line: string }) {
  const isError = /error|failed|exception/i.test(line);
  const isWarn  = /warn/i.test(line);
  const isOk    = /\bOK\b|success|completed/i.test(line);
  return (
    <div className={cn(
      "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
      isError ? "text-red-400"    :
      isWarn  ? "text-amber-400"  :
      isOk    ? "text-green-400"  :
      "text-slate-400"
    )}>
      {line}
    </div>
  );
}

// ── schedule builder ──────────────────────────────────────────────────────────

type Freq = "hourly" | "every_n_hours" | "daily" | "weekdays" | "specific_days" | "monthly";

interface SchedState {
  freq:     Freq;
  everyN:   number;
  hour:     number;
  minute:   number;
  ampm:     "AM" | "PM";
  days:     number[];
  monthDay: number;
}

const SCHED_DEFAULT: SchedState = {
  freq: "daily", everyN: 2, hour: 9, minute: 0, ampm: "AM", days: [1], monthDay: 1,
};

function fromCron(cron: string): SchedState {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return { ...SCHED_DEFAULT };
  const [mnStr, hrStr, domStr, , dowStr] = p;
  if (hrStr === "*") return { ...SCHED_DEFAULT, freq: "hourly" };
  if (hrStr.startsWith("*/")) {
    const n = parseInt(hrStr.slice(2));
    return { ...SCHED_DEFAULT, freq: "every_n_hours", everyN: isNaN(n) ? 2 : n };
  }
  const h24   = parseInt(hrStr);
  const mnRaw = parseInt(mnStr) || 0;
  if (isNaN(h24)) return { ...SCHED_DEFAULT };
  const { hour, ampm } = h24ToH12(h24);
  const minute = [0, 15, 30, 45].includes(mnRaw) ? mnRaw : 0;
  const base   = { ...SCHED_DEFAULT, hour, minute, ampm };
  if (domStr !== "*") {
    const dom = parseInt(domStr);
    return { ...base, freq: "monthly", monthDay: isNaN(dom) ? 1 : Math.min(28, Math.max(1, dom)) };
  }
  if (dowStr === "1-5") return { ...base, freq: "weekdays", days: [1,2,3,4,5] };
  if (dowStr !== "*") {
    const ds = dowStr.split(",").map(Number).filter(d => !isNaN(d) && d >= 0 && d <= 6);
    return { ...base, freq: "specific_days", days: ds.length ? ds : [1] };
  }
  return { ...base, freq: "daily" };
}

function toCron(s: SchedState): string {
  const h24 = h12ToH24(s.hour, s.ampm);
  const mn  = String(s.minute).padStart(2, "0");
  switch (s.freq) {
    case "hourly":        return "0 * * * *";
    case "every_n_hours": return `0 */${s.everyN} * * *`;
    case "daily":         return `${mn} ${h24} * * *`;
    case "weekdays":      return `${mn} ${h24} * * 1-5`;
    case "specific_days": return `${mn} ${h24} * * ${[...s.days].sort().join(",")}`;
    case "monthly":       return `${mn} ${h24} ${s.monthDay} * *`;
  }
}

const FREQ_OPTIONS: { value: Freq; label: string }[] = [
  { value: "hourly",        label: "Every hour" },
  { value: "every_n_hours", label: "Every N hours" },
  { value: "daily",         label: "Daily" },
  { value: "weekdays",      label: "Weekdays" },
  { value: "specific_days", label: "Specific days" },
  { value: "monthly",       label: "Monthly" },
];

const HOUR_OPTS   = [1,2,3,4,5,6,7,8,9,10,11,12];
const MINUTE_OPTS = [0, 15, 30, 45];
const N_HOUR_OPTS = [2, 3, 4, 6, 8, 12];
const MONTH_DAYS  = Array.from({ length: 28 }, (_, i) => i + 1);

function ScheduleBuilder({ cron, timezone, onCronChange, onTimezoneChange }: {
  cron: string;
  timezone: string;
  onCronChange: (c: string) => void;
  onTimezoneChange: (tz: string) => void;
}) {
  const [s, setS] = useState<SchedState>(() => fromCron(cron));

  function update(patch: Partial<SchedState>) {
    const next = { ...s, ...patch };
    setS(next);
    onCronChange(toCron(next));
  }

  const showTime = s.freq !== "hourly" && s.freq !== "every_n_hours";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
      {/* Frequency chips */}
      <div className="space-y-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Runs</span>
        <div className="flex flex-wrap gap-1.5">
          {FREQ_OPTIONS.map(opt => (
            <button key={opt.value} type="button"
              onClick={() => update({ freq: opt.value })}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                s.freq === opt.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Every N hours */}
      {s.freq === "every_n_hours" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Every</span>
          <Select value={String(s.everyN)} onValueChange={v => update({ everyN: parseInt(v) })}>
            <SelectTrigger className="w-20 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {N_HOUR_OPTS.map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">hours</span>
        </div>
      )}

      {/* Day-of-week picker */}
      {s.freq === "specific_days" && (
        <div className="space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">On</span>
          <div className="flex gap-1.5">
            {DAY_NAMES.map((d, i) => (
              <button key={d} type="button"
                onClick={() => {
                  const next = s.days.includes(i) ? s.days.filter(x => x !== i) : [...s.days, i];
                  if (next.length) update({ days: next });
                }}
                className={cn(
                  "w-10 h-9 rounded-md text-xs font-medium border transition-colors",
                  s.days.includes(i)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Month-day picker */}
      {s.freq === "monthly" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">On the</span>
          <Select value={String(s.monthDay)} onValueChange={v => update({ monthDay: parseInt(v) })}>
            <SelectTrigger className="w-24 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTH_DAYS.map(d => <SelectItem key={d} value={String(d)}>{ordinal(d)}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">of each month</span>
        </div>
      )}

      {/* Time picker */}
      {showTime && (
        <div className="space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">At</span>
          <div className="flex items-center gap-2">
            <Select value={String(s.hour)} onValueChange={v => update({ hour: parseInt(v) })}>
              <SelectTrigger className="w-[68px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HOUR_OPTS.map(h => <SelectItem key={h} value={String(h)}>{h}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-xl font-light text-muted-foreground leading-none">:</span>
            <Select value={String(s.minute)} onValueChange={v => update({ minute: parseInt(v) })}>
              <SelectTrigger className="w-[68px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MINUTE_OPTS.map(m => (
                  <SelectItem key={m} value={String(m)}>{String(m).padStart(2, "0")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(["AM","PM"] as const).map(ap => (
                <button key={ap} type="button"
                  onClick={() => update({ ampm: ap })}
                  className={cn(
                    "px-3 h-9 text-xs font-semibold transition-colors",
                    s.ampm === ap
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  {ap}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Timezone */}
      {showTime && (
        <div className="space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Time zone</span>
          <Select value={timezone} onValueChange={onTimezoneChange}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIMEZONES.map(tz => (
                <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Human-readable summary */}
      <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium">{describeSchedule(toCron(s), timezone)}</span>
      </div>
    </div>
  );
}

// ── model combobox ────────────────────────────────────────────────────────────

interface ModelEntry { name: string; type: "model" | "snapshot" }

function ModelCombobox({ projectId, value, onChange }: {
  projectId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [models,  setModels]  = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);
  const [query,   setQuery]   = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);

  // Load models whenever the project changes
  useEffect(() => {
    if (!projectId) { setModels([]); return; }
    setLoading(true);
    api.dsListModels(projectId)
      .then(r => setModels(r.models))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const displayValue = value || "All models";
  const filtered = models.filter(m =>
    !query || m.name.toLowerCase().includes(query.toLowerCase())
  );

  function select(name: string) {
    onChange(name === "__all__" ? "" : name);
    setOpen(false);
    setQuery("");
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
    setQuery(e.target.value);
    setOpen(true);
  }

  function handleFocus() {
    setQuery(value);
    setOpen(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-8 pr-8",
            "text-sm shadow-sm transition-colors placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          placeholder={loading ? "Loading models…" : "All models — or search / type a selector"}
          value={open ? query : displayValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(""); setQuery(""); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden">
          <div className="max-h-56 overflow-y-auto">
            {/* All models option */}
            <button
              type="button"
              className={cn(
                "w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-accent",
                !value && "bg-primary/10 text-primary"
              )}
              onClick={() => select("__all__")}
            >
              <span className="text-muted-foreground">—</span>
              <span>All models</span>
            </button>

            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}

            {!loading && filtered.length === 0 && query && (
              /* Free-form selector option */
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                onClick={() => select(query)}
              >
                <span className="text-muted-foreground text-xs">use as selector</span>
                <span className="font-mono text-xs">{query}</span>
              </button>
            )}

            {!loading && filtered.map(m => (
              <button
                key={m.name}
                type="button"
                className={cn(
                  "w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-accent",
                  value === m.name && "bg-primary/10 text-primary"
                )}
                onClick={() => select(m.name)}
              >
                <span className="font-mono text-xs truncate">{m.name}</span>
                <span className={cn(
                  "shrink-0 text-[10px] rounded px-1.5 py-0.5 border",
                  m.type === "snapshot"
                    ? "text-purple-400 border-purple-800 bg-purple-950/40"
                    : "text-blue-400 border-blue-800 bg-blue-950/40"
                )}>
                  {m.type}
                </span>
              </button>
            ))}
          </div>

          {/* Hint for power users */}
          {!query && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              Type <span className="font-mono">customers+</span> or <span className="font-mono">tag:daily</span> for dbt selectors
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── new schedule modal ────────────────────────────────────────────────────────

interface ScheduleFormProps {
  projects: DbtProject[];
  initial?: OrchestratorSchedule | null;
  onSave: (payload: Partial<OrchestratorSchedule>) => Promise<void>;
  onClose: () => void;
}

function ScheduleModal({ projects, initial, onSave, onClose }: ScheduleFormProps) {
  const [name,      setName]      = useState(initial?.name      ?? "");
  const [projectId, setProjectId] = useState(initial?.project_id ?? (projects[0]?.id ?? ""));
  const [command,   setCommand]   = useState(initial?.command   ?? "run");
  const [select,    setSelect]    = useState(initial?.select    ?? "");
  const [cron,      setCron]      = useState(initial?.cron      ?? "0 9 * * *");
  const [timezone,  setTz]        = useState(initial?.timezone  ?? "UTC");
  const [saving,    setSaving]    = useState(false);

  function handleProjectChange(id: string) {
    setProjectId(id);
    setSelect(""); // reset model when project changes
  }

  async function handleSubmit() {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!projectId)   { toast.error("Select a project"); return; }
    if (!cron.trim()) { toast.error("Schedule is required"); return; }
    setSaving(true);
    try {
      await onSave({ name, project_id: projectId, command, select: select || undefined, cron, timezone, enabled: true });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg bg-card border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            {initial ? "Edit Schedule" : "New Schedule"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Schedule name</Label>
            <Input placeholder="Daily customer refresh" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={handleProjectChange}>
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Command</Label>
              <Select value={command} onValueChange={setCommand}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="run">dbt run</SelectItem>
                  <SelectItem value="build">dbt build</SelectItem>
                  <SelectItem value="test">dbt test</SelectItem>
                  <SelectItem value="snapshot">dbt snapshot</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>
              Model
              <span className="ml-1 text-[10px] text-muted-foreground">(optional — leave blank to run all)</span>
            </Label>
            <ModelCombobox projectId={projectId} value={select} onChange={setSelect} />
          </div>
          <div className="space-y-1.5">
            <Label>Schedule</Label>
            <ScheduleBuilder
              cron={cron} timezone={timezone}
              onCronChange={setCron} onTimezoneChange={setTz}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {initial ? "Save Changes" : "Create Schedule"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 flex items-start gap-4">
      <div className={cn("mt-0.5 rounded-lg p-2", color ?? "bg-primary/10 text-primary")}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground/60 mt-0.5 truncate max-w-[140px]">{sub}</p>}
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

type Tab = "overview" | "schedules" | "history";

export default function OrchestrationPage() {
  const [tab,       setTab]       = useState<Tab>("overview");
  const [schedules, setSchedules] = useState<OrchestratorSchedule[]>([]);
  const [runs,      setRuns]      = useState<OrchestratorRun[]>([]);
  const [stats,     setStats]     = useState<OrchestratorStats | null>(null);
  const [projects,  setProjects]  = useState<DbtProject[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing,   setEditing]   = useState<OrchestratorSchedule | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<string>("all");
  const [delConfirm, setDelConfirm] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, r, st, p] = await Promise.all([
        api.orchListSchedules(),
        api.orchListRuns(100),
        api.orchStats(),
        api.dsListProjects().then(r => r.projects),
      ]);
      setSchedules(s);
      setRuns(r);
      setStats(st);
      setProjects(p);
    } catch {
      // silently retry
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Poll faster while any run is active
  useEffect(() => {
    const hasActive = runs.some(r => r.status === "running");
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadAll, hasActive ? 3000 : 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [runs, loadAll]);

  async function handleToggle(id: string) {
    try {
      const updated = await api.orchToggleSchedule(id);
      setSchedules(s => s.map(x => x.id === id ? updated : x));
      toast.success(updated.enabled ? "Schedule enabled" : "Schedule paused");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function handleTrigger(id: string) {
    try {
      await api.orchTriggerSchedule(id);
      toast.success("Run triggered — check Run History");
      setTimeout(loadAll, 1500);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function handleDelete(id: string) {
    try {
      await api.orchDeleteSchedule(id);
      setSchedules(s => s.filter(x => x.id !== id));
      toast.success("Schedule deleted");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    setDelConfirm(null);
  }

  async function handleSave(payload: Partial<OrchestratorSchedule>) {
    if (editing) {
      const updated = await api.orchUpdateSchedule(editing.id, payload);
      setSchedules(s => s.map(x => x.id === editing.id ? updated : x));
      toast.success("Schedule updated");
    } else {
      const created = await api.orchCreateSchedule(payload as Parameters<typeof api.orchCreateSchedule>[0]);
      setSchedules(s => [...s, created]);
      toast.success("Schedule created");
    }
    setEditing(null);
    setShowModal(false);
    await loadAll();
  }

  const filteredRuns = runs.filter(r => runFilter === "all" || r.status === runFilter);

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* Top bar */}
      <div className="shrink-0 flex items-center justify-between px-6 py-3.5 border-b border-border bg-card">
        <div className="flex items-center gap-2.5">
          <Clock className="h-4.5 w-4.5 text-primary" />
          <h1 className="text-base font-semibold">Orchestration</h1>
          {!stats?.scheduler_ok && (
            <span className="flex items-center gap-1 text-[11px] text-amber-400 border border-amber-800 bg-amber-950/40 rounded px-2 py-0.5">
              <AlertTriangle className="h-3 w-3" /> apscheduler not installed — schedules will not fire
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={loadAll}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={() => { setEditing(null); setShowModal(true); }}>
            <Plus className="h-4 w-4 mr-1" /> New Schedule
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-5 max-w-7xl mx-auto">

          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={Activity}
              label="Runs today"
              value={stats?.runs_today ?? "—"}
              sub={stats ? `${stats.runs_today_ok} ok · ${stats.runs_today_fail} failed` : undefined}
              color="bg-blue-950/60 text-blue-400"
            />
            <StatCard
              icon={CheckCircle2}
              label="Success rate (last 100)"
              value={stats?.success_rate != null ? `${stats.success_rate}%` : "—"}
              color={
                stats?.success_rate == null ? "bg-muted text-muted-foreground" :
                stats.success_rate >= 90 ? "bg-green-950/60 text-green-400" :
                stats.success_rate >= 70 ? "bg-amber-950/60 text-amber-400" :
                "bg-red-950/60 text-red-400"
              }
            />
            <StatCard
              icon={Calendar}
              label="Active schedules"
              value={`${stats?.active_schedules ?? "—"} / ${stats?.total_schedules ?? "—"}`}
              color="bg-purple-950/60 text-purple-400"
            />
            <StatCard
              icon={Timer}
              label="Next run"
              value={stats?.next_run_at ? timeUntil(stats.next_run_at) : "—"}
              sub={stats?.next_run_name}
              color="bg-amber-950/60 text-amber-400"
            />
          </div>

          {/* Tabs */}
          <div className="flex gap-0 border-b border-border">
            {(["overview","schedules","history"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors -mb-px",
                  tab === t
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "history" ? "Run History" : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* ── Overview ─────────────────────────────────────────────────── */}
          {tab === "overview" && (
            <div className="grid lg:grid-cols-2 gap-5">

              {/* Upcoming runs */}
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <Timer className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">Upcoming runs</span>
                </div>
                {schedules.filter(s => s.enabled && s.next_run_at).length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                    No active schedules — create one to get started
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {schedules
                      .filter(s => s.enabled && s.next_run_at)
                      .sort((a,b) => (a.next_run_at! > b.next_run_at! ? 1 : -1))
                      .slice(0,8)
                      .map(s => (
                        <div key={s.id} className="flex items-center justify-between px-4 py-3 hover:bg-accent/30 group">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{s.name}</p>
                            <p className="text-xs text-muted-foreground">
                              dbt {s.command}{s.select ? ` · ${s.select}` : ""} · {describeSchedule(s.cron, s.timezone)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-3">
                            <span className="text-xs font-mono text-amber-400">{timeUntil(s.next_run_at)}</span>
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0"
                              onClick={() => handleTrigger(s.id)} title="Run now">
                              <Zap className="h-3 w-3 text-amber-400" />
                            </Button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Recent activity */}
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">Recent activity</span>
                </div>
                {runs.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground text-center">No runs yet</p>
                ) : (
                  <div className="divide-y divide-border">
                    {runs.slice(0,10).map(r => (
                      <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                        {r.status === "running"  && <Loader2 className="h-3.5 w-3.5 shrink-0 text-blue-400 animate-spin" />}
                        {r.status === "success"  && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-400" />}
                        {r.status === "failed"   && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate">{r.schedule_name}</p>
                          <p className="text-xs text-muted-foreground">
                            dbt {r.command}{r.select ? ` · ${r.select}` : ""}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs text-muted-foreground">{timeAgo(r.started_at)}</p>
                          <p className="text-xs text-muted-foreground">{fmtDuration(r.duration_s)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Schedules ────────────────────────────────────────────────── */}
          {tab === "schedules" && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              {loading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : schedules.length === 0 ? (
                <div className="flex flex-col items-center py-16 text-muted-foreground gap-3">
                  <Clock className="h-10 w-10 opacity-20" />
                  <p className="text-sm">No schedules yet</p>
                  <Button size="sm" onClick={() => { setEditing(null); setShowModal(true); }}>
                    <Plus className="h-4 w-4 mr-1" /> Create first schedule
                  </Button>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left px-4 py-3 font-medium">Name</th>
                      <th className="text-left px-4 py-3 font-medium">Command</th>
                      <th className="text-left px-4 py-3 font-medium">Schedule</th>
                      <th className="text-left px-4 py-3 font-medium">Last run</th>
                      <th className="text-left px-4 py-3 font-medium">Next run</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {schedules.map(s => {
                      const proj = projects.find(p => p.id === s.project_id);
                      return (
                        <tr key={s.id} className="hover:bg-accent/20 group">
                          <td className="px-4 py-3">
                            <p className="font-medium">{s.name}</p>
                            {proj && <p className="text-xs text-muted-foreground">{proj.name}</p>}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            dbt {s.command}{s.select ? <><br /><span className="text-foreground">{s.select}</span></> : ""}
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-xs">{describeSchedule(s.cron, s.timezone)}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-xs">{timeAgo(s.last_run_at)}</p>
                            {s.last_run_status && <StatusBadge status={s.last_run_status} />}
                          </td>
                          <td className="px-4 py-3 text-xs font-mono">
                            {s.enabled ? (
                              <span className="text-amber-400">{timeUntil(s.next_run_at)}</span>
                            ) : (
                              <span className="text-muted-foreground">paused</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center">
                              <button
                                onClick={() => handleToggle(s.id)}
                                className={cn(
                                  "relative inline-flex w-10 h-6 shrink-0 rounded-full transition-colors",
                                  s.enabled ? "bg-primary" : "bg-muted-foreground/30"
                                )}
                              >
                                <span className={cn(
                                  "absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform",
                                  s.enabled ? "translate-x-5" : "translate-x-1"
                                )} />
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                                onClick={() => handleTrigger(s.id)} title="Run now">
                                <Play className="h-3.5 w-3.5 text-green-400" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                                onClick={() => { setEditing(s); setShowModal(true); }} title="Edit">
                                <Pencil className="h-3.5 w-3.5 text-blue-400" />
                              </Button>
                              {delConfirm === s.id ? (
                                <div className="flex gap-1">
                                  <Button size="sm" variant="destructive" className="h-7 px-2 text-xs"
                                    onClick={() => handleDelete(s.id)}>Delete?</Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                                    onClick={() => setDelConfirm(null)}>Cancel</Button>
                                </div>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                                  onClick={() => setDelConfirm(s.id)} title="Delete">
                                  <Trash2 className="h-3.5 w-3.5 text-red-400" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Run History ──────────────────────────────────────────────── */}
          {tab === "history" && (
            <div className="space-y-3">
              {/* Filter row */}
              <div className="flex items-center gap-2">
                {(["all","success","failed","running"] as const).map(f => (
                  <button key={f} onClick={() => setRunFilter(f)}
                    className={cn(
                      "px-3 py-1 rounded text-xs font-medium border transition-colors capitalize",
                      runFilter === f
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:bg-accent"
                    )}>
                    {f}
                    {f === "all" ? ` (${runs.length})` :
                     f === "running" ? ` (${runs.filter(r=>r.status==="running").length})` :
                     f === "success" ? ` (${runs.filter(r=>r.status==="success").length})` :
                     ` (${runs.filter(r=>r.status==="failed").length})`}
                  </button>
                ))}
                <span className="ml-auto text-xs text-muted-foreground">Last 1,000 runs stored</span>
              </div>

              {/* Run list */}
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                {filteredRuns.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-12">No runs match this filter</p>
                ) : (
                  <div className="divide-y divide-border">
                    {filteredRuns.map(r => (
                      <div key={r.id}>
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent/20"
                          onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}
                        >
                          {r.status === "running" && <Loader2 className="h-4 w-4 shrink-0 text-blue-400 animate-spin" />}
                          {r.status === "success" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />}
                          {r.status === "failed"  && <XCircle className="h-4 w-4 shrink-0 text-red-400" />}

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm">{r.schedule_name}</span>
                              <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
                                dbt {r.command}
                              </Badge>
                              {r.select && (
                                <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
                                  {r.select}
                                </Badge>
                              )}
                              {r.triggered_by === "manual" && (
                                <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-amber-400 border-amber-800">
                                  manual
                                </Badge>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
                            <span>{timeAgo(r.started_at)}</span>
                            <span className="font-mono">{fmtDuration(r.duration_s)}</span>
                            <StatusBadge status={r.status} />
                            {expandedRun === r.id
                              ? <ChevronDown className="h-3.5 w-3.5" />
                              : <ChevronRight className="h-3.5 w-3.5" />}
                          </div>
                        </div>

                        {expandedRun === r.id && (
                          <div className="border-t border-border bg-[#060a12] px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[11px] text-muted-foreground">
                                Started {new Date(r.started_at).toLocaleString()}
                                {r.finished_at && ` · Finished ${new Date(r.finished_at).toLocaleString()}`}
                                {r.return_code != null && ` · Exit code ${r.return_code}`}
                              </span>
                            </div>
                            <ScrollArea className="h-64 rounded border border-border/40">
                              <div className="p-3 space-y-0.5">
                                {r.log ? (
                                  r.log.split("\n").map((line, i) => (
                                    <LogLine key={i} line={line} />
                                  ))
                                ) : (
                                  <p className="text-xs text-muted-foreground italic">
                                    {r.status === "running" ? "Run in progress…" : "No log output"}
                                  </p>
                                )}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* New / Edit Schedule modal */}
      {showModal && (
        <ScheduleModal
          projects={projects}
          initial={editing}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditing(null); }}
        />
      )}
    </div>
  );
}
