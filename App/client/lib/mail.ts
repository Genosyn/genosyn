import { api, MessageAction } from "./api";

/**
 * Types + REST client for the Email section (M25). Kept out of `lib/api.ts`
 * the same way workspace chat lives in `lib/workspace.ts` — one domain, one
 * module.
 */

export type MailAccount = {
  id: string;
  connectionId: string;
  /** Which backend drives this mailbox. */
  provider: "gmail" | "imap";
  address: string;
  status: "active" | "paused" | "error";
  statusMessage: string;
  lastSyncAt: string | null;
  syncState: "idle" | "queued" | "running" | "succeeded" | "failed";
  syncAttemptId: string | null;
  syncStartedAt: string | null;
  syncFinishedAt: string | null;
  backfilledAt: string | null;
  backfilledCount: number;
  /** AI triage of newly-arrived mail. On unless a Member turned it off. */
  aiAnalysisEnabled: boolean;
  /** Null = "whichever granted employee is best placed", resolved per email. */
  aiAnalysisEmployeeId: string | null;
  /** Null inherits the employee's active model. */
  aiAnalysisModelId: string | null;
  createdAt: string;
};

export type StagedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailLabelInfo = {
  id: string;
  gmailLabelId: string;
  name: string;
  labelType: "system" | "user";
  color: string;
  threadCount: number;
};

export type MailCounts = { inboxUnread: number; drafts: number; starred: number };

export type MailThread = {
  id: string;
  gmailThreadId: string;
  accountId: string;
  subject: string;
  snippet: string;
  participants: string;
  labelIds: string[];
  unread: boolean;
  messageCount: number;
  hasAttachments: boolean;
  lastMessageAt: string | null;
};

export type MailAttachment = {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailMessage = {
  id: string;
  threadId: string;
  gmailMessageId: string;
  isDraft: boolean;
  fromName: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  bccEmails: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  labelIds: string[];
  sentAt: string | null;
  createdAt: string | null;
  /** Provenance — who wrote this inside Genosyn. A human Member or an AI
   * Employee, never both; routine/run are set only when an employee wrote it
   * while executing a Routine. All null for mail synced in from Gmail. The
   * Drafts queue serves resolved names via {@link MailDraft}. */
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdByRoutineId: string | null;
  createdByRunId: string | null;
  attachments: MailAttachment[];
};

export type MailHandoverMode = "draft" | "reply" | "triage";

export type MailHandover = {
  id: string;
  accountId: string;
  threadId: string;
  threadSubject?: string;
  employee: { id: string; name: string; slug: string; avatarKey?: string | null } | null;
  mode: MailHandoverMode;
  instruction: string;
  status: "pending" | "running" | "completed" | "failed";
  resultSummary: string;
  errorMessage: string;
  sourceKind: "manual" | "rule";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MailRuleConditions = {
  from?: string;
  to?: string;
  subjectContains?: string;
  bodyContains?: string;
  hasAttachment?: boolean;
  ai?: {
    employeeId: string;
    instruction: string;
    employeeName?: string;
  };
};

export type MailRuleAction =
  | { type: "applyLabel"; labelName: string }
  | { type: "markRead" }
  | { type: "star" }
  | { type: "archive" }
  | { type: "unsubscribe" }
  | {
      type: "handToEmployee";
      employeeId: string;
      instruction: string;
      mode: MailHandoverMode;
      employeeName?: string;
    };

export type MailRule = {
  id: string;
  accountId: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: MailRuleConditions;
  actions: MailRuleAction[];
  matchCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
};

export type MailAccessLevel = "read" | "draft" | "send";

export type MailGrant = {
  id: string;
  employeeId: string;
  accessLevel: MailAccessLevel;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey?: string | null;
  } | null;
};

export type MailGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey?: string | null;
  alreadyGranted: boolean;
};

export type MailConnectCandidate = {
  connectionId: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
  /** True when this connection can actually back a mailbox. */
  hasGmailScope: boolean;
  linkedAccountId: string | null;
};

/** One server coordinate on a discovered IMAP route. */
export type MailboxServer = { host: string; port: number; secure: boolean };

/**
 * A way to connect one address, as the server worked it out. Best first —
 * the dialog renders `options[0]` as the primary action.
 */
export type MailboxConnectOption =
  | {
      kind: "oauth";
      provider: "google" | "microsoft";
      label: string;
      scopeGroups: string[];
      instanceApp?: boolean;
      ready: boolean;
      blockedReason?: string;
    }
  | {
      kind: "imap";
      imap: MailboxServer;
      smtp: MailboxServer;
      password: { summary: string; url?: string } | null;
      ready: boolean;
      blockedReason?: string;
    };

