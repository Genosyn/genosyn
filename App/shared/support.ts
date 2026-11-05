/**
 * Support: the words, limits and arithmetic the server and the App share.
 *
 * A Ticket is one customer's request. It arrives by email into a Support inbox
 * — a mailbox and the addresses on it that count as support — or through that
 * inbox's Chat widget (`supportChat.ts`), and an AI Employee triages it, drafts
 * the reply from the company's Articles and, only where the owners allow and every
 * check holds, sends it. Everything here is plain data and pure functions so both
 * sides read one set of rules, and the figures a person is shown are computed
 * rather than written by a model.
 */

export const SUPPORT_TICKET_STATUSES = [
  "new",
  "open",
  "waiting",
  "snoozed",
  "solved",
  "closed",
  "spam",
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/** Statuses a Member can set by hand; `new` is where a ticket starts, nothing returns to it. */
export const SUPPORT_SETTABLE_STATUSES = [
  "open",
  "waiting",
  "snoozed",
  "solved",
  "closed",
  "spam",
] as const satisfies readonly SupportTicketStatus[];
export type SupportSettableStatus = (typeof SUPPORT_SETTABLE_STATUSES)[number];

/** A ticket someone at the company still owes an answer. */
export const SUPPORT_ACTIONABLE_STATUSES = ["new", "open"] as const;

export const SUPPORT_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  new: "New",
  open: "Open",
  waiting: "Waiting on customer",
  snoozed: "Snoozed",
  solved: "Solved",
  closed: "Closed",
  spam: "Spam",
};

/** Where a Ticket came from. */
export const SUPPORT_TICKET_SOURCES = ["email", "chat", "import", "manual"] as const;
export type SupportTicketSource = (typeof SUPPORT_TICKET_SOURCES)[number];

export const SUPPORT_SOURCE_LABELS: Record<SupportTicketSource, string> = {
  email: "Email",
  chat: "Chat widget",
  import: "Imported",
  manual: "Added by a Member",
};

export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_PRIORITY_LABELS: Record<SupportPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** Sort order: the most urgent first. Stored on the ticket so a list can page by it. */
export const SUPPORT_PRIORITY_RANK: Record<SupportPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const SUPPORT_SENTIMENTS = ["positive", "neutral", "frustrated", "angry"] as const;
export type SupportSentiment = (typeof SUPPORT_SENTIMENTS)[number];

export const SUPPORT_SENTIMENT_LABELS: Record<SupportSentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  frustrated: "Frustrated",
  angry: "Angry",
};

/**
 * How far an AI Employee goes on one Support inbox. Each step adds to the last:
 * `triage` summarizes and files, `draft` also writes a reply for a Member to
 * send, and `auto` also sends it when every check holds. `draft` is the default
 * because nobody outside the company should hear from an AI on an inbox whose
 * owners have not seen how it answers.
 */
export const SUPPORT_AI_MODES = ["off", "triage", "draft", "auto"] as const;
export type SupportAiMode = (typeof SUPPORT_AI_MODES)[number];

export const SUPPORT_AI_MODE_LABELS: Record<SupportAiMode, string> = {
  off: "Off",
  triage: "Triage only",
  draft: "Draft replies",
  auto: "Reply on its own",
};

export const SUPPORT_AI_MODE_HINTS: Record<SupportAiMode, string> = {
  off: "No AI Employee reads this inbox.",
  triage: "Summarizes each ticket and sets its topic, priority and sentiment. Writes no replies.",
  draft: "Triage, plus a reply drafted from your Articles for a Member to review and send.",
  auto: "Triage and drafts, and sends a reply itself when every check holds. Anything else waits for a Member.",
};

/** What an AI Employee's own tools may do, separately from the turns the server runs. */
export const SUPPORT_ACCESS_LEVELS = ["read", "prepare", "reply"] as const;
export type SupportAccessLevel = (typeof SUPPORT_ACCESS_LEVELS)[number];

export const SUPPORT_ACCESS_RANK: Record<SupportAccessLevel, number> = {
  read: 0,
  prepare: 1,
  reply: 2,
};

export const SUPPORT_ACCESS_LABELS: Record<SupportAccessLevel, string> = {
  read: "Read only",
  prepare: "Prepare replies",
  reply: "Reply to customers",
};

export const SUPPORT_ACCESS_HINTS: Record<SupportAccessLevel, string> = {
  read: "Read tickets and Articles. Changes nothing.",
  prepare:
    "Everything in Read only, plus add notes, update tickets, draft replies for a Member to send and draft Articles. Nobody outside the company hears from it.",
  reply:
    "Everything in Prepare replies, plus send replies to customers and publish Articles. Held for a person when the turn read a customer's words first.",
};

