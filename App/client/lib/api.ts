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
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
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
      let sawField = false;
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          sawField = true;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
          sawField = true;
        }
        // ignore comments and id/retry fields — we don't use them
      }
      // A frame with no event/data field is a server keepalive comment
      // (`: ...`) sent to hold the connection open during long replies.
      // It carries nothing to dispatch, so skip it.
      if (!sawField) continue;
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
  /** Multipart upload of a single file under field name `file`, with
   *  optional extra text fields appended to the same form (e.g. a title or
   *  customer id alongside a contract). */
  uploadFile: async <T>(url: string, file: File, fields?: Record<string, string>): Promise<T> => {
    const form = new FormData();
    form.append("file", file);
    if (fields) {
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
    }
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText;
      throw new Error(msg);
    }
    return data as T;
  },
};

export type Me = {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarKey: string | null;
  /** Instance-level operator flag — gates the install-wide Admin dashboard. */
  isMasterAdmin: boolean;
  emailVerified: boolean;
  emailVerificationRequired: boolean;
};
export type TwoFactorLoginMethods = {
  enabled: boolean;
  totp: boolean;
  webAuthn: boolean;
  recovery: boolean;
};
export type LoginResponse =
  | {
      id: string;
      email: string;
      name: string;
      requiresTwoFactor: false;
      emailVerificationRequired: boolean;
    }
  | { requiresTwoFactor: true; methods: TwoFactorLoginMethods };
export type TwoFactorLoginStatus =
  | { requiresTwoFactor: false }
  | { requiresTwoFactor: true; methods: TwoFactorLoginMethods };
export type TwoFactorCredential = {
  id: string;
  name: string;
  kind: "passkey" | "security_key";
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};
export type TwoFactorStatus = {
  enabled: boolean;
  totpEnabled: boolean;
  webAuthnCredentials: TwoFactorCredential[];
  recoveryCodesRemaining: number;
};
export type Company = {
  id: string;
  name: string;
  slug: string;
  role?: "owner" | "admin" | "member";
  requireTwoFactor: boolean;
};
export type Employee = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  role: string;
  avatarKey?: string | null;
  teamId?: string | null;
  reportsToEmployeeId?: string | null;
  reportsToUserId?: string | null;
  /**
   * Whether the built-in `browser` MCP server is wired into this employee's
   * provider config. False on a stock install — operator opts in per
   * employee from the Settings → General page.
   */
  browserEnabled?: boolean;
  /**
   * Newline-separated host globs (e.g. `*.gmail.com`). Empty / null = no
   * restriction. Enforced inside the browser MCP's `browser_open` tool.
   */
  browserAllowedHosts?: string | null;
  /**
   * When true, `browser_submit` queues an Approval and the model has to
   * call `browser_resume(approvalId)` after a human approves.
   */
  browserApprovalRequired?: boolean;
  /**
   * Lightweight summary of the employee's *active* model, present only on the
   * list endpoint. Null when no model is registered.
   */
  model?: {
    provider: Provider;
    model: string;
    status: "connected" | "not_connected";
  } | null;
  /** How many models the employee has registered. Present on the list endpoint. */
  modelCount?: number;
};