export type MailboxConnectPlan = {
  email: string;
  domain: string;
  providerKey: string;
  displayName: string;
  source: "builtin" | "mx" | "srv" | "autoconfig" | "guess";
  options: MailboxConnectOption[];
  /** Set when the provider offers no way in at all. */
  unsupportedReason?: string;
};

export type ImapConnectInput = {
  address: string;
  password: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
};

/** A member's pinned search. `query` is raw search grammar, same as typed. */
export type MailSavedSearch = {
  id: string;
  accountId: string;
  name: string;
  query: string;
  sortOrder: number;
};

export type MailThreadView = "inbox" | "starred" | "sent" | "drafts" | "all" | "spam" | "trash";

export type ThreadActionName =
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  | "archive"
  | "moveToInbox"
  | "trash"
  | "untrash"
  | "applyLabel"
  | "removeLabel";

export type ComposeInput = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText: string;
  threadId?: string;
  attachmentIds?: string[];
};

export type UpdateDraftInput = Omit<ComposeInput, "threadId"> & {
  /**
   * Which files already on the draft survive the edit, by their position in
   * {@link MailMessage.attachments}. Gmail rebuilds a draft from scratch, so
   * this is how the editor keeps them: omit the field to keep them all, pass
   * the indexes still shown to drop the rest.
   */
  keepAttachmentIndexes?: number[];
};

// ───────────────────────────── assistant ─────────────────────────────

/** One structured action button an employee proposed via `suggest_mail_actions`. */
export type MailSuggestion = {
  id: string;
  kind: "reply" | "send_draft" | "thread_action" | "open_thread" | "hand_over" | "create_rule";
  label: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  to?: string;
  cc?: string;
  subject?: string;
  bodyText?: string;
  action?: ThreadActionName;
  labelName?: string;
  employeeId?: string;
  mode?: MailHandoverMode;
  instruction?: string;
  rule?: {
    name: string;
    conditions: MailRuleConditions;
    actions: MailRuleAction[];
  };
  /** Server-verified facts snapshotted at suggest time — what the human sees
   * next to the button is what the server checked, not the model's label. */
  targetTo?: string;
  targetSubject?: string;
  targetEmployeeName?: string;
  executedAt?: string;
};

/** A file on an email-chat turn — uploaded by the human or produced by the AI. */
export type MailAssistantAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export type MailAssistantMessage = {
  id: string;
  accountId: string;
  threadId: string | null;
  role: "user" | "assistant";
  employeeId: string | null;
  /** The AI Model the turn ran on; null on human rows. */
  modelId: string | null;
  content: string;
  /** `working` is an in-flight reply the panel follows until it resolves. */
  status: "working" | "ok" | "skipped" | "error" | null;
  actions: MessageAction[];
  suggestions: MailSuggestion[];
  attachments: MailAssistantAttachment[];
  createdAt: string;
};

/** One brain an employee can answer on, for the panel's model picker. */
export type MailAssistantModel = {
  id: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  isActive: boolean;
};

export type MailAssistantRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  accessLevel: MailAccessLevel | null;
  hasModel: boolean;
  models: MailAssistantModel[];
};

// ───────────────────────── AI analysis of inbound mail ─────────────────────────

/**
 * Categories are a closed set so the chip beside an email means the same thing
 * every morning. Anything the server sends that this list does not know still
 * renders — as a neutral chip — rather than crashing the thread.
 */
export const MAIL_ANALYSIS_CATEGORIES = [
  "invoice_request",
  "quote_request",
  "payment",
  "customer_support",
  "sales_lead",
  "scheduling",
  "vendor",
  "recruiting",
  "marketing",
  "notification",
  "internal",
  "personal",
  "spam",
  "other",
] as const;

export type MailAnalysisCategory = (typeof MAIL_ANALYSIS_CATEGORIES)[number];

/**
 * The button kinds that write to Finance. Mirrors the server list of the same
 * name; `server/client/mailAnalysis.test.ts` fails if the two drift, because a
 * money button the client does not know about would render live and then be
 * refused on the click.
 */
export const MAIL_ANALYSIS_FINANCE_KINDS = ["create_invoice", "create_estimate"] as const;

export type MailAnalysisLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
};