/**
 * The queues the rail lists. The server owns what each one means, so the rail's
 * count and the list it opens can never disagree.
 */
export const SUPPORT_VIEWS = [
  "inbox",
  "mine",
  "unassigned",
  "review",
  "ai",
  "at_risk",
  "waiting",
  "snoozed",
  "solved",
  "spam",
  "all",
] as const;
export type SupportView = (typeof SUPPORT_VIEWS)[number];

export const SUPPORT_VIEW_LABELS: Record<SupportView, string> = {
  inbox: "Inbox",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  review: "AI drafts to review",
  ai: "Answered by AI",
  at_risk: "SLA at risk",
  waiting: "Waiting on customer",
  snoozed: "Snoozed",
  solved: "Solved",
  spam: "Spam",
  all: "All tickets",
};

export const SUPPORT_SORTS = ["recent", "oldest", "priority"] as const;
export type SupportSort = (typeof SUPPORT_SORTS)[number];

export const SUPPORT_SORT_LABELS: Record<SupportSort, string> = {
  recent: "Newest activity",
  oldest: "Longest waiting",
  priority: "Priority",
};

export const SUPPORT_MESSAGE_KINDS = ["customer", "reply", "note", "automated"] as const;
export type SupportMessageKind = (typeof SUPPORT_MESSAGE_KINDS)[number];

export const SUPPORT_DRAFT_STATUSES = [
  "ready",
  /** Claimed for sending. Left here by a crash, it may have gone out; see `work.ts`. */
  "sending",
  "sent",
  "discarded",
  "superseded",
  "failed",
] as const;
export type SupportDraftStatus = (typeof SUPPORT_DRAFT_STATUSES)[number];

export const SUPPORT_CONFIDENCE = ["low", "medium", "high"] as const;
export type SupportConfidence = (typeof SUPPORT_CONFIDENCE)[number];

export const SUPPORT_ARTICLE_STATUSES = ["draft", "published", "archived"] as const;
export type SupportArticleStatus = (typeof SUPPORT_ARTICLE_STATUSES)[number];

export const SUPPORT_ARTICLE_STATUS_LABELS: Record<SupportArticleStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export const SUPPORT_JOB_KINDS = [
  /** Turn one newly-arrived email into a ticket or a message on one. */
  "intake",
  /** Bring a new Support inbox's recent mail in. */
  "import",
  /** Triage a ticket and draft its reply. */
  "work",
  /** The one automatic "we got your email" a new ticket may send. */
  "acknowledge",
  /** Ask a customer how it went, once the ticket has stayed solved. */
  "rating",
  /** Write a draft Article from a solved ticket. */
  "article",
  /** Read the themes across recent tickets. */
  "insights",
  /** Send a Chat widget visitor the one email that confirms their address. */
  "chat_confirm",
  /** Email a Chat widget visitor the replies they have not read. */
  "chat_email",
] as const;
export type SupportJobKind = (typeof SUPPORT_JOB_KINDS)[number];

export const SUPPORT_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type SupportJobStatus = (typeof SUPPORT_JOB_STATUSES)[number];

export const SUPPORT_EVENT_KINDS = [
  "created",
  "status_changed",
  "priority_changed",
  "topic_changed",
  "assigned",
  "tags_changed",
  "subject_changed",
  "merged_in",
  "merged_into",
  "reopened",
  "ai_triaged",
  "ai_drafted",
  "ai_replied",
  "ai_held",
  "ai_failed",
  "handed_over",
  "sla_breached",
  "rated",
  "delivery_failed",
  "acknowledged",
  "rating_requested",
  "chat_email_confirmed",
  "chat_ended",
] as const;
export type SupportEventKind = (typeof SUPPORT_EVENT_KINDS)[number];

export const SUPPORT_LIMITS = {
  nameChars: 120,
  subjectChars: 500,
  replyChars: 60_000,
  noteChars: 20_000,
  instructionsChars: 6_000,
  signatureChars: 2_000,
  disclosureChars: 500,
  acknowledgementChars: 4_000,
  addressesPerInbox: 40,
  addressChars: 320,
  topics: 30,
  topicNameChars: 60,
  topicDescriptionChars: 300,
  tagsPerTicket: 12,
  tagChars: 40,
  articleTitleChars: 200,
  articleBodyChars: 80_000,
  savedReplyNameChars: 120,
  savedReplyBodyChars: 20_000,
  citationsPerDraft: 8,
  quoteChars: 500,
  ratingCommentChars: 2_000,
  helpCenterQueryChars: 200,
  assistInstructionChars: 500,
  bulkTickets: 100,
} as const;

