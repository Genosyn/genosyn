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

/**
 * Consume a server-sent event stream from a POST endpoint. `onEvent` is
 * called with each `(event, data)` pair as they arrive. Resolves when the
 * server closes the stream. Throws on non-OK responses or on `abort`.
 *
 * Uses `fetch` + ReadableStream rather than EventSource so we can POST a
 * JSON body and send credentials — EventSource is GET-only.
 */
export async function streamPost(
  url: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = res.statusText;
    if (text) {
      try {
        const data = JSON.parse(text);
        msg = data.error ?? data.message ?? msg;
      } catch {
        msg = text;
      }
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error("Stream response had no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line. Split on that boundary and
    // keep the trailing (possibly-incomplete) frame in the buffer.
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        // ignore comments and id/retry fields — we don't use them
      }
      const raw = dataLines.join("\n");
      let data: unknown = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }
      onEvent(event, data);
    }
  }
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
  stream: streamPost,
};

export type Me = {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarKey: string | null;
};
export type Company = { id: string; name: string; slug: string; role?: string };
export type Employee = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  role: string;
  avatarKey?: string | null;
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
  exitCode: number | null;
  createdAt: string;
};
export type RunLog = {
  content: string;
  truncated?: boolean;
  size?: number;
};
export type Provider = "claude-code" | "codex" | "opencode" | "goose";
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
  cliInstalled: boolean;
};

export type PtySessionView = {
  sessionId: string;
  kind: "install" | "login";
  provider: Provider;
  output: string;
  totalBytes: number;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
};
export type Member = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  avatarKey?: string | null;
};

export type ChatResult =
  | { status: "ok"; reply: string }
  | { status: "skipped"; reply: string }
  | { status: "error"; reply: string };