/**
 * One button an AI Employee attached to an email. `label` is the employee's
 * words; every `target*` field is what the server checked at analysis time,
 * and is what the UI shows underneath so the Member approves the verified
 * thing rather than the claim about it.
 */
export type MailAnalysisAction = {
  id: string;
  kind:
    | "draft_reply"
    | "create_invoice"
    | "create_estimate"
    | "unsubscribe"
    | "thread_action"
    | "hand_over";
  label: string;
  bodyText?: string;
  subject?: string;
  customerName?: string;
  currency?: string;
  notes?: string;
  lines?: MailAnalysisLine[];
  action?: "markRead" | "star" | "archive" | "applyLabel";
  labelName?: string;
  employeeId?: string;
  mode?: MailHandoverMode;
  instruction?: string;
  targetTo?: string;
  targetHost?: string;
  targetEmployeeName?: string;
  targetTotalCents?: number;
  executedAt?: string;
};

export type MailAnalysis = {
  id: string;
  threadId: string;
  messageId: string;
  status: "running" | "succeeded" | "failed";
  employeeId: string | null;
  modelId: string | null;
  category: string;
  summary: string;
  actions: MailAnalysisAction[];
  errorMessage: string;
  createdAt: string;
  finishedAt: string | null;
};

/** Who would read the next email to arrive, once every fallback has applied. */
export type MailAnalysisReader = {
  employeeId: string;
  employeeName: string;
  modelId: string;
  modelLabel: string;
  accessLevel: MailAccessLevel;
};

export type MailAnalysisSettings = {
  enabled: boolean;
  employeeId: string | null;
  modelId: string | null;
  roster: MailAssistantRosterEntry[];
  resolved: MailAnalysisReader | null;
};

// ───────────────────────────── drafts review queue ─────────────────────────────

/** Who wrote a draft inside Genosyn, resolved to names by the server. */
export type MailDraftAuthor =
  | {
      kind: "employee";
      employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null };
      routine: { id: string; name: string; slug: string } | null;
      runId: string | null;
    }
  | { kind: "member"; member: { id: string; name: string; avatarKey: string | null } }
  | { kind: "none" };

export type MailDraft = {
  id: string;
  threadId: string;
  subject: string;
  toEmails: string;
  ccEmails: string;
  snippet: string;
  bodyPreview: string;
  hasAttachments: boolean;
  missingRecipient: boolean;
  queuedForSend: boolean;
  createdAt: string | null;
  author: MailDraftAuthor;
};

export type MailDraftFacet = { id: string | null; name: string; count: number };

export type MailDraftFilter = {
  employeeId?: string;
  routineId?: string;
  q?: string;
  onlyMissingRecipient?: boolean;
  unattributed?: boolean;
  /** Only drafts that can actually be sent — see the server's DraftFilter. */
  sendableOnly?: boolean;
};

/**
 * Either the rows someone ticked, or "everything matching this filter" minus
 * the ones they un-ticked — which is how selecting all 320 drafts works without
 * the browser ever holding 320 rows.
 */
export type MailDraftSelection = { ids: string[] } | { filter: MailDraftFilter; exclude: string[] };

export type MailDraftList = {
  drafts: MailDraft[];
  /** Offset for the next page, or null when this was the last one. */
  nextOffset: number | null;
  facets: { employees: MailDraftFacet[]; routines: MailDraftFacet[] };
  totals: { total: number; sendable: number; missingRecipient: number; queued: number };
};

export type MailDraftSendPreview = {
  accountAddress: string;
  total: number;
  sendable: number;
  missingRecipient: number;
  alreadyQueued: number;
  byEmployee: MailDraftFacet[];
  byRoutine: MailDraftFacet[];
  sampleRecipients: string[];
  /** Every draft in the selection — what a discard acts on. */
  ids: string[];
  /** The subset carrying a recipient — what a send acts on. */
  sendableIds: string[];
  truncated: boolean;
};

/** Per-item outcome of any bulk mail call — nothing fails silently. */
export type MailBulkResult = {
  succeeded: string[];
  skipped: { id: string; reason: string }[];
};

export type MailBulkDraftResult = MailBulkResult;

export type MailDraftSendBatch = {
  id: string;
  status: "queued" | "running" | "completed" | "completed_with_errors";
  total: number;
  sent: number;
  failed: number;
  remaining: number;
  nextSendAt: string | null;
  estimatedCompletionAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  queuedDraftIds: string[];
  failures: { id: string; reason: string }[];
};

