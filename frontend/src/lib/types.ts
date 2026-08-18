export type DbType = "azure_sql" | "bigquery" | "snowflake" | "databricks";
export type AuthType = "sql_server" | "windows";

export interface Connection {
  id: string;
  name: string;
  db_type: DbType;
  // Azure SQL
  server?: string;
  database?: string;
  auth_type: AuthType;
  username?: string;
  port: number;
  // Snowflake
  warehouse?: string;
  schema_name?: string;
  // Databricks
  http_path?: string;
  // BigQuery
  project_id?: string;
  oauth_connected?: boolean;
  is_active: boolean;
}

export interface ConnectionConfig {
  name: string;
  db_type: DbType;
  // Azure SQL
  server?: string;
  database?: string;
  auth_type: AuthType;
  username?: string;
  password?: string;
  port: number;
  // Snowflake
  warehouse?: string;
  schema_name?: string;
  // Databricks
  http_path?: string;
  // BigQuery
  project_id?: string;
  credentials_json?: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
  error?: string;
}

export interface TableInfo {
  schema_name: string;
  table_name: string;
  table_type: string;
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  max_length?: number;
  is_primary_key: boolean;
}

export interface SchemaData {
  schemas: string[];
  tables: TableInfo[];
}

export interface DesignTable {
  schema_name: string;
  table_name: string;
}

export interface DesignRequest {
  connection_id?: string;
  tables: DesignTable[];
  prompt: string;
  target_schema?: string;
}

export interface DesignResponse {
  narrative: string;
  mermaid_erd: string;
  sql_ddl: string;
}

export interface AISettings {
  anthropic_api_key?: string;
  model: string;
}

export interface AISettingsResponse {
  masked_api_key?: string;
  model: string;
  has_api_key: boolean;
}

export interface Organisation {
  id: string;
  name: string;
  created_at: string;
  user_count: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "sysadmin" | "designer";
  org_id?: string;
  org_name?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  user_id: string;
  org_id?: string;
  created_at: string;
  design_count: number;
}

export interface SavedDesign {
  id: string;
  name: string;
  prompt?: string;
  created_at: string;
  updated_at: string;
}

export interface FullDesign extends SavedDesign {
  narrative?: string;
  mermaid_erd?: string;
  sql_ddl?: string;
  etl_sql?: string;
  connection_id?: string;
  target_schema?: string;
  tables_json?: string;
}

export interface SaveDesignPayload {
  name: string;
  connection_id?: string;
  target_schema?: string;
  tables_json?: string;
  prompt?: string;
  narrative?: string;
  mermaid_erd?: string;
  sql_ddl?: string;
}

export interface DesignVersion {
  id: string;
  version_number: number;
  edited_by_name: string;
  created_at: string;
  sql_ddl?: string;
}

export interface BuildConfig {
  target_connection_id: string;
  drop_if_exists: boolean;
  table_filters?: Record<string, string>;
}

export interface BuildLogEntry {
  step: string;
  status: "ok" | "warn" | "error" | "info";
  message: string;
}

export interface BuildResult {
  success: boolean;
  log: BuildLogEntry[];
  tables_created: number;
  rows_inserted: number;
}

export interface DesignTransform {
  id: string;
  design_id: string;
  name: string;
  description?: string;
  transform_type: "sql" | "ai_extract";
  source_table?: string;
  target_table?: string;
  output_sql?: string;
  config_json?: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface TransformPayload {
  name: string;
  description?: string;
  transform_type: "sql" | "ai_extract";
  source_table?: string;
  target_table?: string;
  output_sql?: string;
  config_json?: string;
}

export interface TransformGeneratePayload {
  name: string;
  description: string;
  transform_type: "sql" | "ai_extract";
  source_table?: string;
  source_columns?: string;
  target_table?: string;
}

export interface GitConfig {
  is_git_repo: boolean;
  remote_url: string;
  has_pat: boolean;
  branch: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitCommitEntry {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

export interface GitStatus {
  is_git_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  commits: GitCommitEntry[];
}

export interface GitPR {
  number: number;
  title: string;
  state: string;
  url: string;
  head: string;
  base: string;
  created_at: string;
  author: string;
}

export interface GitHubUser {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  public_repos: number;
  private_repos: number;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  html_url: string;
  clone_url: string;
  private: boolean;
  description: string;
  default_branch: string;
}

export interface OrchestratorSchedule {
  id: string;
  name: string;
  project_id: string;
  command: string;
  select?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  created_at: string;
  last_run_at?: string;
  last_run_status?: "running" | "success" | "failed";
  next_run_at?: string;
}

export interface OrchestratorRun {
  id: string;
  schedule_id: string;
  schedule_name: string;
  project_id: string;
  command: string;
  select?: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at?: string;
  duration_s?: number;
  log: string;
  return_code?: number;
  triggered_by: "schedule" | "manual";
}

export interface OrchestratorStats {
  runs_today: number;
  runs_today_ok: number;
  runs_today_fail: number;
  success_rate: number | null;
  active_schedules: number;
  total_schedules: number;
  next_run_at?: string;
  next_run_name?: string;
  scheduler_ok: boolean;
}

export interface LogEntry {
  id: string;
  created_at: string;
  level: "info" | "warn" | "error";
  category: string;
  message: string;
  user_email: string | null;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
}

export interface DbtProject {
  id: string;
  name: string;
  slug: string;
  connection_id: string;
  default_schema: string;
  initialized: boolean;
}
