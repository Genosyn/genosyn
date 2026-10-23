/**
 * The arithmetic of a group discussion — who speaks next, what counts as
 * adding nothing, when a round is over and when the talk should end.
 *
 * Kept free of the database and of any model call so every rule here is
 * pinned by a plain unit test (`groupDiscussionPlan.test.ts`). The service
 * that drives a real discussion (`groupDiscussions.ts`) persists the state
 * these functions return and asks them every question about order and
 * termination; it never decides either on its own.
 *
 * The rules, in one place:
 *
 *  - **Turn order.** Each round every available participant speaks at most
 *    once. The lead opens round one. Within a round, a participant someone
 *    addressed by `@handle` speaks before the others still waiting; one who was
 *    addressed after already speaking opens the next round.
 *  - **Adding nothing.** A turn that says `PASS`, or only agrees, or repeats an
 *    earlier message closely enough, is not content. It is recorded, not
 *    posted.
 *  - **Ending.** A round with no content ends the discussion (converged, or
 *    repetition when the round was all repeats). So do the last round, the
 *    turn ceiling, the usage ceiling and the wall-clock ceiling. New input from
 *    a Member mid-discussion buys at most two extra rounds in total.
 */

/** Bounds every discussion runs under. Exported for the UI and the docs' numbers. */
export const GROUP_DISCUSSION_LIMITS = {
  /** AI Employees that can take part at once. */
  maxParticipants: 6,
  /** Fewest AI Employees an explicit start may name. */
  minParticipantsToStart: 2,
  defaultRounds: 3,
  maxRounds: 5,
  /** Extra rounds a Member's mid-discussion input can buy, in total. */
  maxExtraRounds: 2,
  /** Hard ceiling on turns, whatever the roster and rounds multiply to. */
  maxTurnsCeiling: 40,
  /** Model steps one turn may take — room to read a fact or two, no more. */
  turnMaxSteps: 8,
  /** Wall-clock ceiling for one turn. */
  turnTimeoutMs: 6 * 60_000,
  /** Wall-clock ceiling for the whole discussion, outcome included. */
  discussionTimeoutMs: 45 * 60_000,
  /** Provider-reported tokens, every turn and the outcome together. */
  tokenBudget: 800_000,
  /** Usage share kept back so the outcome can always be written. */
  outcomeReserveRatio: 0.1,
  /** Longest message a turn may post; longer is clipped with a note. */
  maxTurnChars: 6_000,
  /** Longest question a discussion takes. */
  maxQuestionChars: 8_000,
} as const;

export type DiscussionPass = {
  employeeId: string;
  round: number;
  /** `pass` said so; `agree` only agreed; `repeat` restated an earlier message. */
  reason: "pass" | "agree" | "repeat";
};

export type DiscussionSkip = {
  employeeId: string;
  round: number;
  reason: "standdown" | "no_model" | "error" | "timeout" | "unavailable";
  detail?: string;
};

/** The bookkeeping persisted on `GroupDiscussion.stateJson`. */
export type DiscussionState = {
  /** Participants who have taken (or lost) their turn this round. */
  spoken: string[];
  /** Addressed this round and still waiting: they speak first. */
  queue: string[];
  /** Addressed after speaking this round: they open the next one. */
  carry: string[];
  /** Whether any turn this round added something. */
  roundHadContent: boolean;
  /** Whether this round's only non-content turns were repeats. */
  roundHadRepeat: boolean;
  passes: DiscussionPass[];
  skipped: DiscussionSkip[];
  /** Participants who cannot speak again in this discussion (no AI Model). */
  benched: string[];
  /** Rounds granted for Member input mid-discussion. */
  extraRounds: number;
  /** Who brought whom in, in order. `by` null means a Member's @mention. */
  added: Array<{ employeeId: string; by: string | null; round: number }>;
  /** Member messages written into the discussion that the driver has folded in. */
  inputsSeen: string[];
};

/** Most Member inputs remembered; older ones were folded in long ago. */
const INPUTS_SEEN_MAX = 200;

export function emptyDiscussionState(): DiscussionState {
  return {
    spoken: [],
    queue: [],
    carry: [],
    roundHadContent: false,
    roundHadRepeat: false,
    passes: [],
    skipped: [],
    benched: [],
    extraRounds: 0,
    added: [],
    inputsSeen: [],
  };
}

