import { api, type ChatAttachment, type MessageAction } from "./api";
import type { MailSuggestion } from "./mail";
import type { AskAiContextKind, AskAiContextRef } from "../../shared/askAi";

/**
 * Ask AI — the wire types and calls for the chat window in the top nav.
 * Conversations belong to the signed-in Member; the server applies their
 * access and each AI Employee's Grants to whatever page context travels with a
 * message (see `server/services/askAi/context.ts`).
 */

export type AskAiContextItem = {
  kind: AskAiContextKind;
  id: string;
  label: string;
  sublabel: string | null;
  href: string | null;
};

export type AskAiTurnContext = {
  path: string;
  pageLabel: string | null;
  items: AskAiContextItem[];
};

export type AskAiMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  /** On an answer, the human turn it answers. */
  turnId: string | null;
  employeeId: string | null;
  modelId: string | null;
  content: string;
  /** `queued` and `working` are answers still owed. */
  status: "queued" | "working" | "ok" | "skipped" | "error" | null;
  actions: MessageAction[];
  suggestions: MailSuggestion[];
  attachments: ChatAttachment[];
  /** What was on screen when a human turn was sent. */
  context: AskAiTurnContext | null;
  createdAt: string;
};

export type AskAiModel = {
  id: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  isActive: boolean;
};

export type AskAiRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  hasModel: boolean;
  models: AskAiModel[];
};

export type AskAiConversation = {
  id: string;
  title: string | null;
  lastMessageAt: string;
  createdAt: string;
};

export type AskAiConversationBootstrap = {
  conversation: AskAiConversation;
  messages: AskAiMessage[];
  roster: AskAiRosterEntry[];
  modelId: string | null;
};

export type AskAiContextPreview = {
  items: AskAiContextItem[];
  defaultEmployeeIds: string[];
  /** Per employee id, the keys (`kind:id`) of records it would not be shown. */
  withheld: Record<string, string[]>;
};

export type AskAiPage = { path: string; label: string | null };

export type AskAiSendInput = {
  message: string;
  employeeIds: string[];
  attachmentIds: string[];
  modelId: string | null;
  page: AskAiPage;
  refs: AskAiContextRef[];
  exclude: string[];
};

const base = (companyId: string) => `/api/companies/${companyId}/ask-ai`;

export const askAiApi = {
  index: (companyId: string) =>
    api.get<{ conversations: AskAiConversation[]; roster: AskAiRosterEntry[] }>(base(companyId)),

  create: (companyId: string) =>
    api
      .post<{ conversation: AskAiConversation }>(`${base(companyId)}/conversations`, {})
      .then((r) => r.conversation),

  load: (companyId: string, conversationId: string) =>
    api.get<AskAiConversationBootstrap>(`${base(companyId)}/conversations/${conversationId}`),

  remove: (companyId: string, conversationId: string) =>
    api.del<{ ok: true }>(`${base(companyId)}/conversations/${conversationId}`),

  preview: (companyId: string, refs: AskAiContextRef[], exclude: string[]) =>
    api.post<AskAiContextPreview>(`${base(companyId)}/context`, { refs, exclude }),

  send: (
    companyId: string,
    conversationId: string,
    input: AskAiSendInput,
    onEvent: (event: string, data: unknown) => void,
    opts?: { signal?: AbortSignal },
  ) =>
    api.stream(`${base(companyId)}/conversations/${conversationId}/messages`, input, onEvent, opts),

  upload: (companyId: string, file: File) =>
    api
      .uploadFile<{ attachment: ChatAttachment }>(`${base(companyId)}/attachments`, file)
      .then((r) => r.attachment),

  attachmentUrl: (companyId: string, conversationId: string, attachmentId: string) =>
    `${base(companyId)}/conversations/${conversationId}/attachments/${attachmentId}`,

  markSuggestionExecuted: (
    companyId: string,
    conversationId: string,
    messageId: string,
    suggestionId: string,
  ) =>
    api.post<{ message: AskAiMessage }>(
      `${base(companyId)}/conversations/${conversationId}/messages/${messageId}/suggestions/${suggestionId}/executed`,
      {},
    ),
};

/** `Anthropic · claude-…` for the model picker. */
export function askAiModelLabel(model: AskAiModel): string {
  const provider =
    model.provider === "openai" ? "OpenAI" : model.provider === "anthropic" ? "Anthropic" : "Custom";
  return `${provider} · ${model.model}`;
}

/** `@slug` mentions at the caret, for the composer's picker. */
export function mentionQueryAtCaret(value: string, caret: number): string | null {
  const match = /(^|[\s(])@([a-z0-9-]*)$/i.exec(value.slice(0, caret));
  return match ? match[2] : null;
}

/** Replace the `@partial` at the caret with a full mention. */
export function insertMention(
  value: string,
  caret: number,
  slug: string,
): { value: string; caret: number } | null {
  const upToCaret = value.slice(0, caret);
  if (!/@([a-z0-9-]*)$/i.test(upToCaret)) return null;
  const replaced = upToCaret.replace(/@([a-z0-9-]*)$/i, `@${slug} `);
  return { value: replaced + value.slice(caret), caret: replaced.length };
}

/** Every roster slug mentioned in a draft, in order, de-duplicated. */
export function mentionedRosterIds(
  draft: string,
  roster: Array<Pick<AskAiRosterEntry, "id" | "slug">>,
): string[] {
  const out: string[] = [];
  for (const match of draft.matchAll(/(^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/gi)) {
    const entry = roster.find((r) => r.slug === match[2].toLowerCase());
    if (entry && !out.includes(entry.id)) out.push(entry.id);
  }
  return out;
}

/**
 * The one AI Employee who can answer, when there is exactly one with a
 * connected AI Model — nobody else could be asked, so there is nothing to
 * choose. Null otherwise.
 */
export function soleAnswerer(roster: Array<Pick<AskAiRosterEntry, "id" | "hasModel">>): string | null {
  const ready = roster.filter((entry) => entry.hasModel);
  return ready.length === 1 ? ready[0].id : null;
}

/**
 * Who a message will go to, mirroring the server's order so the composer's
 * "Asking …" line is never a guess: mentions, then the picked employees, then
 * whoever answered the last turn, then the page's natural owner — and, when
 * only one AI Employee can answer at all, that one. The panel sends the last
 * as an explicit pick, so the server asks exactly who the line names.
 */
export function plannedTargets(args: {
  draft: string;
  roster: AskAiRosterEntry[];
  picked: string[];
  messages: AskAiMessage[] | null;
  defaults: string[];
}): string[] {
  const mentioned = mentionedRosterIds(args.draft, args.roster);
  if (mentioned.length > 0) return mentioned.slice(0, 5);
  const known = (ids: string[]) => ids.filter((id) => args.roster.some((r) => r.id === id));
  const picked = known(args.picked);
  if (picked.length > 0) return picked.slice(0, 5);
  const messages = args.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !m.id.startsWith("temp-"));
  if (lastUser) {
    const answered = known([
      ...new Set(
        messages
          .filter((m) => m.role === "assistant" && m.turnId === lastUser.id && m.employeeId)
          .map((m) => m.employeeId as string),
      ),
    ]);
    if (answered.length > 0) return answered.slice(0, 5);
  }
  const owners = known(args.defaults);
  if (owners.length > 0) return owners.slice(0, 5);
  const sole = soleAnswerer(args.roster);
  return sole ? [sole] : [];
}
