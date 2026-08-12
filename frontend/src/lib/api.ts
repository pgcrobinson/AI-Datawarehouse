import type {
  OrchestratorSchedule,
  OrchestratorRun,
  OrchestratorStats,
  Connection,
  ConnectionConfig,
  QueryResult,
  SchemaData,
  ColumnInfo,
  AISettings,
  AISettingsResponse,
  DesignRequest,
  DesignResponse,
  Organisation,
  AdminUser,
  Project,
  SavedDesign,
  FullDesign,
  SaveDesignPayload,
  DesignVersion,
  LogEntry,
  DesignTransform,
  TransformPayload,
  TransformGeneratePayload,
  GitConfig,
  GitStatus,
  GitPR,
  GitHubUser,
  GitHubRepo,
  DbtProject,
} from "./types";

const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("dwb_token");
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string> ?? {}),
    },
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      localStorage.removeItem("dwb_token");
      window.location.href = "/login";
    }
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Request failed");
  }
  return res.json();
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  // ── Connections ──────────────────────────────────────────────────────────────
  testConnection: (config: Omit<ConnectionConfig, "name">) =>
    request<{ success: boolean; message: string }>("/database/test", {
      method: "POST",
      body: JSON.stringify(config),
    }),

  createConnection: (config: ConnectionConfig) =>
    request<Connection>("/database/connections", {
      method: "POST",
      body: JSON.stringify(config),
    }),

  listConnections: () => request<Connection[]>("/database/connections"),

  deleteConnection: (id: string) =>
    request<{ success: boolean }>(`/database/connections/${id}`, { method: "DELETE" }),

  testSavedConnection: (id: string) =>
    request<{ success: boolean; message: string }>(
      `/database/connections/${id}/test`, { method: "POST" }
    ),

  activateConnection: (id: string) =>
    request<{ success: boolean; active_connection_id: string }>(
      `/database/connections/${id}/activate`, { method: "POST" }
    ),

  // ── Query ────────────────────────────────────────────────────────────────────
  executeQuery: (sql: string, connectionId?: string, defaultSchema?: string) =>
    request<QueryResult>("/query/execute", {
      method: "POST",
      body: JSON.stringify({ sql, connection_id: connectionId, default_schema: defaultSchema || null }),
    }),

  getSchema: (connectionId?: string) => {
    const qs = connectionId ? `?connection_id=${connectionId}` : "";
    return request<SchemaData>(`/query/schema${qs}`);
  },

  getColumns: (schema: string, table: string, connectionId?: string) => {
    const qs = connectionId ? `?connection_id=${connectionId}` : "";
    return request<{ columns: ColumnInfo[] }>(`/query/schema/${schema}/${table}/columns${qs}`);
  },

  // ── Design ───────────────────────────────────────────────────────────────────
  generateDesign: (payload: DesignRequest) =>
    request<DesignResponse>("/design/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // ── AI Settings ──────────────────────────────────────────────────────────────
  getAISettings: () => request<AISettingsResponse>("/settings"),

  saveAISettings: (settings: AISettings) =>
    request<AISettingsResponse>("/settings", {
      method: "POST",
      body: JSON.stringify(settings),
    }),

  // ── Admin: Organisations ─────────────────────────────────────────────────────
  listOrgs: () => request<Organisation[]>("/admin/organisations"),

  createOrg: (name: string) =>
    request<Organisation>("/admin/organisations", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  deleteOrg: (id: string) =>
    request<{ success: boolean }>(`/admin/organisations/${id}`, { method: "DELETE" }),

  // ── Admin: Users ─────────────────────────────────────────────────────────────
  listUsers: () => request<AdminUser[]>("/admin/users"),

  createUser: (payload: { email: string; name: string; password: string; role: string; org_id?: string }) =>
    request<AdminUser>("/admin/users", { method: "POST", body: JSON.stringify(payload) }),

  deleteUser: (id: string) =>
    request<{ success: boolean }>(`/admin/users/${id}`, { method: "DELETE" }),

  // ── Admin: Logs ──────────────────────────────────────────────────────────────
  listLogs: (params: {
    level?: string; category?: string; user_email?: string;
    search?: string; date_from?: string; date_to?: string; page?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.level)      qs.set("level",      params.level);
    if (params.category)   qs.set("category",   params.category);
    if (params.user_email) qs.set("user_email", params.user_email);
    if (params.search)     qs.set("search",     params.search);
    if (params.date_from)  qs.set("date_from",  params.date_from);
    if (params.date_to)    qs.set("date_to",    params.date_to);
    if (params.page)       qs.set("page",       String(params.page));
    return request<{
      total: number; page: number; page_size: number;
      entries: LogEntry[];
    }>(`/logs?${qs.toString()}`);
  },

  clearLogs: () => request<{ deleted: number }>("/logs", { method: "DELETE" }),

  exportLogsUrl: (level?: string, category?: string) => {
    const qs = new URLSearchParams();
    if (level)    qs.set("level",    level);
    if (category) qs.set("category", category);
    return `${BASE}/logs/export?${qs.toString()}`;
  },

  logStats: () => request<{
    total: number;
    by_level: { info: number; warn: number; error: number };
    by_category: Record<string, number>;
  }>("/logs/stats"),

  // ── Projects ─────────────────────────────────────────────────────────────────
  listProjects: () => request<Project[]>("/projects"),

  createProject: (name: string, description?: string) =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),

  deleteProject: (id: string) =>
    request<{ success: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  listDesigns: (projectId: string) =>
    request<SavedDesign[]>(`/projects/${projectId}/designs`),

  getDesign: (projectId: string, designId: string) =>
    request<FullDesign>(`/projects/${projectId}/designs/${designId}`),

  saveDesign: (projectId: string, payload: SaveDesignPayload) =>
    request<{ id: string; name: string }>(`/projects/${projectId}/designs`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteDesign: (projectId: string, designId: string) =>
    request<{ success: boolean }>(`/projects/${projectId}/designs/${designId}`, {
      method: "DELETE",
    }),

  renameDesign: (projectId: string, designId: string, name: string) =>
    request<{ success: boolean; name: string }>(
      `/projects/${projectId}/designs/${designId}/name`,
      { method: "PATCH", body: JSON.stringify({ name }) }
    ),

  updateDesignSQL: (projectId: string, designId: string, sql_ddl: string) =>
    request<{ success: boolean; updated_at: string }>(
      `/projects/${projectId}/designs/${designId}/sql`,
      { method: "PATCH", body: JSON.stringify({ sql_ddl }) }
    ),

  listVersions: (projectId: string, designId: string) =>
    request<DesignVersion[]>(`/projects/${projectId}/designs/${designId}/versions`),

  getVersion: (projectId: string, designId: string, versionId: string) =>
    request<DesignVersion>(`/projects/${projectId}/designs/${designId}/versions/${versionId}`),

  updateEtlSQL: (projectId: string, designId: string, etl_sql: string) =>
    request<{ success: boolean; updated_at: string }>(
      `/projects/${projectId}/designs/${designId}/etl`,
      { method: "PATCH", body: JSON.stringify({ etl_sql }) }
    ),

  listEtlVersions: (projectId: string, designId: string) =>
    request<DesignVersion[]>(`/projects/${projectId}/designs/${designId}/etl-versions`),

  getEtlVersion: (projectId: string, designId: string, versionId: string) =>
    request<DesignVersion>(`/projects/${projectId}/designs/${designId}/etl-versions/${versionId}`),

  generateEtlSQL: (projectId: string, designId: string, tableFilters?: Record<string, string>) =>
    request<{ etl_sql: string }>(
      `/projects/${projectId}/designs/${designId}/generate-etl`,
      { method: "POST", body: JSON.stringify({ table_filters: tableFilters ?? {} }) }
    ),

  regenerateDDL: (projectId: string, designId: string) =>
    request<{ sql_ddl: string }>(
      `/projects/${projectId}/designs/${designId}/regenerate-ddl`,
      { method: "POST" }
    ),

  // ── Transforms ───────────────────────────────────────────────────────────────
  listTransforms: (projectId: string, designId: string) =>
    request<DesignTransform[]>(`/projects/${projectId}/designs/${designId}/transforms`),

  createTransform: (projectId: string, designId: string, payload: TransformPayload) =>
    request<{ id: string; name: string; order_index: number }>(
      `/projects/${projectId}/designs/${designId}/transforms`,
      { method: "POST", body: JSON.stringify(payload) }
    ),

  updateTransform: (projectId: string, designId: string, transformId: string, payload: Partial<TransformPayload>) =>
    request<{ success: boolean }>(
      `/projects/${projectId}/designs/${designId}/transforms/${transformId}`,
      { method: "PATCH", body: JSON.stringify(payload) }
    ),

  deleteTransform: (projectId: string, designId: string, transformId: string) =>
    request<{ success: boolean }>(
      `/projects/${projectId}/designs/${designId}/transforms/${transformId}`,
      { method: "DELETE" }
    ),

  generateTransform: (projectId: string, designId: string, payload: TransformGeneratePayload) =>
    request<{ output_sql?: string; config_json?: string }>(
      `/projects/${projectId}/designs/${designId}/transforms/generate`,
      { method: "POST", body: JSON.stringify(payload) }
    ),

  generateTargetTableDdl: (projectId: string, designId: string, transformId: string) =>
    request<{ ddl: string }>(
      `/projects/${projectId}/designs/${designId}/transforms/${transformId}/generate-target-ddl`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  createTargetTable: (projectId: string, designId: string, transformId: string,
                      payload: { target_connection_id: string; ddl: string }) =>
    request<{ success: boolean; message: string }>(
      `/projects/${projectId}/designs/${designId}/transforms/${transformId}/create-target-table`,
      { method: "POST", body: JSON.stringify(payload) }
    ),

  refreshErd: (projectId: string, designId: string, connectionId: string) =>
    request<{ mermaid_erd: string }>(
      `/projects/${projectId}/designs/${designId}/refresh-erd`,
      { method: "POST", body: JSON.stringify({ connection_id: connectionId }) }
    ),

  createSchema: (projectId: string, designId: string, connectionId: string, schemaName: string) =>
    request<{ success: boolean; schema: string }>(
      `/projects/${projectId}/designs/${designId}/create-schema`,
      { method: "POST", body: JSON.stringify({ connection_id: connectionId, schema_name: schemaName }) }
    ),

  debugSql: (projectId: string, designId: string, buildErrors: string[], sqlType: "ddl" | "etl" | "both" = "both") =>
    request<{ diagnosis: string; fixed_ddl: string | null; fixed_etl: string | null }>(
      `/projects/${projectId}/designs/${designId}/debug-sql`,
      { method: "POST", body: JSON.stringify({ build_errors: buildErrors, sql_type: sqlType }) }
    ),

  // ── Git / Source Control ────────────────────────────────────────────────────
  gitGetConfig: (projectId: string) =>
    request<GitConfig>(`/git/${projectId}/config`),

  gitSetConfig: (projectId: string, remoteUrl: string, pat: string) =>
    request<{ ok: boolean }>(`/git/${projectId}/config`, {
      method: "POST",
      body: JSON.stringify({ remote_url: remoteUrl, pat }),
    }),

  gitGetStatus: (projectId: string) =>
    request<GitStatus>(`/git/${projectId}/status`),

  gitInit: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/init`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitClone: (projectId: string, remoteUrl: string, pat: string, branch = "main") =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/clone`, {
      method: "POST",
      body: JSON.stringify({ remote_url: remoteUrl, pat, branch }),
    }),

  gitStage: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${projectId}/stage`, {
      method: "POST", body: JSON.stringify({ paths }),
    }),

  gitUnstage: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${projectId}/unstage`, {
      method: "POST", body: JSON.stringify({ paths }),
    }),

  gitStageAll: (projectId: string) =>
    request<{ ok: boolean }>(`/git/${projectId}/stage-all`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitCommit: (projectId: string, message: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/commit`, {
      method: "POST", body: JSON.stringify({ message }),
    }),

  gitPush: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/push`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitPull: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/pull`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitBranches: (projectId: string) =>
    request<{ branches: string[]; current: string }>(`/git/${projectId}/branches`),

  gitBranch: (projectId: string, name: string, create: boolean) =>
    request<{ ok: boolean; branch: string }>(`/git/${projectId}/branch`, {
      method: "POST", body: JSON.stringify({ name, create }),
    }),

  gitDeleteBranch: (projectId: string, name: string) =>
    request<{ ok: boolean }>(`/git/${projectId}/branch/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  gitDiff: (projectId: string, path: string, staged = false) =>
    request<{ diff: string }>(`/git/${projectId}/diff?path=${encodeURIComponent(path)}&staged=${staged}`),

  gitCreatePR: (projectId: string, title: string, body: string, head: string, base: string) =>
    request<{ ok: boolean; pr_url: string; pr_number: number }>(`/git/${projectId}/pr`, {
      method: "POST", body: JSON.stringify({ title, body, head, base }),
    }),

  gitListPRs: (projectId: string) =>
    request<{ prs: GitPR[] }>(`/git/${projectId}/prs`),

  gitGitHubUser: (projectId: string) =>
    request<GitHubUser>(`/git/${projectId}/github-user`),

  gitGitHubRepos: (projectId: string) =>
    request<{ repos: GitHubRepo[] }>(`/git/${projectId}/github-repos`),

  gitScrubHistory: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/scrub-history`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitCreateRepo: (projectId: string, name: string, description: string, isPrivate: boolean) =>
    request<{ ok: boolean; name: string; full_name: string; html_url: string; clone_url: string; private: boolean; default_branch: string }>(
      `/git/${projectId}/create-repo`,
      { method: "POST", body: JSON.stringify({ name, description, private: isPrivate, auto_init: false }) },
    ),

  gitStash: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/stash`, {
      method: "POST", body: JSON.stringify({}),
    }),

  gitStashPop: (projectId: string) =>
    request<{ ok: boolean; message: string }>(`/git/${projectId}/stash-pop`, {
      method: "POST", body: JSON.stringify({}),
    }),

  // ── Data Studio (dbt) ───────────────────────────────────────────────────────
  dsListProjects: () =>
    request<{ projects: DbtProject[]; dbt_installed: boolean }>("/datastudio/projects"),

  dsCreateProject: (projectName: string, connectionId: string, defaultSchema: string) =>
    request<{ id: string; name: string; slug: string }>("/datastudio/projects", {
      method: "POST",
      body: JSON.stringify({ project_name: projectName, connection_id: connectionId, default_schema: defaultSchema }),
    }),

  dsDeleteProject: (id: string) =>
    request<{ ok: boolean }>(`/datastudio/projects/${id}`, { method: "DELETE" }),

  dsListModels: (projectId: string) =>
    request<{ models: { name: string; type: "model" | "snapshot" }[] }>(
      `/datastudio/models?project_id=${encodeURIComponent(projectId)}`
    ),

  dsGetModel: (name: string, type: "model" | "snapshot" | undefined, projectId: string) =>
    request<{ name: string; sql: string; config?: Record<string, unknown> }>(
      `/datastudio/models/${encodeURIComponent(name)}?project_id=${encodeURIComponent(projectId)}${type ? `&type=${type}` : ""}`
    ),

  dsSaveModel: (name: string, sql: string, config: Record<string, unknown> | null | undefined, projectId: string) =>
    request<{ success: boolean; name: string }>(
      `/datastudio/models/${encodeURIComponent(name)}?project_id=${encodeURIComponent(projectId)}`,
      { method: "PUT", body: JSON.stringify({ sql, config: config ?? null }) }
    ),

  dsDeleteModel: (name: string, type: "model" | "snapshot" | undefined, projectId: string) =>
    request<{ success: boolean }>(
      `/datastudio/models/${encodeURIComponent(name)}?project_id=${encodeURIComponent(projectId)}${type ? `&type=${type}` : ""}`,
      { method: "DELETE" }
    ),

  dsGetLineage: (projectId: string) =>
    request<{
      nodes: { id: string; name: string; type: "model" | "snapshot" | "source"; sql: string | null }[];
      edges: { source: string; target: string }[];
    }>(`/datastudio/lineage?project_id=${encodeURIComponent(projectId)}`),

  dsGetSchema: (projectId: string) =>
    request<{ version: number; models: Record<string, unknown>[] }>(
      `/datastudio/schema?project_id=${encodeURIComponent(projectId)}`
    ),

  dsSaveSchema: (payload: { version: number; models: unknown[] }, projectId: string) =>
    request<{ success: boolean }>(`/datastudio/schema?project_id=${encodeURIComponent(projectId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  // ── Orchestration ────────────────────────────────────────────────────────────
  orchStats: () =>
    request<OrchestratorStats>("/orchestration/stats"),

  orchListSchedules: () =>
    request<OrchestratorSchedule[]>("/orchestration/schedules"),

  orchCreateSchedule: (payload: { name: string; project_id: string; command: string; select?: string; cron: string; timezone?: string; enabled: boolean }) =>
    request<OrchestratorSchedule>("/orchestration/schedules", { method: "POST", body: JSON.stringify(payload) }),

  orchUpdateSchedule: (id: string, payload: Partial<{ name: string; command: string; select: string; cron: string; timezone: string; enabled: boolean }>) =>
    request<OrchestratorSchedule>(`/orchestration/schedules/${id}`, { method: "PUT", body: JSON.stringify(payload) }),

  orchDeleteSchedule: (id: string) =>
    request<{ ok: boolean }>(`/orchestration/schedules/${id}`, { method: "DELETE" }),

  orchToggleSchedule: (id: string) =>
    request<OrchestratorSchedule>(`/orchestration/schedules/${id}/toggle`, { method: "POST" }),

  orchTriggerSchedule: (id: string) =>
    request<{ ok: boolean; message: string }>(`/orchestration/schedules/${id}/trigger`, { method: "POST" }),

  orchListRuns: (limit = 100, status?: string, scheduleId?: string) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (status) qs.set("status", status);
    if (scheduleId) qs.set("schedule_id", scheduleId);
    return request<OrchestratorRun[]>(`/orchestration/runs?${qs}`);
  },

  orchGetRun: (id: string) =>
    request<OrchestratorRun>(`/orchestration/runs/${id}`),

  dsRunCommand: (command: string, connectionId?: string, select?: string, signal?: AbortSignal, projectId?: string, sourceConnectionId?: string) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("dwb_token") : null;
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return fetch(`${BASE}/datastudio/command${qs}`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        command,
        connection_id: connectionId ?? null,
        select: select ?? null,
        write_connection_id: sourceConnectionId ?? null,
      }),
    });
  },
};