/** Record that a Member's input message has been folded in. */
export function markInputSeen(state: DiscussionState, messageId: string): DiscussionState {
  if (state.inputsSeen.includes(messageId)) return state;
  return { ...state, inputsSeen: [...state.inputsSeen, messageId].slice(-INPUTS_SEEN_MAX) };
}

/** Parse persisted state, tolerating rows written by an older shape. */
export function parseDiscussionState(raw: string | null | undefined): DiscussionState {
  const base = emptyDiscussionState();
  if (!raw) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    spoken: strings(p.spoken),
    queue: strings(p.queue),
    carry: strings(p.carry),
    roundHadContent: p.roundHadContent === true,
    roundHadRepeat: p.roundHadRepeat === true,
    passes: Array.isArray(p.passes) ? (p.passes as DiscussionPass[]).filter(isPass) : [],
    skipped: Array.isArray(p.skipped) ? (p.skipped as DiscussionSkip[]).filter(isSkip) : [],
    benched: strings(p.benched),
    extraRounds:
      typeof p.extraRounds === "number" && Number.isFinite(p.extraRounds)
        ? Math.max(0, Math.min(GROUP_DISCUSSION_LIMITS.maxExtraRounds, p.extraRounds))
        : 0,
    added: Array.isArray(p.added)
      ? (p.added as DiscussionState["added"]).filter(
          (a) => a && typeof a.employeeId === "string" && typeof a.round === "number",
        )
      : [],
    inputsSeen: strings(p.inputsSeen).slice(-INPUTS_SEEN_MAX),
  };
}

function isPass(value: unknown): value is DiscussionPass {
  const v = value as DiscussionPass;
  return Boolean(v) && typeof v.employeeId === "string" && typeof v.round === "number";
}

function isSkip(value: unknown): value is DiscussionSkip {
  const v = value as DiscussionSkip;
  return Boolean(v) && typeof v.employeeId === "string" && typeof v.round === "number";
}

export function parseParticipants(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === "string" && x.length > 0))];
  } catch {
    return [];
  }
}

/**
 * Who speaks next this round, or null when the round is over.
 *
 * `unavailable` holds participants who cannot take a turn right now — stood
 * down, benched for having no AI Model. They are passed over without being
 * marked as having spoken, so one lifted mid-round still gets their turn.
 */
export function pickNextSpeaker(
  participants: readonly string[],
  state: DiscussionState,
  unavailable: ReadonlySet<string> = new Set(),
): string | null {
  const waiting = participants.filter(
    (id) => !state.spoken.includes(id) && !unavailable.has(id) && !state.benched.includes(id),
  );
  if (waiting.length === 0) return null;
  for (const addressed of state.queue) {
    if (waiting.includes(addressed)) return addressed;
  }
  return waiting[0];
}

export type TurnKind = "spoke" | "pass" | "agree" | "repeat" | "skipped";

/**
 * Fold one finished turn into the state.
 *
 * `addressed` are the participants the turn named by `@handle`; addressing
 * yourself is ignored. Only a turn that spoke can address anyone — a pass is
 * not posted, so nobody would see whom it named.
 */
export function recordTurn(
  state: DiscussionState,
  args: {
    speaker: string;
    round: number;
    kind: TurnKind;
    addressed?: readonly string[];
    skip?: Omit<DiscussionSkip, "employeeId" | "round">;
  },
): DiscussionState {
  const next: DiscussionState = {
    ...state,
    spoken: state.spoken.includes(args.speaker) ? state.spoken : [...state.spoken, args.speaker],
    queue: state.queue.filter((id) => id !== args.speaker),
    carry: [...state.carry],
    passes: [...state.passes],
    skipped: [...state.skipped],
  };
  if (args.kind === "spoke") {
    next.roundHadContent = true;
    for (const id of args.addressed ?? []) {
      if (id === args.speaker) continue;
      if (next.spoken.includes(id)) {
        if (!next.carry.includes(id)) next.carry.push(id);
      } else if (!next.queue.includes(id)) {
        next.queue.push(id);
      }
    }
  } else if (args.kind === "skipped") {
    next.skipped.push({
      employeeId: args.speaker,
      round: args.round,
      reason: args.skip?.reason ?? "unavailable",
      ...(args.skip?.detail ? { detail: args.skip.detail } : {}),
    });
  } else {
    next.passes.push({ employeeId: args.speaker, round: args.round, reason: args.kind });
    if (args.kind === "repeat") next.roundHadRepeat = true;
  }
  return next;
}