export type Team = {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TagColor =
  | "slate"
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "violet"
  | "pink";

export type CompanyTag = {
  id: string;
  companyId: string;
  name: string;
  normalizedName: string;
  color: TagColor;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type TaggableResourceType =
  | "routine"
  | "skill"
  | "resource"
  | "project"
  | "base"
  | "notebook"
  | "note"
  | "pipeline"
  | "code_repository"
  | "chart"
  | "dashboard";

export type HandoffStatus = "pending" | "completed" | "declined" | "cancelled";

export type HandoffParty = {
  id: string;
  slug: string;
  name: string;
  role: string;
};

export type Handoff = {
  id: string;
  companyId: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  from: HandoffParty | null;
  to: HandoffParty | null;
  title: string;
  body: string;
  status: HandoffStatus;
  resolutionNote: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Skill = {
  id: string;
  employeeId: string;
  name: string;
  slug: string;
  createdAt: string;
  tags: CompanyTag[];
  /** Tool names this playbook declares; loaded up-front when it applies. */
  toolset: string[];
};
export type Routine = {
  id: string;
  employeeId: string;
  name: string;
  slug: string;
  cronExpr: string;
  enabled: boolean;
  lastRunAt: string | null;
  /**
   * When the schedule next fires. Null when the routine is paused, or when
   * `cronExpr` parses for `node-cron` (which validates it) but not for
   * `cron-parser` (which computes this) — so a null here on an *enabled*
   * routine means the schedule never fires, and the UI says so.
   */
  nextRunAt: string | null;
  timeoutSec: number;
  requiresApproval: boolean;
  webhookEnabled: boolean;
  webhookToken: string | null;
  /**
   * The employee model this routine runs on. `null` inherits whichever model
   * is active for the employee; a string pins one of the employee's own
   * models to this routine's runs.
   */
  modelId?: string | null;
  /**
   * Per-routine override of `AIEmployee.browserEnabled`. Three states:
   *   * `null` — inherit the employee setting.
   *   * `true` — force-enable browser access for this routine only.
   *   * `false` — force-disable browser access for this routine only.
   */
  browserEnabledOverride?: boolean | null;
  /**
   * What to do about slots missed while the server was unavailable.
   *   * `"once"` (default) — one catch-up run however many were missed.
   *   * `"skip"` — decline a catch-up that is already more than a minute late.
   * Missed slots are never replayed one-for-one.
   */
  catchUpPolicy?: CatchUpPolicy;
  /** Total attempts per occurrence, counting the first. 1 means no retry. */
  maxAttempts?: number;
  /** Base for full-jitter exponential backoff. Inert while `maxAttempts` is 1. */
  retryBackoffSec?: number;
  /**
   * Whether a `timeout` is retryable. Off by default — a retry re-burns the
   * routine's whole time budget.
   */
  retryOnTimeout?: boolean;
  tags: CompanyTag[];
};
export type CatchUpPolicy = "once" | "skip";

/**
 * The slice of an AI employee a company-wide list shows as "assigned to" —
 * enough for an avatar, a name, and a link. Mirrors `employeeSummary()` on
 * the Routines and Skills routers.
 */
export type EmployeeSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

/**
 * A routine as the company-wide Routines section sees it: the row plus the
 * employee it belongs to and how its most recent run went. Served by
 * `/api/companies/:cid/routines` (list, no `body`) and
 * `/api/companies/:cid/routines/:rid` (one, `body` included).
 */
export type RoutineWithMeta = Routine & {
  employee: EmployeeSummary | null;
  lastRun: Run | null;
  /** Only present on the single-routine endpoint. */
  body?: string;
};

/**
 * A skill as the company-wide Skills section sees it: the row plus the
 * employee whose playbook it is. Served by `/api/companies/:cid/skills`.
 * `body` is not on the list — each playbook is fetched via
 * `/skills/:sid/readme` when you open it.
 */
export type SkillWithMeta = Skill & {
  employee: EmployeeSummary | null;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind =
  | "routine"
  | "lightning_payment"
  | "browser_action"
  | "mcp_tool"
  | "ad_spend";
export type Approval = {
  id: string;
  companyId: string;
  kind: ApprovalKind;
  routineId: string;
  employeeId: string;
  title: string | null;
  summary: string | null;
  payloadJson: string | null;
  resultJson: string | null;
  errorMessage: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  routine: { id: string; name: string; slug: string } | null;
  employee: { id: string; name: string; slug: string } | null;
};
export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timeout"
  /** The server stopped while this run was executing. */
  | "interrupted";
export type RunTrigger = "schedule" | "manual" | "webhook" | "approval" | "retry";
export type Run = {
  id: string;
  routineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  exitCode: number | null;
  createdAt: string;
  triggerKind?: RunTrigger;
  /** 1-based attempt within a retry chain. */
  attempt?: number;
  /** When the scheduler will start the next attempt. Null when none is owed. */
  retryAt?: string | null;
  /** Occurrences missed during downtime that this run stands in for. */
  missedSlots?: number;
};
export type RunLog = {
  content: string;
  truncated?: boolean;
  size?: number;
  live?: boolean;
  status?: RunStatus;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string | null;
  retryAt?: string | null;
  attempt?: number;
};
export type Provider = "anthropic" | "openai" | "custom";
export type AuthMode = "apikey" | "customEndpoint";
export type AIModel = {
  id: string;
  employeeId: string;
  provider: Provider;
  model: string;
  authMode: AuthMode;
  /** True if this is the brain the runner + chat seams use for the employee. */
  isActive: boolean;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /** Env var the provider conventionally reads (informational), or null. */
  apiKeyEnv: string | null;
  supportsApiKey: boolean;
  supportsCustomEndpoint: boolean;
  customEndpointHost: string | null;
  customEndpointModelId: string | null;
  customEndpointHasApiKey: boolean;
  /**
   * Tokens this model accepts, or null when nobody knows. Null isn't cosmetic:
   * without it a run can't budget its context and only finds out it overflowed
   * when the provider rejects a turn.
   */
  contextWindow: number | null;
  /** Whether `contextWindow` was probed from the provider or typed in by hand. */
  contextWindowSource: "probed" | "manual" | null;
  /** False when the provider can't be asked at all (OpenAI reports no window). */
  contextWindowProbeable: boolean;
};
export type Member = {
  userId: string;
  role: "owner" | "admin" | "member";
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
export type ConversationMessageStatus = "ok" | "skipped" | "error" | "busy";
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
export type ChatAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};
export type ConversationMessage = {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  status: ConversationMessageStatus | null;
  actions?: MessageAction[];
  attachments?: ChatAttachment[];
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
  /** Glob patterns of tool names that queue an Approval instead of running. */
  guardedTools: string[];
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
  category: string;
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
  interrupted: number;
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

export type IntegrationAuthMode =
  | "apikey"
  | "oauth2"
  | "service_account"
  | "github_app"
  | "browser";
export type IntegrationCatalogField = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "textarea";
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
    app: "google" | "x" | "github" | "reddit" | "linkedin" | "microsoft";
    scopes: string[];
    scopeGroups?: IntegrationScopeGroup[];
    /** Extra create-time inputs (developer tokens, account ids, safety
     *  caps) rendered on the connect form after client id/secret. */
    extraFields?: IntegrationCatalogField[];
    setupDocs?: string;
  };
  serviceAccount?: {
    scopes: string[];
    scopeGroups?: IntegrationScopeGroup[];
    impersonation: boolean;
    setupDocs?: string;
  };
  githubApp?: {
    setupDocs?: string;
  };
  browserLogin?: {
    fields: IntegrationCatalogField[];
    description?: string;
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

export type ApiKey = {
  id: string;
  name: string;
  /** Display-only chip including the `gen_` prefix and first 8 chars of the
   * random suffix. The full token is only ever returned once by `create`. */
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** Returned by `POST /api-keys`. The `token` field is the plaintext value
 * shown to the human exactly once — never persisted, never visible again. */
export type ApiKeyCreated = ApiKey & { token: string };

// ───────────────────────── Email providers + logs ──────────────────────────

export type EmailProviderKind = "smtp" | "sendgrid" | "mailgun" | "resend" | "postmark";

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
  /** Non-secret prefill for the connect form (new providers only) — e.g.
   *  the SMTP entry seeded from the global config.ts SMTP block. */
  prefill?: {
    from?: string;
    fields?: Record<string, string | number | boolean>;
  };
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
export type EmailLogPurpose = "invitation" | "password_reset" | "welcome" | "test" | "other";

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
/** `retentionEnabled` / `retentionDays` are the auto-delete policy and are
 *  independent of `enabled` — archives pile up whether or not the recurring
 *  backup is on. `prunedNow` is response-only: PUT /api/backups/schedule
 *  enforces retention as it saves and reports what that deleted. */
export type BackupSchedule = {
  enabled: boolean;
  frequency: BackupFrequency;
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  cronExpr: string;
  lastRunAt: string | null;
  retentionEnabled: boolean;
  retentionDays: number;
  updatedAt: string;
  prunedNow?: number;
};

export type BackupDestinationKind = "local" | "sftp" | "smb";
export type BackupDestinationStatus = "unknown" | "ok" | "error";
export type SftpAuthMode = "password" | "key";
/** Off-box mirror target for backups (a mounted NAS path, an SFTP host, or an
 *  SMB share). Secrets are never returned — only whether one is set
 *  (`hasPassword` / `hasPrivateKey`). `host` / `port` / `username` /
 *  `remoteDir` are shared by the sftp and smb kinds; `share` / `domain` /
 *  `encrypt` are smb-only and null otherwise. */
export type BackupDestination = {
  id: string;
  name: string;
  kind: BackupDestinationKind;
  enabled: boolean;
  hint: string;
  path: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  remoteDir: string | null;
  authMode: SftpAuthMode | null;
  share: string | null;
  domain: string | null;
  encrypt: boolean | null;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  configError: boolean;
  lastStatus: BackupDestinationStatus;
  lastError: string;
  lastSyncedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
/** Result of pushing one archive to one destination. */
export type BackupDeliveryResult = {
  destinationId: string;
  destinationName: string;
  ok: boolean;
  error?: string;
};

export type TodoStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export type TodoPriority = "none" | "low" | "medium" | "high" | "urgent";
export type TodoRecurrence =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";
/**
 * Access lives on the Project, not on a view of it — "Board" is just a view
 * mode, so the list and the board inherit the same rules.
 *
 *   - open       → everyone in the company can edit it (the default)
 *   - restricted → only the people and AI employees explicitly added
 */
export type ProjectAccessMode = "open" | "restricted";
export type ProjectAccessLevel = "read" | "write";
/** Humans and AI employees share one member list. */
export type ProjectMemberKind = "user" | "ai";

/** A `ProjectMember` row hydrated with the principal's display fields. */
export type ProjectMember = {
  id: string;
  memberKind: ProjectMemberKind;
  accessLevel: ProjectAccessLevel;
  userId: string | null;
  employeeId: string | null;
  name: string;
  /** Set for humans only. */
  email: string | null;
  /** Set for AI employees only. */
  slug: string | null;
};

export type ProjectAccessResponse = {
  accessMode: ProjectAccessMode;
  myAccessLevel: ProjectAccessLevel;
  members: ProjectMember[];
};

export type Project = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  key: string;
  accessMode: ProjectAccessMode;
  createdById: string | null;
  todoCounter: number;
  createdAt: string;
  /**
   * The level the current viewer was served with. Present on the single-project
   * and todos endpoints; absent on the list endpoint.
   */
  myAccessLevel?: ProjectAccessLevel;
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
  parentTodoId: string | null;
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

export type BaseColor = "indigo" | "emerald" | "amber" | "rose" | "sky" | "violet" | "slate";

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
  | "link"
  | "customer"
  | "invoice"
  | "project"
  | "employee"
  | "member"
  | "note"
  | "pipeline";

/** The Base field types that link to records elsewhere in Genosyn. */
export const BASE_RESOURCE_FIELD_TYPES = [
  "customer",
  "invoice",
  "project",
  "employee",
  "member",
  "note",
  "pipeline",
] as const;

export type BaseResourceFieldType = (typeof BASE_RESOURCE_FIELD_TYPES)[number];

export function isBaseResourceFieldType(t: BaseFieldType): t is BaseResourceFieldType {
  return (BASE_RESOURCE_FIELD_TYPES as readonly string[]).includes(t);
}

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

/**
 * A pickable target for a record-link column (customer, project, …).
 * `url` is an app-relative deep link, or "" when the product has no
 * per-record page. `archived` rows stay resolvable but are hidden from
 * pickers.
 */
export type BaseResourceOption = {
  id: string;
  label: string;
  sublabel: string;
  url: string;
  archived?: boolean;
};

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
  resourceOptions: Record<string, BaseResourceOption[]>;
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
export type PipelineNodeFieldType = "text" | "longtext" | "number" | "boolean" | "select" | "code";

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

export type PipelineRunStatus = "running" | "completed" | "failed" | "skipped";
export type PipelineTriggerKind = "manual" | "schedule" | "webhook" | "event";

export type PipelineRunSummary = {
  id: string;
  pipelineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: PipelineRunStatus;
  triggerKind: PipelineTriggerKind;
  triggerLabel: string | null;
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

// ───────────────────────── Resources (M18) ──────────────────────────────

export type ResourceSourceKind = "url" | "text" | "pdf" | "epub" | "video";
export type ResourceStatus = "pending" | "ready" | "failed";

export type ResourceAuthor =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string };

export type Resource = {
  id: string;
  companyId: string;
  title: string;
  slug: string;
  sourceKind: ResourceSourceKind;
  sourceUrl: string | null;
  sourceFilename: string | null;
  storageKey: string | null;
  summary: string;
  /** Full extracted text — present only on the detail endpoint. */
  bodyText?: string;
  /** Length of the extracted text in characters; cheap to surface in lists. */
  bodyLength: number;
  tags: CompanyTag[];
  tagList: string[];
  bytes: number;
  status: ResourceStatus;
  errorMessage: string;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdBy: ResourceAuthor | null;
  createdAt: string;
  updatedAt: string;
};

export type ResourceGrantEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

/**
 * Resources have three escalating capabilities (vs. notes which only have
 * read | write): read → edit → delete. The MCP tools check
 * `RESOURCE_ACCESS_RANK[grant] >= RESOURCE_ACCESS_RANK[required]`, so an
 * `edit` grant covers `update_resource` but not `delete_resource`.
 */
export type ResourceAccessLevel = "read" | "edit" | "delete";

export type ResourceGrant = {
  id: string;
  employeeId: string;
  resourceId: string;
  accessLevel: ResourceAccessLevel;
  createdAt: string;
  employee: ResourceGrantEmployee | null;
};

export type ResourceGrantsResponse = { direct: ResourceGrant[] };

export type ResourceGrantCandidate = ResourceGrantEmployee & {
  alreadyGranted: boolean;
};

// ───────────────────────── Code Repositories ────────────────────────────

export type CodeRepoAuthMode = "none" | "https" | "ssh";
export type CodeRepoSyncStatus = "unknown" | "ok" | "error";
export type CodeRepoAccessLevel = "read" | "write";

export type CodeRepoAuthor = {
  kind: "human";
  id: string;
  name: string;
  email: string | null;
};

export type CodeRepository = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  gitUrl: string;
  defaultBranch: string;
  authMode: CodeRepoAuthMode;
  httpsUsername: string | null;
  committerName: string | null;
  committerEmail: string | null;
  /** Whether a credential is stored — never the secret itself. */
  hasToken: boolean;
  hasSshKey: boolean;
  grantCount: number;
  lastSyncedAt: string | null;
  lastSyncStatus: CodeRepoSyncStatus;
  lastSyncError: string;
  createdById: string | null;
  createdBy: CodeRepoAuthor | null;
  createdAt: string;
  updatedAt: string;
};

export type CodeRepoGrantEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  /** True when a connected GitHub Connection grant exposes the PR tool. */
  pullRequestReady: boolean;
};

export type CodeRepoGrant = {
  id: string;
  employeeId: string;
  codeRepositoryId: string;
  accessLevel: CodeRepoAccessLevel;
  createdAt: string;
  employee: CodeRepoGrantEmployee | null;
};

export type CodeRepoGrantsResponse = { direct: CodeRepoGrant[] };

export type CodeRepoGrantCandidate = Omit<CodeRepoGrantEmployee, "pullRequestReady"> & {
  alreadyGranted: boolean;
};

export type CodeRepoTestResult = {
  ok: boolean;
  message: string;
  defaultBranch?: string;
};

// ───────────────────────── Finance AI access ────────────────────────────

/** read < invoice < full — see EmployeeFinanceGrant on the server. */
export type FinanceAccessLevel = "read" | "invoice" | "full";

export type FinanceGrantEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

export type FinanceGrant = {
  id: string;
  employeeId: string;
  accessLevel: FinanceAccessLevel;
  createdAt: string;
  employee: FinanceGrantEmployee | null;
};

export type FinanceGrantsResponse = { direct: FinanceGrant[] };

export type FinanceGrantCandidate = FinanceGrantEmployee & {
  alreadyGranted: boolean;
};

// ───────────────────────── Notifications ────────────────────────────────

export type NotificationKind =
  | "mention"
  | "todo_review_requested"
  | "approval_pending"
  | "finance_review_ready"
  | "mail_handover";

export type NotificationActorKind = "user" | "ai" | "system";

export type NotificationEntityKind = "channel_message" | "todo" | "approval" | "ledger_entry";

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

// ─────────────────────────── Home page ──────────────────────────────────

export type HomeTodo = {
  id: string;
  number: number;
  title: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueAt: string | null;
  parentTodoId: string | null;
  project: { id: string; key: string; name: string; slug: string };
};

export type HomeApproval = {
  id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  requestedAt: string;
  employee: { id: string; name: string; slug: string } | null;
  routine: { id: string; name: string; slug: string } | null;
};

export type HomeChannel = {
  id: string;
  kind: string;
  label: string;
  unreadCount: number;
};

export type HomeFailedRun = {
  runId: string;
  routineId: string;
  routineName: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    avatarKey: string | null;
  };
};

// ───────────────────────── System Health ────────────────────────────────
export type HealthSeverity = "ok" | "warn" | "error";
export type HealthItem = {
  label: string;
  sublabel?: string;
  badge?: string;
  link?: string;
};
export type HealthCheck = {
  id: string;
  title: string;
  description: string;
  severity: HealthSeverity;
  count: number;
  summary: string;
  items: HealthItem[];
};
export type SystemHealthReport = {
  generatedAt: string;
  windowHours: number;
  status: HealthSeverity;
  issueCount: number;
  checks: HealthCheck[];
};
export type SystemHealthSummary = {
  status: HealthSeverity;
  issueCount: number;
  checks: {
    id: string;
    title: string;
    severity: HealthSeverity;
    count: number;
  }[];
};

// ───────────────────────── Instance Health (Admin) ──────────────────────
// Install-wide health (database, migrations, disk, runtime), distinct from the
// company-scoped System Health above. Served by /api/admin/instance-health.
export type InstanceSeverity = "ok" | "warn" | "error";
export type InstanceFact = { label: string; value: string; mono?: boolean };
export type InstanceCheck = {
  id: string;
  title: string;
  description: string;
  severity: InstanceSeverity;
  summary: string;
  facts: InstanceFact[];
};
export type InstanceInfo = {
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  dbDriver: "sqlite" | "postgres";
  dataDir: string;
  publicUrl: string;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  counts: { companies: number; users: number; employees: number };
};
export type InstanceHealthReport = {
  generatedAt: string;
  status: InstanceSeverity;
  issueCount: number;
  checks: InstanceCheck[];
  instance: InstanceInfo;
};

// ─────────────────────────── Migrations (Admin) ─────────────────────────
// The per-migration detail behind the Instance Health "migrations" check,
// served read-only by /api/admin/migrations. Severity reuses InstanceSeverity
// above so the two admin surfaces grade themselves on one scale.
//
// NOTE: there is no "applied at" here, and that is not an oversight. TypeORM's
// migrations table records only id (execution ORDER), the migration's own
// AUTHORED timestamp, and its name — nothing stores when a migration actually
// ran. `authoredAt` is when the migration was WRITTEN; never label it "Applied
// at" or "Ran at" in the UI. Use `batchId` for run order.
export type MigrationState = "applied" | "pending" | "unknown";
export type MigrationEntry = {
  /** TypeORM migration class name, e.g. "Init1776188492090". */
  name: string;
  /** Human title with the timestamp suffix stripped, e.g. "Init". */
  title: string;
  /** Authored timestamp (ms epoch) parsed from the class-name suffix. */
  timestamp: number;
  /** ISO of `timestamp` — when the migration was WRITTEN, not when it ran. */
  authoredAt: string;
  state: MigrationState;
  /** migrations.id — the execution order rank. null when pending. */
  batchId: number | null;
};
export type MigrationIssue = {
  /** Stable key: "pending" | "unknown" | "out_of_order". */
  id: string;
  severity: InstanceSeverity;
  title: string;
  detail: string;
  /** Migration class names implicated by this issue. */
  migrations: string[];
};
export type MigrationReport = {
  generatedAt: string;
  driver: "sqlite" | "postgres";
  status: InstanceSeverity;
  summary: string;
  total: number;
  appliedCount: number;
  pendingCount: number;
  unknownCount: number;
  lastApplied: {
    name: string;
    title: string;
    authoredAt: string;
    batchId: number | null;
  } | null;
  issues: MigrationIssue[];
  /** Every migration, sorted by `timestamp` DESC (newest first). */
  migrations: MigrationEntry[];
};

export type GlobalSmtpSource = "database" | "config" | "none";
/** Non-secret view of the install-wide global email transport (Admin → Email). */
export type GlobalEmailTransport = {
  configured: boolean;
  source: GlobalSmtpSource;
  overrideActive: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  fromName: string;
  from: string;
  hasPassword: boolean;
  configFallback: {
    configured: boolean;
    host: string;
    fromName: string;
    from: string;
  };
};

// ───────────────────────── Admin instance settings ─────────────────────────
// Installation-wide browser origin, persisted in app_settings and served by
// /api/admin/instance-settings.
export type InstanceSettings = {
  publicUrl: string;
  configured: boolean;
};

// ───────────────────────── Admin sign-up policy ─────────────────────────────
// Instance-wide toggle for self-service registration, served by
// /api/admin/signup-settings. The public sign-up page reads /api/auth/signup-status.
export type SignupSettings = { signupsDisabled: boolean };
export type SignupStatus = { open: boolean };

// ───────────────────────────── Admin SSO ────────────────────────────────────
// Instance-wide single sign-on, served by /api/admin/sso. Disabled by default.
// The login page reads the public probe at /api/auth/sso/status.
export type SsoProvider = "google" | "oidc";
export type SsoSettings = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  autoProvision: boolean;
  configured: boolean;
  callbackUrl: string;
};
export type SsoPublicStatus = { enabled: boolean; buttonLabel: string | null };
export type SsoIssuerCheck = {
  ok: boolean;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
};

// ───────────────────── Admin directory (Users + Companies) ───────────────────
// Instance-wide management surfaces served by /api/admin/users and
// /api/admin/companies. Not company-scoped — see routes/admin.ts.
export type OwnedCompanyRef = { id: string; name: string; slug: string };
export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarKey: string | null;
  createdAt: string;
  isMasterAdmin: boolean;
  membershipCount: number;
  ownedCompanies: OwnedCompanyRef[];
};
export type AdminCompanyRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  owner: { id: string; name: string; email: string } | null;
  memberCount: number;
  employeeCount: number;
};

// ───────────────────── Admin DB console (Admin → Database) ───────────────────
// A raw query console over Genosyn's own application database, served by
// /api/admin/db/*. Master-admin gated, read-only by default. See
// server/services/adminDbConsole.ts.
export type AdminDbColumn = {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
};
export type AdminDbTable = {
  name: string;
  columns: AdminDbColumn[];
  rowCount: number | null;
};
export type AdminDbSchema = {
  driver: "sqlite" | "postgres";
  tables: AdminDbTable[];
};
export type AdminQueryResult = {
  kind: "read" | "write";
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affectedRows: number | null;
  truncated: boolean;
  elapsedMs: number;
};

export type HomeData = {
  notifications: Notification[];
  unreadNotificationCount: number;
  myTodos: HomeTodo[];
  myTodoCount: number;
  reviewTodos: HomeTodo[];
  reviewTodoCount: number;
  approvals: HomeApproval[];
  pendingApprovalCount: number;
  unreadChannels: HomeChannel[];
  journalToday: { entries: number; employees: number };
  failedRuns: HomeFailedRun[];
  failedRunCount: number;
  systemHealth: SystemHealthSummary;
  counts: { employees: number; projects: number };
};

// ─────────────────────────── Finance (M19) ──────────────────────────────

export type CustomerContact = {
  id: string;
  companyId: string;
  customerId: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CustomerContactDraft = {
  name: string;
  email?: string;
  phone?: string;
  role?: string;
  isPrimary?: boolean;
  sortOrder?: number;
};

export type Customer = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  billingAddress: string;
  shippingAddress: string;
  taxNumber: string;
  currency: string;
  /** Annual Contract Value in minor units of `currency`. 0 means unset. */
  annualContractValueCents: number;
  notes: string;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Additional people at this account. Populated by GET /customers and
   *  GET /customers/:slug; empty array when none have been added. */
  contacts: CustomerContact[];
};

/** A signed agreement uploaded against a customer (the Customers section).
 *  `customer` is a lightweight stub the list endpoint attaches; null when the
 *  contract isn't linked to an account. */
export type CustomerContract = {
  id: string;
  companyId: string;
  customerId: string | null;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  signedAt: string | null;
  notes: string;
  uploadedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; name: string; slug: string } | null;
};