export type ConversationSummary = {
  id: string;
  employeeId: string;
  title: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "ok" | "skipped" | "error";
/** Tool-driven write the AI employee performed during this chat turn. */
export type MessageAction = {
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  metadata?: MessageActionMetadata;
};

export type MessageActionMetadata = {
  via?: string;
  provider?: string;
  connectionId?: string;
  connectionLabel?: string;
  toolName?: string;
  status?: "ok" | "error";
  durationMs?: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
};
export type ConversationMessage = {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  status: ConversationMessageStatus | null;
  actions?: MessageAction[];
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

/**
 * A durable "memory item" — a short fact or preference that is injected
 * into every chat turn and routine run for this employee. Editable by
 * humans (via the Memory tab) and by the AI itself (via MCP).
 */
export type MemoryItem = {
  id: string;
  employeeId: string;
  title: string;
  body: string;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
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

export type IntegrationAuthMode = "apikey" | "oauth2" | "service_account";
export type IntegrationCatalogField = {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required: boolean;
  hint?: string;
};
export type IntegrationScopeGroup = {
  key: string;
  label: string;
  description: string;
  scopes: string[];
  required?: boolean;
  workspaceOnly?: boolean;
};
export type IntegrationCategory =
  | "Databases"
  | "Analytics"
  | "Productivity"
  | "Communication"
  | "Payments"
  | "Developer";

export const INTEGRATION_CATEGORY_ORDER: IntegrationCategory[] = [
  "Databases",
  "Analytics",
  "Productivity",
  "Communication",
  "Payments",
  "Developer",
];

export type IntegrationCatalogEntry = {
  provider: string;
  name: string;
  category: IntegrationCategory;
  tagline: string;
  description?: string;
  icon: string;
  authMode: IntegrationAuthMode;
  fields?: IntegrationCatalogField[];
  oauth?: {
    app: "google" | "x";
    scopes: string[];
    scopeGroups?: IntegrationScopeGroup[];
    setupDocs?: string;
  };
  serviceAccount?: {
    scopes: string[];
    scopeGroups?: IntegrationScopeGroup[];
    impersonation: boolean;
    setupDocs?: string;
  };
  enabled: boolean;
  disabledReason?: string;
};
export type IntegrationConnectionStatus = "connected" | "error" | "expired";
export type IntegrationConnection = {
  id: string;
  companyId: string;
  provider: string;
  label: string;
  authMode: IntegrationAuthMode;
  accountHint: string;
  status: IntegrationConnectionStatus;
  statusMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  scopeGroups: string[];
};
export type ConnectionGrant = {
  id: string;
  employeeId: string;
  connectionId: string;
  createdAt: string;
  connection: IntegrationConnection;
};

/**
 * Inverse shape of `ConnectionGrant`. Returned by the per-connection grants
 * endpoint so the Settings → Integrations page can show which employees
 * already have access without a second roundtrip per row.
 */
export type ConnectionGrantWithEmployee = {
  id: string;
  employeeId: string;
  connectionId: string;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  };
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

// ───────────────────────── Email providers + logs ──────────────────────────

export type EmailProviderKind =
  | "smtp"
  | "sendgrid"
  | "mailgun"
  | "resend"
  | "postmark";

export type EmailProviderField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "checkbox" | "select";
  required: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
};

export type EmailProviderCatalogEntry = {
  kind: EmailProviderKind;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  fields: EmailProviderField[];
};

export type EmailProviderTestStatus = "ok" | "failed";
export type EmailProvider = {
  id: string;
  companyId: string;
  name: string;
  kind: EmailProviderKind;
  fromAddress: string;
  replyTo: string;
  isDefault: boolean;
  enabled: boolean;
  configPreview: Record<string, string>;
  lastTestedAt: string | null;
  lastTestStatus: EmailProviderTestStatus | null;
  lastTestMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type EmailLogStatus = "sent" | "failed" | "skipped";
export type EmailLogTransport =
  | "smtp"
  | "sendgrid"
  | "mailgun"
  | "resend"
  | "postmark"
  | "config_smtp"
  | "console";
export type EmailLogPurpose =
  | "invitation"
  | "password_reset"
  | "welcome"
  | "test"
  | "other";

export type EmailLog = {
  id: string;
  companyId: string | null;
  providerId: string | null;
  transport: EmailLogTransport;
  purpose: EmailLogPurpose;
  toAddress: string;
  fromAddress: string;
  subject: string;
  bodyPreview: string;
  status: EmailLogStatus;
  errorMessage: string;
  messageId: string;
  triggeredByUserId: string | null;
  createdAt: string;
};

export type EmailLogPage = {
  total: number;
  limit: number;
  offset: number;
  rows: EmailLog[];
};

export type BackupKind = "manual" | "scheduled" | "uploaded";
export type BackupStatus = "running" | "completed" | "failed";
export type Backup = {
  id: string;
  filename: string;
  sizeBytes: number;
  kind: BackupKind;
  status: BackupStatus;
  errorMessage: string;
  createdAt: string;
  completedAt: string | null;
};

export type BackupFrequency = "daily" | "weekly" | "monthly";
export type BackupSchedule = {
  enabled: boolean;
  frequency: BackupFrequency;
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  cronExpr: string;
  lastRunAt: string | null;
  updatedAt: string;
};

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
  reviewTodos?: number;
};
export type TodoAssignee =
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | { kind: "human"; id: string; name: string; email: string | null };
export type TodoReviewer = TodoAssignee;

export type Todo = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  assigneeEmployeeId: string | null;
  assigneeUserId: string | null;
  reviewerEmployeeId: string | null;
  reviewerUserId: string | null;
  createdById: string | null;
  dueAt: string | null;
  sortOrder: number;
  completedAt: string | null;
  recurrence: TodoRecurrence;
  recurrenceParentId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: TodoAssignee | null;
  reviewer: TodoReviewer | null;
};

/**
 * Todo hydrated with its project stub — returned by the `/reviews` endpoint
 * so the reviewer queue can render "{project key}-{number}" and deep-link
 * without an extra fetch per row.
 */
export type ReviewItem = Todo & {
  project: { id: string; key: string; name: string; slug: string } | null;
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

/**
 * Operators for a filter rule, by field type. Kept as a flat union so the
 * UI can drive its operator dropdown from a single source. Some operators
 * apply to multiple types (e.g. `isEmpty`) and the picker filters them based
 * on the field's `type`.
 */
export type BaseFilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "doesNotContain"
  | "isEmpty"
  | "isNotEmpty"
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual"
  | "isAnyOf"
  | "isNoneOf"
  | "hasAnyOf"
  | "hasAllOf"
  | "hasNoneOf"
  | "isBefore"
  | "isAfter"
  | "isChecked"
  | "isUnchecked";

export type BaseFilterRule = {
  id: string;
  fieldId: string;
  operator: BaseFilterOperator;
  value?: unknown;
};

export type BaseSortRule = {
  id: string;
  fieldId: string;
  direction: "asc" | "desc";
};

export type BaseView = {
  id: string;
  tableId: string;
  name: string;
  slug: string;
  sortOrder: number;
  filters: BaseFilterRule[];
  sorts: BaseSortRule[];
  hiddenFieldIds: string[];
  createdAt: string;
};

export type BaseTableContent = {
  table: BaseTable;
  fields: BaseField[];
  records: BaseRecord[];
  linkOptions: Record<string, BaseLinkOption[]>;
  views: BaseView[];
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

export type BaseRecordCommentAuthor =
  | {
      kind: "human";
      id: string;
      name: string;
      email: string | null;
      avatarKey: string | null;
      handle: string | null;
    }
  | {
      kind: "ai";
      id: string;
      name: string;
      slug: string;
      role: string;
      avatarKey: string | null;
    };

export type BaseRecordComment = {
  id: string;
  recordId: string;
  body: string;
  authorUserId: string | null;
  authorEmployeeId: string | null;
  author: BaseRecordCommentAuthor | null;
  createdAt: string;
  updatedAt: string;
};

export type BaseRecordAttachmentUploader =
  | { kind: "human"; id: string; name: string }
  | { kind: "ai"; id: string; name: string; slug: string };

export type BaseRecordAttachment = {
  id: string;
  recordId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  uploadedByUserId: string | null;
  uploadedByEmployeeId: string | null;
  uploader: BaseRecordAttachmentUploader | null;
  createdAt: string;
};

/**
 * A grant giving one AI employee read/write access to one Base via their MCP
 * tools. The server returns the pair plus a lightweight employee snapshot so
 * the UI can render names without a second request.
 */
export type BaseGrant = {
  id: string;
  employeeId: string;
  baseId: string;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
  } | null;
};

// ───────────────────────── Pipelines (n8n-style automation) ──────────────────

export type PipelineNodeFamily = "trigger" | "action" | "logic" | "integration";
export type PipelineNodeFieldType =
  | "text"
  | "longtext"
  | "number"
  | "boolean"
  | "select"
  | "code";

export type PipelineNodeField = {
  key: string;
  label: string;
  type: PipelineNodeFieldType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  default?: unknown;
};

export type PipelineNodeCatalogEntry = {
  type: string;
  family: PipelineNodeFamily;
  label: string;
  icon: string;
  description: string;
  fields: PipelineNodeField[];
  outputs?: string[];
};

export type PipelineNode = {
  id: string;
  type: string;
  label?: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
};

export type PipelineEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromHandle?: string;
};

export type PipelineGraph = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
};

