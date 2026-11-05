import { api } from "./api";
import type {
  SupportAccessLevel,
  SupportAiMode,
  SupportArticleStatus,
  SupportBusinessHours,
  SupportCitation,
  SupportConfidence,
  SupportDraftStatus,
  SupportEventKind,
  SupportInsights,
  SupportJobStatus,
  SupportMessageKind,
  SupportPriority,
  SupportSentiment,
  SupportSettableStatus,
  SupportSlaTargets,
  SupportSort,
  SupportTicketSource,
  SupportTicketStatus,
  SupportTopic,
  SupportView,
} from "../../shared/support";
import {
  SUPPORT_CHAT_VISITOR_LABEL,
  type ChatEmailConfirmation,
} from "../../shared/supportChat";

/**
 * Support in the App: the shapes the server returns
 * (`server/services/support/serialize.ts`), the calls that fetch and change them,
 * and the small decisions every Support screen makes the same way.
 */

export type SupportPersonUser = {
  id: string;
  name: string;
  email: string;
  avatarKey: string | null;
};
export type SupportPersonEmployee = {
  id: string;
  name: string;
  slug: string;
  avatarKey: string | null;
};

export type SupportTicket = {
  id: string;
  number: number;
  inboxId: string | null;
  subject: string;
  status: SupportTicketStatus;
  priority: SupportPriority;
  prioritySource: "default" | "ai" | "member";
  topicKey: string | null;
  topicSource: "default" | "ai" | "member";
  tags: string[];
  requesterEmail: string;
  requesterName: string;
  matchedAddress: string;
  cc: string[];
  customerId: string | null;
  contactId: string | null;
  assigneeUser: SupportPersonUser | null;
  assigneeEmployee: SupportPersonEmployee | null;
  draftReady: boolean;
  aiHandled: boolean;
  needsHuman: boolean;
  aiHandoffReason: string;
  aiReplyCount: number;
  sentiment: SupportSentiment | null;
  language: string;
  aiSummary: string;
  aiNextStep: string;
  spamReason: string;
  messageCount: number;
  reopenCount: number;
  source: SupportTicketSource;
  mergedIntoId: string | null;
  lastActivityAt: string;
  lastCustomerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  firstResponseDueAt: string | null;
  firstRespondedAt: string | null;
  responseDueAt: string | null;
  resolutionDueAt: string | null;
  slaDueAt: string | null;
  slaBreachedAt: string | null;
  solvedAt: string | null;
  snoozedUntil: string | null;
  ratingScore: number | null;
  ratingComment: string;
  ratingAt: string | null;
  ratingRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportAttachment = { filename: string; mimeType: string; size: number };

export type SupportMessage = {
  id: string;
  ticketId: string;
  kind: SupportMessageKind;
  fromName: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  subject: string;
  authorUser: SupportPersonUser | null;
  authorEmployee: SupportPersonEmployee | null;
  sentByAi: boolean;
  draftId: string | null;
  /** Written in the Chat widget rather than by email. */
  viaChat: boolean;
  sentAt: string;
  bodyText: string;
  bodyHtml: string;
  cleanText: string;
  attachments: SupportAttachment[];
  citations: SupportCitation[];
};

export type SupportDraft = {
  id: string;
  ticketId: string;
  status: SupportDraftStatus;
  employee: SupportPersonEmployee | null;
  basedOnMessageId: string | null;
  answerable: boolean;
  confidence: SupportConfidence;
  injectionDetected: boolean;
  editedBeforeSend: boolean;
  body: string;
  translation: string;
  citations: SupportCitation[];
  note: string;
  holdReasons: string[];
  gapQuestion: string;
  decidedBy: SupportPersonUser | null;
  decidedAt: string | null;
  createdAt: string;
};

export type SupportEvent = {
  id: string;
  kind: SupportEventKind;
  actorKind: "user" | "ai" | "system" | "customer";
  actorName: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export type SupportTicketDetail = {
  ticket: SupportTicket;
  messages: SupportMessage[];
  drafts: SupportDraft[];
  events: SupportEvent[];
  inbox: {
    id: string;
    name: string;
    aiMode: SupportAiMode;
    aiEmployeeId: string | null;
    aiEmployeeName: string | null;
    status: "active" | "paused";
  } | null;
  mailbox: { id: string; address: string } | null;
  /** The visitor behind a ticket from the Chat widget. */
  chat: {
    widgetEnabled: boolean;
    reachable: boolean;
    ended: boolean;
    email: string;
    /** Typed and not confirmed: anyone can type anyone's address. */
    unconfirmedEmail: string;
    lastSeenAt: string;
  } | null;
  work: {
    status: SupportJobStatus;
    error: string;
    attempts: number;
    finishedAt: string | null;
  } | null;
  customer: {
    id: string;
    name: string;
    accountStatus: string;
    domain: string;
    annualContractValueCents: number;
    currency: string;
  } | null;
  contact: { id: string; name: string; title: string; doNotContact: boolean } | null;
  otherTickets: Array<{
    id: string;
    number: number;
    subject: string;
    status: SupportTicketStatus;
    createdAt: string;
  }>;
  similar: Array<{
    id: string;
    number: number;
    subject: string;
    status: SupportTicketStatus;
    aiSummary: string;
  }>;
};

export type SupportTicketPage = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  note?: string;
  rows: SupportTicket[];
};

export type SupportCounts = Partial<Record<SupportView, number>>;

export type SupportInbox = {
  id: string;
  name: string;
  status: "active" | "paused";
  accountId: string;
  mailbox: {
    id: string;
    address: string;
    provider: "gmail" | "imap";
    status: string;
    statusMessage: string;
    lastSyncAt: string | null;
    importing: boolean;
  } | null;
  addresses: string[];
  fromAddress: string;
  fromName: string;
  aiMode: SupportAiMode;
  aiEmployeeId: string | null;
  aiInstructions: string;
  autoReplyDailyLimit: number;
  signature: string;
  acknowledge: boolean;
  acknowledgementBody: string | null;
  archiveOnSolve: boolean;
  watchFrom: string;
  importStatus: "none" | "pending" | "done";
  importedCount: number;
  createdAt: string;
  openTickets: number;
  autoRepliesToday: number;
  chatWidget: SupportChatWidgetView;
};

export type SupportChatWidgetView = {
  enabled: boolean;
  allowedOrigins: string[];
  title: string;
  greeting: string;
  defaultGreeting: string;
  publicKey: string | null;
  snippet: string | null;
};

export type SupportInboxInput = {
  accountId?: string;
  name?: string;
  addresses?: string[];
  fromAddress?: string;
  fromName?: string;
  aiMode?: SupportAiMode;
  aiEmployeeId?: string | null;
  aiInstructions?: string;
  signature?: string;
  acknowledge?: boolean;
  acknowledgementBody?: string | null;
  archiveOnSolve?: boolean;
  autoReplyDailyLimit?: number;
  status?: "active" | "paused";
  importDays?: number;
};

export type SupportSettings = {
  id: string;
  aiEmployeeId: string | null;
  aiInstructions: string;
  aiDisclosure: string | null;
  defaultAiDisclosure: string;
  workingLanguage: string;
  topics: SupportTopic[];
  sla: SupportSlaTargets;
  slaEnabled: boolean;
  businessHours: SupportBusinessHours | null;
  ratingsEnabled: boolean;
  /** Whether anyone can read the published Articles at `helpCenterUrl`. */
  helpCenterEnabled: boolean;
  helpCenterUrl: string;
  autoCloseDays: number;
  autoSolveDays: number;
  chatMessagesPerHour: number;
  chatAiTurnsPerDay: number;
  /** Counted by the server from the company's budget, for the current day's window. */
  chatAiTurnsUsed: number;
  insights: SupportInsights | null;
  insightsAt: string | null;
};

export type SupportArticle = {
  id: string;
  title: string;
  status: SupportArticleStatus;
  topicKey: string | null;
  sourceTicketId: string | null;
  createdByEmployeeId: string | null;
  createdByUserId: string | null;
  citedCount: number;
  lastCitedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  body?: string;
};

export type SupportArticlePage = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  rows: SupportArticle[];
};

