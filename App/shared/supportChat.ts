/**
 * The Chat widget: what the server, the App and the widget's own small bundle
 * share. A company embeds the widget on its own site, and a visitor's messages
 * open and continue a Ticket. A visitor is a stranger with a token, so everything
 * here describes only what that token may see of its own conversation.
 */

export const SUPPORT_CHAT_LIMITS = {
  /** One message from a visitor. A chat line, not a letter. */
  messageChars: 4_000,
  nameChars: 120,
  titleChars: 80,
  greetingChars: 500,
  /** A Ticket opened from chat is named after the start of its first message. */
  subjectChars: 80,
  originsPerWidget: 20,
  originChars: 300,
  /** Messages one poll returns; `hasMore` says when to read on. */
  pageMessages: 100,
} as const;

/** A token nobody has used for this long stops opening its conversation. */
export const SUPPORT_CHAT_TOKEN_DAYS = 30;
/** How long a link confirming an email address stays good. */
export const SUPPORT_CHAT_EMAIL_LINK_HOURS = 72;
/** Replies a visitor has not read after this long go by email, once they confirmed one. */
export const SUPPORT_CHAT_EMAIL_DELAY_MS = 2 * 60_000;

/** The most the company-wide limits owners and admins set can be. */
export const SUPPORT_CHAT_MAX_MESSAGES_PER_HOUR = 100_000;
export const SUPPORT_CHAT_MAX_AI_TURNS_PER_DAY = 100_000;

export const DEFAULT_SUPPORT_CHAT_GREETING =
  "Hi there. Ask us anything, and we will answer here. You can leave this page and come back.";

/** The name a visitor goes by until they give one. */
export const SUPPORT_CHAT_VISITOR_LABEL = "Website visitor";

/** What a page needs to draw the widget. Nothing about who runs it or how. */
export type ChatWidgetConfig = {
  title: string;
  greeting: string;
  companyName: string;
  /** False while the inbox behind it is paused: earlier messages read, new ones wait. */
  open: boolean;
};

export type ChatMessageFrom = "visitor" | "team" | "ai" | "system";

/**
 * One line a visitor may read. Deliberately short: no ticket number, status,
 * assignee, Member, citation or summary ever reaches a browser this way.
 */
export type ChatWidgetMessage = {
  seq: number;
  /** The id the widget gave its own message, so a retry finds what it already sent. */
  clientId: string | null;
  from: ChatMessageFrom;
  name: string;
  text: string;
  at: string;
};

export type ChatEmailStatus = {
  /** `pending` until a person presses Confirm on the link emailed to the address. */
  state: "none" | "pending" | "confirmed";
  address: string;
};

export type ChatConversationPage = {
  messages: ChatWidgetMessage[];
  hasMore: boolean;
  /** Pass back as `after` to read on from here. */
  nextAfter: number;
  /** The last message the visitor has seen, for the unread count. */
  readSeq: number;
  email: ChatEmailStatus;
};

export type ChatEmailConfirmation = {
  companyName: string;
  address: string;
  state: "ready" | "confirmed" | "expired";
};

/**
 * The messages between the loader on the company's page and the frame it opens.
 * They carry no conversation and no credential: only that the panel was opened or
 * closed, whether a chat has started, and how many replies wait.
 */
export const SUPPORT_CHAT_POST_SOURCE = "genosyn-support-chat";
export type ChatFrameMessage =
  | { source: typeof SUPPORT_CHAT_POST_SOURCE; type: "ready" }
  | { source: typeof SUPPORT_CHAT_POST_SOURCE; type: "close" }
  | { source: typeof SUPPORT_CHAT_POST_SOURCE; type: "started" }
  | { source: typeof SUPPORT_CHAT_POST_SOURCE; type: "ended" }
  | { source: typeof SUPPORT_CHAT_POST_SOURCE; type: "unread"; count: number };
export type ChatHostMessage = {
  source: typeof SUPPORT_CHAT_POST_SOURCE;
  type: "opened" | "closed";
};

/** The replies a visitor has not seen, among what the widget holds. */
export function chatUnreadCount(
  messages: ReadonlyArray<Pick<ChatWidgetMessage, "seq" | "from">>,
  readSeq: number,
): number {
  return messages.filter((message) => message.from !== "visitor" && message.seq > readSeq).length;
}