/** The oldest mail a new Support inbox may bring in, in days. */
export const SUPPORT_MAX_IMPORT_DAYS = 90;
/** The most tickets one import creates, newest first. */
export const SUPPORT_MAX_IMPORT_TICKETS = 500;
/** How many replies an AI Employee sends on one ticket before a person must step in. */
export const SUPPORT_MAX_AI_REPLIES_PER_TICKET = 2;
/** A customer who has been answered this many times today by the AI waits for a person. */
export const SUPPORT_MAX_AI_REPLIES_PER_REQUESTER_PER_DAY = 5;
/**
 * The most other people a reply may reach with nobody looking. A stranger should
 * not be able to get the company's AI to email a list of their choosing by copying it.
 */
export const SUPPORT_MAX_AUTO_REPLY_CC = 3;
/** The longest a ticket's AI work may wait for its reply to go out on its own. */
export const SUPPORT_AUTO_REPLY_MAX_AGE_MS = 24 * 60 * 60_000;
/** How long a customer's link to rate a ticket stays good. */
export const SUPPORT_RATING_LINK_DAYS = 30;
/** Hours after a ticket is solved before the customer is asked how it went. */
export const SUPPORT_RATING_DELAY_HOURS = 2;
/** How soon a target counts as "at risk". */
export const SUPPORT_AT_RISK_WINDOW_MS = 60 * 60_000;

// ── Topics ──────────────────────────────────────────────────────────────────

/**
 * What a ticket is about, and what follows from that. The AI Employee picks one
 * by its `key`; the server applies what the owners set on it. Keys never change
 * once made, so renaming a topic keeps every ticket and figure under it.
 */
export type SupportTopic = {
  key: string;
  name: string;
  /** Tells the AI Employee when this topic fits. */
  description: string;
  /** Whether a reply on this topic may go out on its own. Off for anything sensitive. */
  autoReply: boolean;
  /** The Member a ticket on this topic goes to, when it has nobody yet. */
  assigneeUserId: string | null;
  /** The AI Employee a ticket on this topic goes to, when it has nobody yet. */
  assigneeEmployeeId: string | null;
};

/**
 * The topics a company starts with. Auto-reply starts on only where a wrong
 * answer costs a re-read: money, access and bugs are for a person until the
 * owners decide otherwise.
 */