export type SupportKnowledgeGap = {
  question: string;
  count: number;
  topicKey: string | null;
  lastAskedAt: string;
  tickets: Array<{ id: string; number: number; subject: string }>;
};

export type SupportSavedReply = {
  id: string;
  name: string;
  body: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportGrantRow = {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null };
  grant: { id: string; accessLevel: SupportAccessLevel; createdAt: string } | null;
};

export type SupportAnalytics = {
  windowDays: number;
  truncated: boolean;
  tickets: number;
  backlog: number;
  spam: number;
  solved: number;
  medianFirstResponseMinutes: number | null;
  medianResolutionMinutes: number | null;
  slaAttainment: number | null;
  ratingCount: number;
  ratingAverage: number | null;
  ai: {
    solved: number;
    resolutionRate: number | null;
    draftsSent: number;
    draftsUntouched: number;
    draftsDiscarded: number;
    draftAcceptance: number | null;
  };
  sentiment: Record<SupportSentiment, number>;
  topics: Array<{
    key: string | null;
    name: string;
    tickets: number;
    solvedByAi: number;
    draftsSent: number;
    draftsUntouched: number;
    draftsDiscarded: number;
    draftAcceptance: number | null;
  }>;
  volume: Array<{ date: string; created: number; solved: number }>;
};