/** Take a participant out for the rest of the discussion (no AI Model). */
export function benchParticipant(state: DiscussionState, employeeId: string): DiscussionState {
  if (state.benched.includes(employeeId)) return state;
  return { ...state, benched: [...state.benched, employeeId] };
}

export type RoundDecision =
  | { next: "continue"; state: DiscussionState }
  | { next: "end"; reason: "converged" | "repetition" | "max_rounds"; state: DiscussionState };

/**
 * Close a round: end the discussion, or reset for the next one.
 *
 * A quiet round ends it however many rounds remain — that is the discussion
 * converging, and spending more turns would only be paying for agreement.
 */
export function completeRound(
  state: DiscussionState,
  round: number,
  maxRounds: number,
): RoundDecision {
  const reset: DiscussionState = {
    ...state,
    spoken: [],
    queue: [...state.carry],
    carry: [],
    roundHadContent: false,
    roundHadRepeat: false,
  };
  if (!state.roundHadContent) {
    return { next: "end", reason: state.roundHadRepeat ? "repetition" : "converged", state: reset };
  }
  if (round >= maxRounds + state.extraRounds) {
    return { next: "end", reason: "max_rounds", state: reset };
  }
  return { next: "continue", state: reset };
}

/**
 * A Member wrote into a running discussion. The round keeps going, but a
 * final round gains one more — capped, so input can never keep it alive.
 */
export function noteMemberInput(
  state: DiscussionState,
  round: number,
  maxRounds: number,
): DiscussionState {
  const lastRound = round >= maxRounds + state.extraRounds;
  if (!lastRound || state.extraRounds >= GROUP_DISCUSSION_LIMITS.maxExtraRounds) {
    return { ...state, roundHadContent: true };
  }
  return { ...state, roundHadContent: true, extraRounds: state.extraRounds + 1 };
}

/** Turn ceiling for a roster: every round plus the extra ones, capped. */
export function maxTurnsFor(participantCount: number, maxRounds: number): number {
  return Math.min(
    GROUP_DISCUSSION_LIMITS.maxTurnsCeiling,
    Math.max(1, participantCount) * (maxRounds + GROUP_DISCUSSION_LIMITS.maxExtraRounds),
  );
}

export function clampRounds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return GROUP_DISCUSSION_LIMITS.defaultRounds;
  }
  return Math.max(1, Math.min(GROUP_DISCUSSION_LIMITS.maxRounds, Math.round(value)));
}

export type BudgetStop = "turn_budget" | "usage_budget" | "time_limit" | null;

/**
 * Whether the discussion has spent what it may before another turn starts.
 * The usage check keeps a reserve back so the outcome can still be written.
 */
export function budgetStop(args: {
  turnsTaken: number;
  maxTurns: number;
  tokensUsed: number;
  tokenBudget: number;
  startedAt: Date;
  now: Date;
}): BudgetStop {
  if (args.turnsTaken >= args.maxTurns) return "turn_budget";
  if (
    args.tokenBudget > 0 &&
    args.tokensUsed >= args.tokenBudget * (1 - GROUP_DISCUSSION_LIMITS.outcomeReserveRatio)
  ) {
    return "usage_budget";
  }
  if (args.now.getTime() - args.startedAt.getTime() >= GROUP_DISCUSSION_LIMITS.discussionTimeoutMs) {
    return "time_limit";
  }
  return null;
}

// ─────────────────────────── Reading a turn ───────────────────────────

