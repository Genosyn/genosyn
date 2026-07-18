import { api, MessageAction } from "./api";

/**
 * Types + REST client for the Email section (M25). Kept out of `lib/api.ts`
 * the same way workspace chat lives in `lib/workspace.ts` — one domain, one
 * module.
 */

export type MailAccount = {
  id: string;
  connectionId: string;
  address: string;
  status: "active" | "paused" | "error";
  statusMessage: string;
  lastSyncAt: string | null;
  backfilledAt: string | null;
  backfilledCount: number;
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
};

export type MailRuleAction =
  | { type: "applyLabel"; labelName: string }
  | { type: "markRead" }
  | { type: "star" }
  | { type: "archive" }
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
  label: string;
  accountHint: string;
  status: string;
  hasGmailScope: boolean;
  linkedAccountId: string | null;
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

export type MailAssistantMessage = {
  id: string;
  accountId: string;
  threadId: string | null;
  role: "user" | "assistant";
  employeeId: string | null;
  content: string;
  status: "ok" | "skipped" | "error" | null;
  actions: MessageAction[];
  suggestions: MailSuggestion[];
  createdAt: string;
};

export type MailAssistantRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  accessLevel: MailAccessLevel | null;
  hasModel: boolean;
};

const base = (companyId: string) => `/api/companies/${companyId}/mail`;

export const mailApi = {
  accounts: (cid: string) => api.get<{ accounts: MailAccount[] }>(`${base(cid)}/accounts`),
  connectCandidates: (cid: string) =>
    api.get<{ candidates: MailConnectCandidate[] }>(`${base(cid)}/connect-candidates`),
  connectAccount: (cid: string, connectionId: string) =>
    api.post<{ account: MailAccount }>(`${base(cid)}/accounts`, { connectionId }),
  account: (cid: string, aid: string) =>
    api.get<{ account: MailAccount }>(`${base(cid)}/accounts/${aid}`),
  patchAccount: (cid: string, aid: string, status: "active" | "paused") =>
    api.patch<{ account: MailAccount }>(`${base(cid)}/accounts/${aid}`, { status }),
  deleteAccount: (cid: string, aid: string) =>
    api.del<{ ok: true }>(`${base(cid)}/accounts/${aid}`),
  syncNow: (cid: string, aid: string) =>
    api.post<{ ok: true }>(`${base(cid)}/accounts/${aid}/sync`, {}),

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

  replyRecipients: (cid: string, tid: string) =>
    api.get<{ to: string; cc: string }>(`${base(cid)}/threads/${tid}/reply-recipients`),

  send: (cid: string, aid: string, input: ComposeInput) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/accounts/${aid}/send`, input),
  createDraft: (cid: string, aid: string, input: ComposeInput) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/accounts/${aid}/drafts`, input),
  updateDraft: (cid: string, mid: string, input: Omit<ComposeInput, "threadId">) =>
    api.patch<{ message: MailMessage }>(`${base(cid)}/drafts/${mid}`, input),
  sendDraft: (cid: string, mid: string) =>
    api.post<{ message: MailMessage }>(`${base(cid)}/drafts/${mid}/send`, {}),
  discardDraft: (cid: string, mid: string) => api.del<{ ok: true }>(`${base(cid)}/drafts/${mid}`),

  attachmentUrl: (cid: string, mid: string, index: number) =>
    `${base(cid)}/messages/${mid}/attachments/${index}`,
  uploadAttachment: (cid: string, aid: string, file: File) =>
    api
      .uploadFile<{
        attachment: StagedAttachment;
      }>(`${base(cid)}/accounts/${aid}/outbox-attachments`, file)
      .then((r) => r.attachment),

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
    }>(`${base(cid)}/accounts/${aid}/assistant?threadId=${encodeURIComponent(threadId)}`),
  assistantSend: (
    cid: string,
    aid: string,
    input: {
      message: string;
      threadId: string;
      focusedMessageId?: string;
      employeeId?: string;
    },
    onEvent: (event: string, data: unknown) => void,
    opts: { signal?: AbortSignal } = {},
  ) => api.stream(`${base(cid)}/accounts/${aid}/assistant/messages`, input, onEvent, opts),
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