export type TicketFilters = {
  view?: SupportView;
  priority?: SupportPriority;
  topicKey?: string;
  inboxId?: string;
  source?: SupportTicketSource;
  q?: string;
  sort?: SupportSort;
  requesterEmail?: string;
};

export type TicketPatch = {
  status?: SupportSettableStatus;
  snoozedUntil?: string | null;
  priority?: SupportPriority;
  topicKey?: string | null;
  tags?: string[];
  assigneeUserId?: string | null;
  assigneeEmployeeId?: string | null;
  subject?: string;
};

export type ReplyInput = {
  body: string;
  cc?: string[];
  attachmentIds?: string[];
  status?: SupportSettableStatus;
  basedOnMessageId?: string | null;
  force?: boolean;
};

export type AssistAction = "shorter" | "friendlier" | "formal" | "clearer" | "translate";

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function supportApi(companyId: string) {
  const base = `/api/companies/${companyId}/support`;
  return {
    tickets: (filters: TicketFilters, page: { limit?: number; cursor?: string } = {}) =>
      api.get<SupportTicketPage>(`${base}/tickets${query({ ...filters, ...page })}`),
    counts: () => api.get<{ counts: SupportCounts }>(`${base}/counts`),
    ticket: (id: string) => api.get<SupportTicketDetail>(`${base}/tickets/${id}`),
    startTicket: (body: {
      inboxId: string;
      requesterEmail: string;
      requesterName?: string;
      subject: string;
      body: string;
      cc?: string[];
      send: boolean;
    }) => api.post<{ ticket: SupportTicket }>(`${base}/tickets`, body),
    updateTicket: (id: string, patch: TicketPatch) =>
      api.patch<{ ticket: SupportTicket }>(`${base}/tickets/${id}`, patch),
    bulkUpdate: (ticketIds: string[], patch: Omit<TicketPatch, "tags" | "subject">) =>
      api.post<{ succeeded: string[]; skipped: Array<{ id: string; reason: string }> }>(
        `${base}/tickets/bulk`,
        { ticketIds, ...patch },
      ),
    reply: (id: string, body: ReplyInput) =>
      api.post<{ ticket: SupportTicket; message: SupportMessage }>(
        `${base}/tickets/${id}/reply`,
        body,
      ),
    note: (id: string, body: string) =>
      api.post<{ message: SupportMessage }>(`${base}/tickets/${id}/notes`, { body }),
    merge: (id: string, intoTicketId: string) =>
      api.post<{ ticket: SupportTicket }>(`${base}/tickets/${id}/merge`, { intoTicketId }),
    askAi: (id: string) => api.post<{ queued: boolean }>(`${base}/tickets/${id}/ai/work`, {}),
    assist: (id: string, text: string, action: AssistAction) =>
      api.post<{ text: string }>(`${base}/tickets/${id}/ai/assist`, { text, action }),
    articleFromTicket: (id: string) =>
      api.post<{ queued: boolean }>(`${base}/tickets/${id}/ai/article`, {}),
    handover: (id: string, employeeId: string, instruction: string) =>
      api.post<{ handoverId: string }>(`${base}/tickets/${id}/handover`, {
        employeeId,
        instruction,
      }),
    sendDraft: (ticketId: string, draftId: string, body: Partial<ReplyInput>) =>
      api.post<{ ticket: SupportTicket; message: SupportMessage }>(
        `${base}/tickets/${ticketId}/drafts/${draftId}/send`,
        body,
      ),
    discardDraft: (ticketId: string, draftId: string) =>
      api.post<{ ok: boolean }>(`${base}/tickets/${ticketId}/drafts/${draftId}/discard`, {}),
    attachmentUrl: (ticketId: string, messageId: string, index: number) =>
      `${base}/tickets/${ticketId}/messages/${messageId}/attachments/${index}`,

    inboxes: () => api.get<{ inboxes: SupportInbox[] }>(`${base}/inboxes`),
    createInbox: (
      body: SupportInboxInput & { accountId: string; name: string; addresses: string[] },
    ) => api.post<{ inbox: SupportInbox }>(`${base}/inboxes`, body),
    updateInbox: (id: string, body: SupportInboxInput) =>
      api.patch<{ inbox: SupportInbox }>(`${base}/inboxes/${id}`, body),
    importInbox: (id: string, days: number) =>
      api.post<{ inbox: SupportInbox }>(`${base}/inboxes/${id}/import`, { days }),
    deleteInbox: (id: string) => api.del<{ ok: boolean }>(`${base}/inboxes/${id}`),
    saveChatWidget: (
      inboxId: string,
      body: { enabled?: boolean; allowedOrigins?: string[]; title?: string; greeting?: string },
    ) =>
      api.put<{ widget: SupportChatWidgetView }>(`${base}/inboxes/${inboxId}/chat-widget`, body),

    settings: () => api.get<{ settings: SupportSettings }>(`${base}/settings`),
    updateSettings: (body: Record<string, unknown>) =>
      api.patch<{ settings: SupportSettings }>(`${base}/settings`, body),

    grants: () => api.get<{ rows: SupportGrantRow[] }>(`${base}/ai-access`),
    setGrant: (employeeId: string, accessLevel: SupportAccessLevel) =>
      api.put<{ grant: { id: string } }>(`${base}/ai-access/${employeeId}`, { accessLevel }),
    removeGrant: (employeeId: string) =>
      api.del<{ ok: boolean }>(`${base}/ai-access/${employeeId}`),

    articles: (
      filters: { status?: SupportArticleStatus; q?: string; topicKey?: string },
      page: { limit?: number; cursor?: string } = {},
    ) => api.get<SupportArticlePage>(`${base}/articles${query({ ...filters, ...page })}`),
    article: (id: string) => api.get<{ article: SupportArticle }>(`${base}/articles/${id}`),
    createArticle: (body: {
      title: string;
      body: string;
      topicKey?: string | null;
      status?: SupportArticleStatus;
    }) => api.post<{ article: SupportArticle }>(`${base}/articles`, body),
    updateArticle: (
      id: string,
      body: {
        title?: string;
        body?: string;
        topicKey?: string | null;
        status?: SupportArticleStatus;
      },
    ) => api.patch<{ article: SupportArticle }>(`${base}/articles/${id}`, body),
    deleteArticle: (id: string) => api.del<{ ok: boolean }>(`${base}/articles/${id}`),
    knowledgeGaps: () => api.get<{ gaps: SupportKnowledgeGap[] }>(`${base}/knowledge-gaps`),

    savedReplies: () => api.get<{ savedReplies: SupportSavedReply[] }>(`${base}/saved-replies`),
    createSavedReply: (body: { name: string; body: string }) =>
      api.post<{ savedReply: SupportSavedReply }>(`${base}/saved-replies`, body),
    updateSavedReply: (id: string, body: { name?: string; body?: string }) =>
      api.patch<{ savedReply: SupportSavedReply }>(`${base}/saved-replies/${id}`, body),
    deleteSavedReply: (id: string) => api.del<{ ok: boolean }>(`${base}/saved-replies/${id}`),
    savedReplyUsed: (id: string) =>
      api.post<{ ok: boolean }>(`${base}/saved-replies/${id}/used`, {}),

    analytics: (days: number) => api.get<SupportAnalytics>(`${base}/analytics${query({ days })}`),
    requestInsights: () => api.post<{ queued: boolean }>(`${base}/insights`, {}),
  };
}

