async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export type Me = { id: string; email: string; name: string };
export type Company = { id: string; name: string; slug: string; role?: string };
export type Employee = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  role: string;
  /** Lightweight model summary, present only on the list endpoint. */
  model?: {
    provider: Provider;
    model: string;
    status: "connected" | "not_connected";
  } | null;
};
export type Skill = { id: string; employeeId: string; name: string; slug: string };
export type Routine = {
  id: string;
  employeeId: string;
  name: string;
  slug: string;
  cronExpr: string;
  enabled: boolean;
  lastRunAt: string | null;
  timeoutSec: number;
  requiresApproval: boolean;
  webhookEnabled: boolean;
  webhookToken: string | null;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type Approval = {
  id: string;
  companyId: string;
  routineId: string;
  employeeId: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  routine: { id: string; name: string; slug: string } | null;
  employee: { id: string; name: string; slug: string } | null;
};
export type RunStatus = "running" | "completed" | "failed" | "skipped" | "timeout";
export type Run = {
  id: string;
  routineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  logsPath: string | null;
  exitCode: number | null;
  createdAt: string;
};
export type RunLog = {
  content: string;
  truncated?: boolean;
  size?: number;
  missing?: boolean;
};
export type Provider = "claude-code" | "codex" | "opencode";
export type AuthMode = "subscription" | "apikey";
export type AIModel = {
  id: string;
  employeeId: string;
  provider: Provider;
  model: string;
  authMode: AuthMode;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  configDir: string;
  configDirEnv: string;
  loginCommand: string;
  apiKeyEnv: string | null;
  supportsApiKey: boolean;
};
export type Member = { userId: string; role: string; email: string | null; name: string | null };

export type ChatResult =
  | { status: "ok"; reply: string }
  | { status: "skipped"; reply: string }
  | { status: "error"; reply: string };

export type ConversationSummary = {
  id: string;
  employeeId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "ok" | "skipped" | "error";
export type ConversationMessage = {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  status: ConversationMessageStatus | null;
  createdAt: string;
};
export type ConversationDetail = {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
};
export type SendMessageResult = {
  conversation: ConversationSummary;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
};

export type McpTransport = "stdio" | "http";
export type McpServer = {
  id: string;
  employeeId: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
  createdAt: string;
};

export type JournalKind = "run" | "note" | "system";
export type JournalEntry = {
  id: string;
  employeeId: string;
  kind: JournalKind;
  title: string;
  body: string;
  runId: string | null;
  routineId: string | null;
  authorUserId: string | null;
  createdAt: string;
};

export type EmployeeTemplate = {
  id: string;
  name: string;
  role: string;
  tagline: string;
  skills: string[];
  routines: { name: string; cronExpr: string }[];
};

export type UsageBucket = {
  runs: number;
  completed: number;
  failed: number;
  skipped: number;
  timeout: number;
  durationMs: number;
};
export type UsageEmployeeRow = UsageBucket & {
  employeeId: string;
  name: string;
  slug: string;
};
export type UsageRoutineRow = UsageBucket & {
  routineId: string;
  name: string;
  slug: string;
  employeeId: string;
  employeeName: string;
  employeeSlug: string;
};
export type UsageSummary = {
  windowDays: number;
  totals: UsageBucket;
  byEmployee: UsageEmployeeRow[];
  byRoutine: UsageRoutineRow[];
};

export type AuditActorKind = "user" | "system" | "webhook" | "cron";
export type AuditEvent = {
  id: string;
  companyId: string;
  actorKind: AuditActorKind;
  actorUserId: string | null;
  actor: { id: string; name: string; email: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type Secret = {
  id: string;
  companyId: string;
  name: string;
  description: string;
  /** Masked preview of the plaintext value; full value is never returned. */
  preview: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceNode =
  | { type: "dir"; name: string; path: string; children: WorkspaceNode[] }
  | { type: "file"; name: string; path: string; size: number };

export type TodoStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";
export type TodoPriority = "none" | "low" | "medium" | "high" | "urgent";
export type TodoRecurrence =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";
export type Project = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  key: string;
  createdById: string | null;
  todoCounter: number;
  createdAt: string;
  totalTodos?: number;
  openTodos?: number;
};
export type Todo = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  assigneeEmployeeId: string | null;
  createdById: string | null;
  dueAt: string | null;
  sortOrder: number;
  completedAt: string | null;
  recurrence: TodoRecurrence;
  recurrenceParentId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: { id: string; name: string; slug: string; role: string } | null;
};

export type TodoCommentAuthor =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string };

export type TodoComment = {
  id: string;
  todoId: string;
  authorUserId: string | null;
  authorEmployeeId: string | null;
  body: string;
  pending: boolean;
  createdAt: string;
  updatedAt: string;
  author: TodoCommentAuthor | null;
};

export type WorkspaceFile =
  | { type: "text"; path: string; size: number; content: string }
  | { type: "binary"; path: string; size: number; reason: string }
  | { type: "missing"; path: string };

// ───────────────────────── Bases (Airtable-style) ───────────────────────────

export type BaseColor =
  | "indigo"
  | "emerald"
  | "amber"
  | "rose"
  | "sky"
  | "violet"
  | "slate";

export type Base = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  color: BaseColor;
  createdById: string | null;
  createdAt: string;
  tableCount?: number;
};

export type BaseTable = {
  id: string;
  baseId: string;
  name: string;
  slug: string;
  sortOrder: number;
  createdAt: string;
};

export type BaseFieldType =
  | "text"
  | "longtext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "email"
  | "url"
  | "select"
  | "multiselect"
  | "link";

export type SelectOption = { id: string; label: string; color: string };

export type BaseField = {
  id: string;
  tableId: string;
  name: string;
  type: BaseFieldType;
  config: Record<string, unknown>;
  isPrimary: boolean;
  sortOrder: number;
};

export type BaseRecord = {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BaseLinkOption = { id: string; label: string; tableId: string };

export type BaseDetail = {
  base: Base;
  tables: BaseTable[];
};

export type BaseTableContent = {
  table: BaseTable;
  fields: BaseField[];
  records: BaseRecord[];
  linkOptions: Record<string, BaseLinkOption[]>;
};

export type BaseTemplateSummary = {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  color: BaseColor;
  description: string;
  tableCount: number;
  tableNames: string[];
};

export type BaseAssistantResult = {
  status: "ok" | "skipped" | "error";
  reply: string;
  employee?: { id: string; name: string; slug: string };
};
