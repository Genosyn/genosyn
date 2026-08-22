import { api, type MessageAction, type TldrEmployeeSnapshot } from "./api";

/**
 * Question cards on a TLDR: the client half of `server/services/tldrQuestions`.
 *
 * These types are mirrored by hand from the server DTOs — there is no shared
 * package — so a change on one side needs the same change on the other.
 */

export type TldrQuestionMessage = {
  id: string;
  questionId: string;
  role: "user" | "assistant";
  employeeId: string | null;
  modelId: string | null;
  content: string;
  /** `working` is a persisted in-flight turn, not a local spinner. */
  status: "working" | "ok" | "skipped" | "error" | null;
  actions: MessageAction[];
  /** Set when this turn came from pressing a suggested action. */
  actionId: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

/** What a suggested action creates. Decides its icon and who may press it. */
export type TldrActionKind = "routine" | "todo" | "project" | "decision" | "other";

export type TldrActionStatus = "proposed" | "running" | "done" | "dismissed";

/**
 * One button the AI Employee attached to its own answer.
 *
 * `label` is the button and `intent` is the sentence shown beside it. Both are
 * displayed before anything runs, because pressing sends exactly those two
 * strings back as this Member's own instruction — under this Member's own
 * access, never the employee's.
 */
export type TldrSuggestedAction = {
  id: string;
  questionId: string;
  messageId: string;
  kind: TldrActionKind;
  label: string;
  intent: string;
  status: TldrActionStatus;
  runMessageId: string | null;
  completedByUserId: string | null;
  /** False when this Member's own authority cannot reach what the button does. */
  runnable: boolean;
  createdAt: string;
};

export type TldrQuestion = {
  id: string;
  tldrId: string;
  prompt: string;
  /** `standing` cards were answered automatically when the briefing landed. */
  origin: "member" | "standing";
  employee: TldrEmployeeSnapshot;
  createdByUserId: string | null;
  createdAt: string;
  /** Oldest first, with the seeded prompt row excluded — the header shows it. */
  messages: TldrQuestionMessage[];
  suggestedActions: TldrSuggestedAction[];
};

export type TldrQuestionsResponse = {
  questions: TldrQuestion[];
  canAsk: boolean;
  canDelegateAutomation: boolean;
  maxQuestions: number;
};

/** Server ceilings, mirrored so the composer can stop the Member before the 400. */
export const TLDR_QUESTION_PROMPT_MAX_CHARS = 500;
export const TLDR_QUESTION_MESSAGE_MAX_CHARS = 8_000;

/**
 * One-click starting points.
 *
 * Deliberately the questions a person actually asks after reading a recap —
 * forward-looking and about what to change — rather than "summarize this
 * again", which is what the briefing already is.
 */
export const TLDR_QUESTION_PRESETS = [
  "What can be improved?",
  "What should we stop doing?",
  "What is the biggest risk here?",
  "What needs a decision from me?",
] as const;

const base = (companyId: string, tldrId: string) =>
  `/api/companies/${companyId}/tldrs/${tldrId}/questions`;

export type TldrQuestionStreamHandler = (event: string, data: unknown) => void;

export const tldrQuestionsApi = {
  list: (companyId: string, tldrId: string) =>
    api.get<TldrQuestionsResponse>(base(companyId, tldrId)),

  /** Create a card and stream its first answer. */
  ask: (
    companyId: string,
    tldrId: string,
    body: { prompt: string; modelId?: string | null },
    onEvent: TldrQuestionStreamHandler,
    signal?: AbortSignal,
  ) => api.stream(base(companyId, tldrId), body, onEvent, { signal }),

  /** Send a follow-up on an existing card and stream the reply. */
  send: (
    companyId: string,
    tldrId: string,
    questionId: string,
    body: { message: string; modelId?: string | null },
    onEvent: TldrQuestionStreamHandler,
    signal?: AbortSignal,
  ) =>
    api.stream(`${base(companyId, tldrId)}/${questionId}/messages`, body, onEvent, {
      signal,
    }),

  remove: (companyId: string, tldrId: string, questionId: string) =>
    api.del<{ ok: true }>(`${base(companyId, tldrId)}/${questionId}`),

  /**
   * Press a suggested action. Same stream and same turn as sending a
   * follow-up: the employee wrote the sentence, the Member read it and pressed,
   * and the server replays it as that Member's own instruction.
   */
  runAction: (
    companyId: string,
    tldrId: string,
    questionId: string,
    actionId: string,
    onEvent: TldrQuestionStreamHandler,
    signal?: AbortSignal,
  ) =>
    api.stream(
      `${base(companyId, tldrId)}/${questionId}/actions/${actionId}/run`,
      {},
      onEvent,
      { signal },
    ),

  dismissAction: (companyId: string, tldrId: string, questionId: string, actionId: string) =>
    api.del<{ ok: true }>(`${base(companyId, tldrId)}/${questionId}/actions/${actionId}`),
};

/** Buttons still worth showing. Dismissed suggestions leave the card quietly. */
export function visibleActions(question: TldrQuestion): TldrSuggestedAction[] {
  return question.suggestedActions.filter((action) => action.status !== "dismissed");
}

/**
 * Replace a message by id, or append it when this panel hasn't seen it yet.
 *
 * The same row arrives twice by design: once as `working` when the server
 * commits the turn, then again finalized. Keying on id is what makes the
 * spinner become the answer instead of stacking beneath it.
 */
export function upsertQuestionMessage(
  messages: TldrQuestionMessage[],
  incoming: TldrQuestionMessage,
): TldrQuestionMessage[] {
  const index = messages.findIndex((m) => m.id === incoming.id);
  if (index === -1) return [...messages, incoming];
  const next = [...messages];
  next[index] = incoming;
  return next;
}

/**
 * Fold a freshly fetched card list into what the panel is showing.
 *
 * The server wins for everything persisted. Locally-optimistic rows (a
 * just-typed bubble the server hasn't echoed yet) are kept only while the
 * server has nothing matching — otherwise a reload would show the message
 * twice, once as the optimistic twin and once as the real row.
 */
export function mergeQuestions(
  previous: TldrQuestion[],
  incoming: TldrQuestion[],
): TldrQuestion[] {
  const bySeenId = new Map(previous.map((q) => [q.id, q]));
  return incoming.map((question) => {
    const seen = bySeenId.get(question.id);
    if (!seen) return question;
    const seenById = new Map(seen.messages.map((m) => [m.id, m]));
    const messages = question.messages.map((message) => {
      // An in-flight row is stored empty until the turn finalizes, so a poll or
      // a live refetch that lands mid-stream carries `content: ""` for a bubble
      // this browser has been filling token by token. Taking the server's copy
      // there would blank the answer the Member is watching arrive — the stream
      // is ahead of the database until the moment it isn't.
      const local = seenById.get(message.id);
      if (message.status === "working" && !message.content && local?.content) {
        return { ...message, content: local.content };
      }
      return message;
    });
    const known = new Set(question.messages.map((m) => m.id));
    const local = seen.messages.filter((m) => {
      if (known.has(m.id)) return false;
      if (!m.id.startsWith("temp-")) return false;
      return !question.messages.some((row) => row.role === m.role && row.content === m.content);
    });
    return { ...question, messages: [...messages, ...local] };
  });
}

/** The persisted in-flight reply on a card, if one is running. */
export function workingMessage(question: TldrQuestion): TldrQuestionMessage | null {
  return question.messages.find((m) => m.role === "assistant" && m.status === "working") ?? null;
}