export const DEFAULT_SUPPORT_TOPICS: SupportTopic[] = [
  {
    key: "how_to",
    name: "How-to question",
    description: "How to do something with the product; the answer is documented.",
    autoReply: true,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
  {
    key: "problem",
    name: "Bug or problem",
    description: "Something is broken, failing or behaving unexpectedly.",
    autoReply: false,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
  {
    key: "billing",
    name: "Billing",
    description: "Invoices, charges, refunds, plans and payment details.",
    autoReply: false,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
  {
    key: "account",
    name: "Account access",
    description: "Signing in, passwords, permissions, deleting or changing an account.",
    autoReply: false,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
  {
    key: "feedback",
    name: "Feedback or feature request",
    description: "Ideas, requests and opinions about the product.",
    autoReply: true,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
  {
    key: "other",
    name: "Something else",
    description: "Anything that fits no other topic.",
    autoReply: false,
    assigneeUserId: null,
    assigneeEmployeeId: null,
  },
];

// ── SLA ─────────────────────────────────────────────────────────────────────

/** Minutes, per priority, to the first reply and to solving a ticket. */
export type SupportSlaTargets = Record<
  SupportPriority,
  { firstResponseMinutes: number; resolutionMinutes: number }
>;

export const DEFAULT_SUPPORT_SLA: SupportSlaTargets = {
  urgent: { firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
  high: { firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  normal: { firstResponseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 },
  low: { firstResponseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
};

/** The hours targets count in. Null on settings means targets count around the clock. */
export type SupportBusinessHours = {
  /** IANA name, e.g. "Europe/London". */
  timeZone: string;
  /** 0 is Sunday. */
  days: number[];
  /** Minutes after local midnight. */
  startMinute: number;
  endMinute: number;
};

export const DEFAULT_SUPPORT_BUSINESS_HOURS: SupportBusinessHours = {
  timeZone: "UTC",
  days: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A time zone's weekday and minute of the day at one instant. */
function zonedClock(at: Date, timeZone: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS[read("weekday")] ?? 0,
    minute: Number(read("hour")) * 60 + Number(read("minute")),
  };
}

/** Whether a name is a time zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The moment `minutes` of working time after `start`.
 *
 * Walks whole stretches rather than minutes: to the next opening, then through
 * as much of the day as the target needs. The clock is read again at each step,
 * so a daylight-saving change lands on the right hour instead of drifting. With
 * no hours, or hours that never open, it is plain elapsed time, so a target
 * always has an answer.
 */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  hours: SupportBusinessHours | null,
): Date {
  const elapsed = new Date(start.getTime() + minutes * 60_000);
  if (!hours || hours.days.length === 0 || hours.endMinute <= hours.startMinute) return elapsed;
  if (!isValidTimeZone(hours.timeZone)) return elapsed;
  let cursor = start.getTime();
  let left = minutes;
  // A working year at the very least; a target past that is plain elapsed time.
  for (let step = 0; step < 1_500; step++) {
    const clock = zonedClock(new Date(cursor), hours.timeZone);
    const openToday = hours.days.includes(clock.weekday);
    if (!openToday || clock.minute >= hours.endMinute) {
      cursor += (1_440 - clock.minute) * 60_000;
      continue;
    }
    if (clock.minute < hours.startMinute) {
      cursor += (hours.startMinute - clock.minute) * 60_000;
      continue;
    }
    const available = hours.endMinute - clock.minute;
    if (left <= available) return new Date(cursor + left * 60_000);
    left -= available;
    cursor += available * 60_000;
  }
  return elapsed;
}

// ── AI output kept on rows ──────────────────────────────────────────────────

/** A passage of an Article the AI Employee quoted, checked word for word by the server. */
export type SupportCitation = {
  articleId: string;
  title: string;
  quote: string;
};

/** The reading of recent tickets. The counts come from the server; the words from the model. */
export type SupportInsights = {
  summary: string;
  themes: Array<{ title: string; detail: string; ticketCount: number; topicKey: string | null }>;
  knowledgeGaps: string[];
  recommendations: string[];
  /** How many tickets the reading covered, and over how many days. Server-counted. */
  ticketCount: number;
  windowDays: number;
};

// ── Saved replies ───────────────────────────────────────────────────────────

export type SavedReplyVariables = {
  customerName: string;
  customerFirstName: string;
  customerEmail: string;
  ticketNumber: string;
  ticketSubject: string;
  agentName: string;
  companyName: string;
};

export const SAVED_REPLY_VARIABLES: Array<{ token: string; label: string }> = [
  { token: "customer.first_name", label: "Customer's first name" },
  { token: "customer.name", label: "Customer's full name" },
  { token: "customer.email", label: "Customer's email address" },
  { token: "ticket.number", label: "Ticket number" },
  { token: "ticket.subject", label: "Ticket subject" },
  { token: "agent.name", label: "Your name" },
  { token: "company.name", label: "Company name" },
];

/**
 * Fill a saved reply's `{{customer.first_name}}`-style blanks. Spacing inside
 * the braces is forgiven and case ignored; an unknown blank is left as written,
 * so a typo is seen in the composer and not quietly blanked in the customer's
 * inbox.
 */
export function renderSavedReply(template: string, variables: SavedReplyVariables): string {
  const values: Record<string, string> = {
    "customer.first_name": variables.customerFirstName,
    "customer.name": variables.customerName,
    "customer.email": variables.customerEmail,
    "ticket.number": variables.ticketNumber,
    "ticket.subject": variables.ticketSubject,
    "agent.name": variables.agentName,
    "company.name": variables.companyName,
  };
  return template.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** "Ada" from "Ada Lovelace"; empty when all we hold is an address. */
export function firstNameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("@")) return "";
  return trimmed.split(/\s+/)[0];
}

/** The default line under a reply an AI Employee sent on its own. */
export const DEFAULT_SUPPORT_AI_DISCLOSURE =
  "This reply was written by an AI Employee. Reply here if you would like a person to take a look.";

/** The default text of the one automatic acknowledgement a new ticket may send. */
export const DEFAULT_SUPPORT_ACKNOWLEDGEMENT =
  "Thanks for writing in. We have your message and will get back to you as soon as we can.";

/** A ticket's reference in anything a person reads. */
export function ticketReference(number: number): string {
  return `#${number}`;
}