export type FeedbackPage = {
  companyName: string;
  subject: string;
  reference: string;
  score: number | null;
  comment: string;
  ratedAt: string | null;
  expired: boolean;
};

export const feedbackApi = {
  get: (token: string) => api.get<FeedbackPage>(`/api/feedback/${encodeURIComponent(token)}`),
  rate: (token: string, score: number, comment: string) =>
    api.post<FeedbackPage>(`/api/feedback/${encodeURIComponent(token)}`, {
      score,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    }),
};

export const chatConfirmApi = {
  get: (token: string) =>
    api.get<ChatEmailConfirmation>(`/api/support-chat/confirm/${encodeURIComponent(token)}`),
  confirm: (token: string) =>
    api.post<ChatEmailConfirmation>(`/api/support-chat/confirm/${encodeURIComponent(token)}`, {}),
};

// ── The public help center ──────────────────────────────────────────────────

export type HelpCenterCard = {
  id: string;
  title: string;
  topic: { key: string; name: string } | null;
};

export type HelpCenterMatch = HelpCenterCard & { excerpt: string };

type HelpCenterPage<Row> = { hasMore: boolean; nextCursor: string | null; rows: Row[] };

export type HelpCenterHome = {
  companyName: string;
  topics: Array<{ key: string; name: string; articleCount: number }>;
  articles: HelpCenterPage<HelpCenterCard> & { total: number };
};