export type Pipeline = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  graph: PipelineGraph;
  cronExpr: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PipelineRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped";
export type PipelineTriggerKind = "manual" | "schedule" | "webhook";

export type PipelineRunSummary = {
  id: string;
  pipelineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: PipelineRunStatus;
  triggerKind: PipelineTriggerKind;
  triggerNodeId: string | null;
  errorMessage: string | null;
};

export type PipelineRunDetail = PipelineRunSummary & {
  inputJson: string;
  outputJson: string;
  logContent: string;
  truncated: boolean;
};

// ───────────────────────── Notes (Notion-style knowledge base) ───────────────

export type NoteAuthor =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string };

export type Note = {
  id: string;
  companyId: string;
  notebookId: string;
  title: string;
  slug: string;
  body: string;
  icon: string;
  parentId: string | null;
  sortOrder: number;
  createdById: string | null;
  createdByEmployeeId: string | null;
  lastEditedById: string | null;
  lastEditedByEmployeeId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: NoteAuthor | null;
  lastEditedBy: NoteAuthor | null;
};

export type Notebook = {
  id: string;
  companyId: string;
  title: string;
  slug: string;
  icon: string;
  sortOrder: number;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
  archivedCount: number;
};

/** Per-note access an AI employee can hold. Humans always have full access. */
export type NoteAccessLevel = "read" | "write";

export type NoteGrantEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

export type NoteGrant = {
  id: string;
  employeeId: string;
  noteId: string;
  accessLevel: NoteAccessLevel;
  createdAt: string;
  employee: NoteGrantEmployee | null;
};

/** A grant inherited from an ancestor note — read-only on this page. */
export type InheritedNoteGrant = NoteGrant & {
  source: { id: string; slug: string; title: string } | null;
};

/** A grant inherited from the notebook the note lives in. */
export type NotebookInheritedGrant = {
  id: string;
  employeeId: string;
  notebookId: string;
  accessLevel: NoteAccessLevel;
  createdAt: string;
  employee: NoteGrantEmployee | null;
  source: { id: string; slug: string; title: string } | null;
};

export type NoteGrantsResponse = {
  direct: NoteGrant[];
  inherited: InheritedNoteGrant[];
  notebookInherited: NotebookInheritedGrant[];
};

export type NoteGrantCandidate = NoteGrantEmployee & {
  alreadyGranted: boolean;
};

/** Direct grants on a Notebook (cascades into every note in the notebook). */
export type NotebookGrant = {
  id: string;
  employeeId: string;
  notebookId: string;
  accessLevel: NoteAccessLevel;
  createdAt: string;
  employee: NoteGrantEmployee | null;
};

export type NotebookGrantsResponse = {
  direct: NotebookGrant[];
};

export type NotebookGrantCandidate = NoteGrantCandidate;

// ───────────────────────── Notifications ────────────────────────────────

export type NotificationKind =
  | "mention"
  | "todo_review_requested"
  | "approval_pending";

export type NotificationActorKind = "user" | "ai" | "system";

export type NotificationEntityKind =
  | "channel_message"
  | "todo"
  | "approval";

export type NotificationActor = {
  kind: NotificationActorKind;
  id: string | null;
  name: string;
  avatarKey: string | null;
  slug: string | null;
};

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  actor: NotificationActor | null;
  entityKind: NotificationEntityKind | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};