// ───────────────────────── Customer statement ──────────────────────────

export type StatementTxnKind = "invoice" | "payment";

export type StatementTxn = {
  date: string;
  kind: StatementTxnKind;
  reference: string;
  description: string;
  invoiceSlug: string | null;
  chargeCents: number;
  paymentCents: number;
  balanceCents: number;
};

export type StatementAging = {
  currentCents: number;
  d1to30Cents: number;
  d31to60Cents: number;
  d61to90Cents: number;
  d90PlusCents: number;
  totalCents: number;
};

export type CustomerStatement = {
  currency: string;
  fromDate: string | null;
  toDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  totalChargesCents: number;
  totalPaymentsCents: number;
  transactions: StatementTxn[];
  aging: StatementAging;
  availableCurrencies: string[];
};

export type CustomerStatementResponse = {
  customer: { id: string; name: string; slug: string };
  statement: CustomerStatement;
};

export type Product = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  unitPriceCents: number;
  currency: string;
  defaultTaxRateId: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaxRate = {
  id: string;
  companyId: string;
  name: string;
  ratePercent: number;
  inclusive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export type InvoicePaymentMethod = "cash" | "bank_transfer" | "stripe" | "lightning" | "other";

export type InvoiceLineItem = {
  id: string;
  invoiceId: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
  lineSubtotalCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
  sortOrder: number;
};

export type InvoicePayment = {
  id: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  method: InvoicePaymentMethod;
  reference: string;
  notes: string;
  createdById: string | null;
  createdAt: string;
};

export type InvoiceCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

export type Invoice = {
  id: string;
  companyId: string;
  customerId: string;
  slug: string;
  numberSeq: number;
  number: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  writtenOffCents: number;
  balanceCents: number;
  notes: string;
  footer: string;
  sentAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  customer: InvoiceCustomerStub | null;
  lines: InvoiceLineItem[];
  payments: InvoicePayment[];
};

export type InvoiceWriteOffKind = "bad_debt" | "residual";

export type InvoiceWriteOff = {
  id: string;
  invoiceId: string;
  kind: InvoiceWriteOffKind;
  amountCents: number;
  homeCents: number;
  currency: string;
  expenseAccountId: string;
  writeOffDate: string;
  note: string;
  createdById: string | null;
  reversedAt: string | null;
  reversedById: string | null;
  createdAt: string;
};

export type InvoiceListItem = Omit<Invoice, "lines" | "payments"> & {
  linesCount: number;
  paymentsCount: number;
};

export type InvoiceLineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

export function formatMoney(cents: number, currency: string): string {
  const c = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: c,
      currencyDisplay: "symbol",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${c}`;
  }
}

export function parseMoneyToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function displayInvoiceStatus(
  inv: Pick<Invoice, "status" | "dueDate" | "paidCents" | "writtenOffCents">,
  now: Date = new Date(),
): InvoiceStatus | "overdue" | "written_off" {
  // Settled with no cash against it ⇒ cleared by a write-off. Mirrors the
  // server's displayStatus so list and detail agree.
  if (inv.status === "paid" && inv.paidCents === 0 && inv.writtenOffCents > 0) {
    return "written_off";
  }
  if (inv.status === "sent" && new Date(inv.dueDate).getTime() < now.getTime()) {
    return "overdue";
  }
  return inv.status;
}

// ───────────────────────── Recurring invoices ──────────────────────────

export type RecurringInvoiceStatus = "active" | "paused" | "ended";

export type RecurringInvoiceFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export type RecurringInvoiceLineItem = {
  id: string;
  recurringInvoiceId: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
  sortOrder: number;
};

export type RecurringInvoiceCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

export type RecurringInvoice = {
  id: string;
  companyId: string;
  customerId: string;
  slug: string;
  name: string;
  cronExpr: string;
  frequency: RecurringInvoiceFrequency;
  intervalCount: number;
  status: RecurringInvoiceStatus;
  daysUntilDue: number;
  autoSend: boolean;
  currency: string;
  notes: string;
  footer: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastInvoiceSlug: string;
  runsCreated: number;
  maxRuns: number | null;
  endsOn: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  customer: RecurringInvoiceCustomerStub | null;
  lines: RecurringInvoiceLineItem[];
};

export type RecurringInvoiceListItem = Omit<RecurringInvoice, "lines"> & {
  linesCount: number;
};

export type RecurringInvoiceLineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

// ──────────────────────────── Estimates ─────────────────────────────────

export type EstimateStatus = "draft" | "sent" | "accepted" | "declined" | "void";

export type EstimateLineItem = {
  id: string;
  estimateId: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
  lineSubtotalCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
  sortOrder: number;
};

export type EstimateCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

export type EstimateInvoiceStub = {
  id: string;
  slug: string;
  number: string;
  status: string;
};

export type Estimate = {
  id: string;
  companyId: string;
  customerId: string;
  slug: string;
  numberSeq: number;
  number: string;
  status: EstimateStatus;
  issueDate: string;
  validUntil: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string;
  footer: string;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  invoiceId: string | null;
  convertedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  customer: EstimateCustomerStub | null;
  lines: EstimateLineItem[];
  invoice: EstimateInvoiceStub | null;
};

export type EstimateListItem = Omit<Estimate, "lines"> & {
  linesCount: number;
};

export type EstimateLineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

export type DisplayEstimateStatus = EstimateStatus | "expired" | "invoiced";

export function displayEstimateStatus(
  est: Pick<Estimate, "status" | "validUntil" | "invoiceId">,
  now: Date = new Date(),
): DisplayEstimateStatus {
  if (est.invoiceId) return "invoiced";
  if (
    (est.status === "sent" || est.status === "accepted") &&
    new Date(est.validUntil).getTime() < now.getTime()
  ) {
    return "expired";
  }
  return est.status;
}

// ─────────────────────────── Ledger (M19 Phase B) ───────────────────────

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export type Account = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isSystem: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEntrySource =
  | "manual"
  | "invoice_issue"
  | "invoice_payment"
  | "invoice_void"
  // Mirror of server/db/entities/LedgerEntry.ts — keep the two in step.
  | "credit_note_issue"
  | "credit_note_apply"
  | "credit_note_unapply"
  | "credit_note_void"
  | "customer_refund"
  | "customer_refund_void"
  | "invoice_writeoff"
  | "invoice_writeoff_reversal"
  | "brex_card_expense"
  | "brex_card_refund"
  | "brex_card_payment"
  | "brex_card_reclass"
  | "ledger_reclass";

export type LedgerReviewStatus = "unreviewed" | "ai_reviewed" | "approved";

export type LedgerReviewChange = {
  lineId: string;
  fromAccountId: string;
  toAccountId: string;
};

export type LedgerLine = {
  id: string;
  ledgerEntryId: string;
  companyId: string;
  accountId: string;
  debitCents: number;
  creditCents: number;
  description: string;
  sortOrder: number;
};

export type LedgerEntry = {
  id: string;
  companyId: string;
  date: string;
  memo: string;
  source: LedgerEntrySource;
  sourceRefId: string | null;
  createdById: string | null;
  reviewStatus: LedgerReviewStatus;
  reviewChangesJson: string | null;
  reviewChanges: LedgerReviewChange[];
  reviewNote: string | null;
  reviewedByEmployeeId: string | null;
  reviewedByEmployee: { id: string; name: string; slug: string } | null;
  reviewedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
  lines: LedgerLine[];
  totalCents: number;
};

export type LedgerLineDraft = {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  description?: string;
};

export type LedgerBulkAction = "approve" | "return" | "delete" | "recategorize";

export type LedgerBulkResult = {
  action: LedgerBulkAction;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

export type TrialBalanceRow = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

export type TrialBalanceResponse = {
  asOf: string;
  rows: TrialBalanceRow[];
};

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

/** Display the cent magnitude in the conventional accounting layout —
 *  no minus signs in the trial balance, since the column itself
 *  encodes whether a value is a debit or a credit. */
export function formatBalanceMagnitude(cents: number, currency: string): string {
  return formatMoney(Math.abs(cents), currency);
}

// ─────────────────────────── Reports (M19 Phase C) ──────────────────────

export type ReportRow = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  amountCents: number;
};

export type IncomeStatementReport = {
  from: string;
  to: string;
  revenue: ReportRow[];
  totalRevenue: number;
  expenses: ReportRow[];
  totalExpenses: number;
  netIncome: number;
};

export type BalanceSheetReport = {
  asOf: string;
  assets: ReportRow[];
  totalAssets: number;
  liabilities: ReportRow[];
  totalLiabilities: number;
  equity: ReportRow[];
  currentEarnings: number;
  totalEquity: number;
};

export type CashFlowSection = {
  label: string;
  lines: { description: string; cents: number; entryId: string }[];
  total: number;
};

export type CashFlowReport = {
  from: string;
  to: string;
  openingBalance: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: number;
  closingBalance: number;
};

export type AccountActivityRow = {
  entryId: string;
  date: string;
  source: LedgerEntrySource;
  memo: string;
  description: string;
  debitCents: number;
  creditCents: number;
  runningBalanceCents: number;
};

export type AccountActivityReport = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  from: string | null;
  to: string | null;
  openingBalance: number;
  rows: AccountActivityRow[];
  closingBalance: number;
};

export type ReportEnvelope<T> = { current: T; prior: T | null };

export type FinancialTrendPoint = {
  label: string;
  from: string;
  to: string;
  revenue: number;
  expenses: number;
  netIncome: number;
  assets: number;
  liabilities: number;
  equity: number;
  operatingCash: number;
  investingCash: number;
  financingCash: number;
  netCash: number;
  closingCash: number;
};

export type FinancialTrendsReport = {
  from: string;
  to: string;
  truncated: boolean;
  points: FinancialTrendPoint[];
};

// ─────────────────────── Period preset helper ──────────────────────────

export type PeriodPreset =
  | "this_month"
  | "this_quarter"
  | "this_year"
  | "last_month"
  | "last_quarter"
  | "last_year"
  | "custom";

export type PeriodRange = { from: Date; to: Date };

/**
 * Resolve a preset into a [from, to] date range based on `now`. All
 * ranges are inclusive on both ends. UTC throughout — the server
 * normalizes to start/end-of-day, so the timezone of `now` doesn't
 * matter to the math.
 */
export function rangeFromPreset(preset: PeriodPreset, now: Date = new Date()): PeriodRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = new Date(Date.UTC(y, m, now.getUTCDate()));
  switch (preset) {
    case "this_month":
      return {
        from: new Date(Date.UTC(y, m, 1)),
        to: today,
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return {
        from: new Date(Date.UTC(y, qStart, 1)),
        to: today,
      };
    }
    case "this_year":
      return {
        from: new Date(Date.UTC(y, 0, 1)),
        to: today,
      };
    case "last_month":
      return {
        from: new Date(Date.UTC(y, m - 1, 1)),
        to: new Date(Date.UTC(y, m, 0)),
      };
    case "last_quarter": {
      const qStart = Math.floor(m / 3) * 3 - 3;
      return {
        from: new Date(Date.UTC(y, qStart, 1)),
        to: new Date(Date.UTC(y, qStart + 3, 0)),
      };
    }
    case "last_year":
      return {
        from: new Date(Date.UTC(y - 1, 0, 1)),
        to: new Date(Date.UTC(y - 1, 11, 31)),
      };
    case "custom":
      // Caller picks; default to YTD.
      return {
        from: new Date(Date.UTC(y, 0, 1)),
        to: today,
      };
  }
}

/** Compute the immediately-prior equal-length range. Used as the
 *  default for the "compare to prior period" toggle. */
export function priorRangeOf(range: PeriodRange): PeriodRange {
  const span = range.to.getTime() - range.from.getTime();
  return {
    from: new Date(range.from.getTime() - span - 24 * 60 * 60 * 1000),
    to: new Date(range.from.getTime() - 24 * 60 * 60 * 1000),
  };
}

// ─────────────────────── Reconciliation (M19 Phase D) ──────────────────

export type BankFeedKind = "stripe_payouts" | "brex_cash" | "csv";

export type BankFeed = {
  id: string;
  companyId: string;
  name: string;
  kind: BankFeedKind;
  connectionId: string | null;
  externalAccountId: string | null;
  accountId: string;
  lastSyncAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrexCashAccount = {
  id: string;
  name: string;
  status: string | null;
  primary: boolean;
  accountNumberLast4: string;
  currentBalance: { amount: number; currency: string | null };
  availableBalance: { amount: number; currency: string | null };
};

export type CardFeed = {
  id: string;
  companyId: string;
  name: string;
  kind: "brex_card";
  connectionId: string;
  liabilityAccountId: string;
  defaultExpenseAccountId: string;
  paymentAccountId: string;
  lastSyncAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CardAccountingKind = "expense" | "refund" | "payment";

export type CardTransaction = {
  id: string;
  companyId: string;
  feedId: string;
  externalId: string;
  cardId: string | null;
  postedAt: string;
  amountCents: number;
  currency: string;
  description: string;
  providerType: string;
  accountingKind: CardAccountingKind;
  expenseAccountId: string | null;
  ledgerEntryId: string | null;
  postingError: string;
  raw: string;
  reclassifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CardSyncResult = {
  inserted: number;
  posted: number;
  failed: number;
};

export type BankTransactionMatch =
  | {
      kind: "payment";
      paymentId: string;
      invoiceNumber: string;
      invoiceSlug: string;
      customerName: string;
    }
  | { kind: "ledger_entry"; entryId: string; memo: string };

export type BankTransaction = {
  id: string;
  companyId: string;
  feedId: string;
  externalId: string | null;
  date: string;
  amountCents: number;
  description: string;
  reference: string;
  raw: string;
  matchedPaymentId: string | null;
  matchedLedgerEntryId: string | null;
  reconciledAt: string | null;
  reconciledById: string | null;
  createdAt: string;
  match: BankTransactionMatch | null;
};

export type MatchCandidate = {
  kind: "payment";
  paymentId: string;
  invoiceNumber: string;
  invoiceSlug: string;
  customerName: string;
  amountCents: number;
  paidAt: string;
  method: string;
  score: number;
};

// ─────────────────────── Multi-currency (M19 Phase E) ──────────────────

export type Currency = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  createdAt: string;
};

export type ExchangeRate = {
  id: string;
  companyId: string;
  fromCurrency: string;
  toCurrency: string;
  date: string;
  rate: number;
  source: string;
  createdAt: string;
};

export type CompanyFinanceSettings = {
  id: string;
  companyId: string;
  homeCurrency: string;
  /** Multi-line text rendered in the "From" column on every invoice
   *  and estimate. Empty means fall back to the bare company name. */
  defaultFromBlock: string;
  /** Default printable footer for invoices and estimates that don't
   *  have one of their own. Per-doc footers always win. */
  defaultFooter: string;
  /** Internal recipients copied on every invoice email. */
  invoiceCcEmails: string[];
  createdAt: string;
  updatedAt: string;
};

// ─────────────────────── Period close (M19 Phase F) ────────────────────

export type AccountingPeriodStatus = "open" | "closed";

export type AccountingPeriod = {
  id: string;
  companyId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: AccountingPeriodStatus;
  closedAt: string | null;
  closedById: string | null;
  closingEntryId: string | null;
  createdAt: string;
};

// ─────────────────────── Vendors + Bills (M19 Phase G) ─────────────────

export type Vendor = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  address: string;
  taxNumber: string;
  currency: string;
  notes: string;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillStatus = "draft" | "sent" | "paid" | "void";
export type BillPaymentMethod = InvoicePaymentMethod;

export type BillLineItem = {
  id: string;
  billId: string;
  expenseAccountId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
  lineSubtotalCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
  sortOrder: number;
};

export type BillPayment = {
  id: string;
  billId: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  method: BillPaymentMethod;
  reference: string;
  notes: string;
  createdById: string | null;
  createdAt: string;
};

export type VendorStub = { id: string; name: string; slug: string };

export type Bill = {
  id: string;
  companyId: string;
  vendorId: string;
  slug: string;
  numberSeq: number;
  number: string;
  vendorRef: string;
  status: BillStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  notes: string;
  receivedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  vendor: VendorStub | null;
  lines: BillLineItem[];
  payments: BillPayment[];
};

export type BillListItem = Omit<Bill, "lines" | "payments"> & {
  linesCount: number;
  paymentsCount: number;
};

export type BillLineDraft = {
  expenseAccountId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

export function displayBillStatus(
  bill: Pick<Bill, "status" | "dueDate">,
  now: Date = new Date(),
): BillStatus | "overdue" {
  if (bill.status === "sent" && new Date(bill.dueDate).getTime() < now.getTime()) {
    return "overdue";
  }
  return bill.status;
}

// ───────────────────────── Company search (⌘K palette) ──────────────────

export type SearchResultKind =
  | "employee"
  | "skill"
  | "routine"
  | "channel"
  | "project"
  | "todo"
  | "base"
  | "notebook"
  | "note"
  | "resource"
  | "chart"
  | "dashboard"
  | "repo"
  | "pipeline"
  | "customer";

export type CompanySearchResult = {
  kind: SearchResultKind;
  id: string;
  label: string;
  sublabel: string | null;
  /** Route under `/c/<companySlug>` that opens this result. */
  path: string;
};