/**
 * Threads per bulk request; must not exceed the server's
 * `MAX_BULK_THREAD_IDS`. Each thread costs a Gmail modify plus a refetch, so
 * large selections are chunked rather than sent as one long request.
 */
export const THREAD_BULK_CHUNK = 50;

/**
 * How many drafts are discarded per request. Sends use the durable paced queue;
 * discards stay chunked so one request cannot hold a proxy open indefinitely.
 */
export const DRAFT_DISCARD_CHUNK = 25;

const base = (companyId: string) => `/api/companies/${companyId}/mail`;

export const mailApi = {
  accounts: (cid: string) => api.get<{ accounts: MailAccount[] }>(`${base(cid)}/accounts`),
  connectCandidates: (cid: string) =>
    api.get<{ candidates: MailConnectCandidate[] }>(`${base(cid)}/connect-candidates`),
  connectAccount: (cid: string, connectionId: string) =>
    api.post<{ account: MailAccount }>(`${base(cid)}/accounts`, { connectionId }),
  /** What will work for this address on this install. Reads and writes nothing. */
  discoverConnect: (cid: string, email: string) =>
    api.post<{ plan: MailboxConnectPlan }>(`${base(cid)}/connect/discover`, { email }),
  /** Credential, Connection and mailbox in one call. */
  connectImap: (cid: string, input: ImapConnectInput) =>
    api.post<{ account: MailAccount }>(`${base(cid)}/connect/imap`, input),
  account: (cid: string, aid: string) =>
    api.get<{ account: MailAccount }>(`${base(cid)}/accounts/${aid}`),
  patchAccount: (cid: string, aid: string, status: "active" | "paused") =>
    api.patch<{ account: MailAccount }>(`${base(cid)}/accounts/${aid}`, { status }),
  deleteAccount: (cid: string, aid: string) =>
    api.del<{ ok: true }>(`${base(cid)}/accounts/${aid}`),
  syncNow: (cid: string, aid: string) =>
    api.post<{
      sync: {
        attemptId: string;
        state: MailAccount["syncState"];
        coalesced: boolean;
      };
    }>(`${base(cid)}/accounts/${aid}/sync`, {}),

  labels: (cid: string, aid: string) =>
    api.get<{ labels: MailLabelInfo[]; counts: MailCounts }>(`${base(cid)}/accounts/${aid}/labels`),

  threads: (
    cid: string,
    aid: string,
    opts: {
      view?: MailThreadView;
      label?: string;
      q?: string;
      before?: string;
      limit?: number;
    },
  ) => {
    const qs = new URLSearchParams();
    if (opts.view) qs.set("view", opts.view);
    if (opts.label) qs.set("label", opts.label);
    if (opts.q) qs.set("q", opts.q);
    if (opts.before) qs.set("before", opts.before);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return api.get<{ threads: MailThread[]; nextBefore: string | null }>(
      `${base(cid)}/accounts/${aid}/threads?${qs.toString()}`,
    );
  },

  thread: (cid: string, tid: string) =>
    api.get<{
      thread: MailThread;
      account: { id: string; address: string };
      messages: MailMessage[];
      handovers: MailHandover[];
      analyses: MailAnalysis[];
    }>(`${base(cid)}/threads/${tid}`),

  threadAction: (
    cid: string,
    tid: string,
    action: ThreadActionName,
    opts: { labelId?: string; labelName?: string } = {},
  ) =>
    api.post<{ thread: MailThread | null }>(`${base(cid)}/threads/${tid}/actions`, {
      action,
      ...opts,
    }),

  /** One action across many threads. Callers chunk by {@link THREAD_BULK_CHUNK}. */
  threadActionBulk: (
    cid: string,
    aid: string,
    input: {
      action: ThreadActionName;
      ids: string[];
      labelId?: string;
      labelName?: string;
    },
  ) => api.post<MailBulkResult>(`${base(cid)}/accounts/${aid}/threads/bulk`, input),

  replyRecipients: (cid: string, tid: string) =>
    api.get<{ to: string; cc: string }>(`${base(cid)}/threads/${tid}/reply-recipients`),

  send: (cid: string, aid: string, input: ComposeInput) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/accounts/${aid}/send`, input),
  createDraft: (cid: string, aid: string, input: ComposeInput) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/accounts/${aid}/drafts`, input),
  /** `keepAttachmentIndexes` — see {@link UpdateDraftInput}. */
  updateDraft: (cid: string, mid: string, input: UpdateDraftInput) =>
    api.patch<{ message: MailMessage }>(`${base(cid)}/drafts/${mid}`, input),
  sendDraft: (cid: string, mid: string) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/drafts/${mid}/send`, {}),
  discardDraft: (cid: string, mid: string) => api.del<{ ok: true }>(`${base(cid)}/drafts/${mid}`),

  /** The review queue: one row per draft, attributed, filterable, paginated. */
  drafts: (
    cid: string,
    aid: string,
    opts: MailDraftFilter & { offset?: number; limit?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.employeeId) qs.set("employeeId", opts.employeeId);
    if (opts.routineId) qs.set("routineId", opts.routineId);
    if (opts.q) qs.set("q", opts.q);
    if (opts.onlyMissingRecipient) qs.set("missingRecipient", "1");
    if (opts.unattributed) qs.set("unattributed", "1");
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.limit) qs.set("limit", String(opts.limit));
    return api.get<MailDraftList>(`${base(cid)}/accounts/${aid}/drafts?${qs.toString()}`);
  },
  /** Resolve a selection and report what sending it would do — without sending. */
  draftsSendPreview: (cid: string, aid: string, selection: MailDraftSelection) =>
    api.post<MailDraftSendPreview>(`${base(cid)}/accounts/${aid}/drafts/send-preview`, selection),
  /** One discard batch. Callers chunk by {@link DRAFT_DISCARD_CHUNK}. */
  draftsBulk: (cid: string, aid: string, input: { action: "discard"; ids: string[] }) =>
    api.post<MailBulkDraftResult>(`${base(cid)}/accounts/${aid}/drafts/bulk`, input),
  draftSendQueue: (cid: string, aid: string) =>
    api.get<{ batch: MailDraftSendBatch | null }>(`${base(cid)}/accounts/${aid}/drafts/send-queue`),
  queueDraftsForSend: (cid: string, aid: string, ids: string[]) =>
    api.post<{ batch: MailDraftSendBatch; added: number }>(
      `${base(cid)}/accounts/${aid}/drafts/send-queue`,
      { ids },
    ),

  attachmentUrl: (cid: string, mid: string, index: number) =>
    `${base(cid)}/messages/${mid}/attachments/${index}`,
  uploadAttachment: (cid: string, aid: string, file: File) =>
    api
      .uploadFile<{
        attachment: StagedAttachment;
      }>(`${base(cid)}/accounts/${aid}/outbox-attachments`, file)
      .then((r) => r.attachment),

  savedSearches: (cid: string, aid: string) =>
    api.get<{ savedSearches: MailSavedSearch[] }>(`${base(cid)}/accounts/${aid}/saved-searches`),
  createSavedSearch: (cid: string, aid: string, input: { name: string; query: string }) =>
    api.post<{ savedSearch: MailSavedSearch }>(
      `${base(cid)}/accounts/${aid}/saved-searches`,
      input,
    ),
  patchSavedSearch: (
    cid: string,
    sid: string,
    input: Partial<{ name: string; query: string; sortOrder: number }>,
  ) => api.patch<{ savedSearch: MailSavedSearch }>(`${base(cid)}/saved-searches/${sid}`, input),
  deleteSavedSearch: (cid: string, sid: string) =>
    api.del<{ ok: true }>(`${base(cid)}/saved-searches/${sid}`),

  rules: (cid: string, aid: string) =>
    api.get<{ rules: MailRule[] }>(`${base(cid)}/accounts/${aid}/rules`),
  createRule: (
    cid: string,
    aid: string,
    input: {
      name: string;
      enabled: boolean;
      conditions: MailRuleConditions;
      actions: MailRuleAction[];
    },
  ) => api.post<{ rule: MailRule }>(`${base(cid)}/accounts/${aid}/rules`, input),
  patchRule: (
    cid: string,
    rid: string,
    input: Partial<{
      name: string;
      enabled: boolean;
      position: number;
      conditions: MailRuleConditions;
      actions: MailRuleAction[];
    }>,
  ) => api.patch<{ rule: MailRule }>(`${base(cid)}/rules/${rid}`, input),
  deleteRule: (cid: string, rid: string) => api.del<{ ok: true }>(`${base(cid)}/rules/${rid}`),

  handovers: (cid: string, aid: string, threadId?: string) =>
    api.get<{ handovers: MailHandover[] }>(
      `${base(cid)}/accounts/${aid}/handovers${threadId ? `?threadId=${threadId}` : ""}`,
    ),
  createHandover: (
    cid: string,
    tid: string,
    input: { employeeId: string; instruction: string; mode: MailHandoverMode },
  ) => api.post<{ handover: MailHandover }>(`${base(cid)}/threads/${tid}/handovers`, input),
  retryHandover: (cid: string, hid: string) =>
    api.post<{ ok: true }>(`${base(cid)}/handovers/${hid}/retry`, {}),

  // ── AI analysis of inbound mail ──
  analysisSettings: (cid: string, aid: string) =>
    api.get<MailAnalysisSettings>(`${base(cid)}/accounts/${aid}/ai-analysis`),
  patchAnalysisSettings: (
    cid: string,
    aid: string,
    input: { enabled?: boolean; employeeId?: string | null; modelId?: string | null },
  ) =>
    api.patch<{ account: MailAccount; resolved: MailAnalysisReader | null }>(
      `${base(cid)}/accounts/${aid}/ai-analysis`,
      input,
    ),
  /** Read one message again — after a model outage, or a wrong first verdict. */
  analyzeMessage: (cid: string, mid: string) =>
    api.post<{ analysis: MailAnalysis }>(`${base(cid)}/messages/${mid}/analyze`, {}),
  /** Press one of the buttons. Runs with the Member's own authority. */
  runAnalysisAction: (cid: string, analysisId: string, actionId: string) =>
    api.post<{ analysis: MailAnalysis; navigateTo: string | null; message: string }>(
      `${base(cid)}/analyses/${analysisId}/actions/${encodeURIComponent(actionId)}`,
      {},
    ),

  grants: (cid: string, aid: string) =>
    api.get<{ direct: MailGrant[] }>(`${base(cid)}/accounts/${aid}/grants`),
  createGrant: (
    cid: string,
    aid: string,
    input: { employeeId: string; accessLevel: MailAccessLevel },
  ) => api.post<{ grant: MailGrant }>(`${base(cid)}/accounts/${aid}/grants`, input),
  patchGrant: (cid: string, aid: string, gid: string, accessLevel: MailAccessLevel) =>
    api.patch<{ grant: MailGrant }>(`${base(cid)}/accounts/${aid}/grants/${gid}`, {
      accessLevel,
    }),
  deleteGrant: (cid: string, aid: string, gid: string) =>
    api.del<{ ok: true }>(`${base(cid)}/accounts/${aid}/grants/${gid}`),
  grantCandidates: (cid: string, aid: string) =>
    api.get<{ candidates: MailGrantCandidate[] }>(`${base(cid)}/accounts/${aid}/grant-candidates`),

  assistant: (cid: string, aid: string, threadId: string) =>
    api.get<{
      messages: MailAssistantMessage[];
      roster: MailAssistantRosterEntry[];
      /** The model the last answered turn ran on, when it is still usable. */
      modelId: string | null;
    }>(`${base(cid)}/accounts/${aid}/assistant?threadId=${encodeURIComponent(threadId)}`),
  assistantSend: (
    cid: string,
    aid: string,
    input: {
      message: string;
      threadId: string;
      focusedMessageId?: string;
      employeeId?: string;
      attachmentIds?: string[];
      modelId?: string | null;
    },
    onEvent: (event: string, data: unknown) => void,
    opts: { signal?: AbortSignal } = {},
  ) => api.stream(`${base(cid)}/accounts/${aid}/assistant/messages`, input, onEvent, opts),
  /** Upload a file into an email's AI chat; the id travels with the next send. */
  assistantUpload: (cid: string, aid: string, file: File) =>
    api
      .uploadFile<{
        attachment: MailAssistantAttachment;
      }>(`${base(cid)}/accounts/${aid}/assistant/attachments`, file)
      .then((r) => r.attachment),
  assistantAttachmentUrl: (cid: string, aid: string, attachmentId: string) =>
    `${base(cid)}/accounts/${aid}/assistant/attachments/${attachmentId}`,
  assistantClear: (cid: string, aid: string, threadId: string) =>
    api.del<{ ok: true }>(
      `${base(cid)}/accounts/${aid}/assistant/messages?threadId=${encodeURIComponent(threadId)}`,
    ),
  assistantMarkExecuted: (cid: string, mid: string, sid: string) =>
    api.post<{ message: MailAssistantMessage }>(
      `${base(cid)}/assistant/messages/${mid}/suggestions/${sid}/executed`,
      {},
    ),
};

/** "2h ago"-style short timestamp for thread rows. */
export function shortMailDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

/** Full, unambiguous timestamp for mailbox sync status. */
export function mailSyncDate(iso: string | null): string {
  if (!iso) return "Not synced yet";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