/** Fold case, strip markdown and punctuation, collapse whitespace. */
export function normalizeTurnText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#[\]()|]/g, " ")
    .replace(/[^\p{L}\p{N}@\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exactly "pass", however it is dressed: `PASS`, `[pass]`, `**Pass.**`. */
const PASS_EXACT_RE = /^(?:\*\*|__)?\[?\s*pass\s*\]?[.!]?(?:\*\*|__)?$/i;
/**
 * "PASS — I agree with Ben." Capitals only, so a turn that opens with the verb
 * ("Pass the budget to finance first…") is still read as content.
 */
const PASS_PREFIX_RE = /^(?:\*\*|__)?\[?PASS\]?(?:\*\*|__)?[\s.!,:;—–-]/;
const PASS_PREFIX_MAX_CHARS = 200;

/**
 * Agreement with nothing added. Short, says one of the words people agree
 * with, and carries no sign of content: no number, no "but", no proposal, no
 * question, no negation. "I disagree" never matches — `\bagree` needs the
 * word to start there.
 */
const AGREE_RE =
  /\b(?:agree|agreed|concur|same here|sounds good|looks good|works for me|no objections?|nothing (?:new |more |else |further )?to add|that covers it|all good)\b/;
const CONTENT_SIGNAL_RE =
  /\d|\b(?:but|however|although|though|except|caveat|unless|instead|disagree|should|would|could|must|need|needs|suggest|propose|recommend|also|only if|one thing|not|don t|doesn t|didn t|won t|can t|isn t|aren t|why|how|what|when|where|who)\b/;
const AGREE_MAX_CHARS = 100;

export type TurnReading =
  | { kind: "pass" }
  | { kind: "agree" }
  | { kind: "repeat"; similarTo: number }
  | { kind: "spoke"; text: string; clipped: boolean };

/**
 * Decide what a reply amounts to. `earlier` is every message already in the
 * discussion, the speaker's own included.
 */
export function readTurn(reply: string, earlier: readonly string[]): TurnReading {
  const trimmed = reply.trim();
  if (!trimmed || PASS_EXACT_RE.test(trimmed)) return { kind: "pass" };
  if (trimmed.length <= PASS_PREFIX_MAX_CHARS && PASS_PREFIX_RE.test(trimmed)) {
    return { kind: "pass" };
  }
  const normalized = normalizeTurnText(trimmed);
  if (!normalized) return { kind: "pass" };
  if (/^\+1(?:\s|[.!]|$)/.test(trimmed) && trimmed.length <= AGREE_MAX_CHARS) return { kind: "agree" };
  if (
    normalized.length <= AGREE_MAX_CHARS &&
    AGREE_RE.test(normalized) &&
    !CONTENT_SIGNAL_RE.test(normalized)
  ) {
    return { kind: "agree" };
  }
  let best = 0;
  for (const prior of earlier) {
    best = Math.max(best, similarity(trimmed, prior));
  }
  if (best >= REPEAT_THRESHOLD) return { kind: "repeat", similarTo: best };
  const max = GROUP_DISCUSSION_LIMITS.maxTurnChars;
  if (trimmed.length > max) {
    return { kind: "spoke", text: `${trimmed.slice(0, max).trimEnd()}…`, clipped: true };
  }
  return { kind: "spoke", text: trimmed, clipped: false };
}

/** Bigram overlap at or above this reads as saying the same thing again. */
export const REPEAT_THRESHOLD = 0.8;

/**
 * Word-bigram Jaccard similarity, 0..1. Bigrams rather than words so two
 * messages about the same topic in different sentences stay apart, while a
 * paragraph pasted back with a word changed does not.
 */
export function similarity(a: string, b: string): number {
  const sa = bigrams(normalizeTurnText(a));
  const sb = bigrams(normalizeTurnText(b));
  if (sa.size === 0 || sb.size === 0) {
    return normalizeTurnText(a) === normalizeTurnText(b) && sa.size === sb.size ? 1 : 0;
  }
  let shared = 0;
  for (const g of sa) if (sb.has(g)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

function bigrams(text: string): Set<string> {
  const words = text.split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

const HANDLE_RE = /(^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/gi;

/** `@handles` in a message, lower-cased, in order of first appearance. */
export function mentionedHandles(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(HANDLE_RE)) {
    const handle = match[2].toLowerCase();
    if (!out.includes(handle)) out.push(handle);
  }
  return out;
}

/**
 * Split a message's `@handles` into participants it addressed and company AI
 * Employees it named who are not in the discussion yet.
 */
export function classifyMentions(
  text: string,
  participants: readonly { id: string; slug: string }[],
  company: readonly { id: string; slug: string }[],
): { addressed: string[]; outsiders: string[] } {
  const bySlug = new Map(company.map((e) => [e.slug.toLowerCase(), e.id]));
  const inside = new Set(participants.map((p) => p.id));
  const addressed: string[] = [];
  const outsiders: string[] = [];
  for (const handle of mentionedHandles(text)) {
    const id = bySlug.get(handle);
    if (!id) continue;
    if (inside.has(id)) {
      if (!addressed.includes(id)) addressed.push(id);
    } else if (!outsiders.includes(id)) {
      outsiders.push(id);
    }
  }
  return { addressed, outsiders };
}