export type HelpCenterArticle = HelpCenterCard & { body: string; updatedAt: string };

export const helpCenterApi = {
  home: (slug: string) => api.get<HelpCenterHome>(`/api/help/${encodeURIComponent(slug)}`),
  articles: (slug: string, cursor: string) =>
    api.get<HelpCenterPage<HelpCenterCard>>(
      `/api/help/${encodeURIComponent(slug)}/articles${query({ cursor })}`,
    ),
  article: (slug: string, articleId: string) =>
    api.get<{ companyName: string; article: HelpCenterArticle }>(
      `/api/help/${encodeURIComponent(slug)}/articles/${encodeURIComponent(articleId)}`,
    ),
  search: (slug: string, q: string, cursor?: string) =>
    api.get<HelpCenterPage<HelpCenterMatch> & { companyName: string }>(
      `/api/help/${encodeURIComponent(slug)}/search${query({ q, cursor })}`,
    ),
};

// ── Small decisions every screen makes the same way ─────────────────────────

/** "3m ago", "2h ago", "5d ago", "Mar 3". */
export function agoText(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "42m", "3h 10m", "2d 4h". */
export function durationText(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole}m`;
  if (whole < 24 * 60) {
    const hours = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(whole / (24 * 60));
  const hours = Math.floor((whole % (24 * 60)) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export type SlaState = { label: string; tone: "danger" | "warning" | "neutral" };

/** How a ticket's next target stands right now, or null while no clock runs on it. */
export function slaState(
  ticket: Pick<SupportTicket, "slaDueAt">,
  now = Date.now(),
): SlaState | null {
  if (!ticket.slaDueAt) return null;
  const minutes = (new Date(ticket.slaDueAt).getTime() - now) / 60_000;
  if (minutes < 0) return { label: `${durationText(-minutes)} overdue`, tone: "danger" };
  if (minutes < 60) return { label: `Due in ${durationText(minutes)}`, tone: "warning" };
  return { label: `Due in ${durationText(minutes)}`, tone: "neutral" };
}

/** "Ada Lovelace", falling back to the address for a sender who gave no name. */
export function requesterLabel(
  ticket: Pick<SupportTicket, "requesterName" | "requesterEmail" | "source">,
): string {
  return (
    ticket.requesterName ||
    ticket.requesterEmail ||
    (ticket.source === "chat" ? SUPPORT_CHAT_VISITOR_LABEL : "Unknown customer")
  );
}

/** Who a message came from, for the line above it. */
export function messageAuthor(message: SupportMessage): string {
  if (message.authorEmployee) return message.authorEmployee.name;
  if (message.authorUser) return message.authorUser.name;
  return (
    message.fromName || message.fromEmail || (message.viaChat ? SUPPORT_CHAT_VISITOR_LABEL : "Someone")
  );
}

/** Commas, spaces and new lines between addresses all work. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const DRAFT_KEY = (ticketId: string) => `genosyn.support.composer.${ticketId}`;

/** An unsent reply survives leaving the page. Never relied on: storage can be unavailable. */
export function readComposerDraft(ticketId: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY(ticketId)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(ticketId: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY(ticketId), text);
    else window.localStorage.removeItem(DRAFT_KEY(ticketId));
  } catch {
    // Private windows and full disks lose a draft, not the page.
  }
}
