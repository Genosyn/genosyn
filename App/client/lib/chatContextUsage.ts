import type { ChatContextUsage, ConversationMessage } from "./api";

/**
 * Reading the chat context gauge.
 *
 * The server measures it (see `server/services/agent/contextUsage.ts`); this
 * module only decides what a human should read. It lives apart from
 * `chatSessions.tsx` and `EmployeeChat.tsx` because those are React surfaces
 * and this repo has no DOM test setup — a plain module is the only shape that
 * can actually be unit-tested (see `server/client/chatContextUsage.test.ts`).
 */

/**
 * Kept in step with `CONTEXT_WARN_PCT` in
 * `server/services/agent/contextUsage.ts`, which the Run transcript also uses.
 * Duplicated rather than imported because the client build cannot reach server
 * code; `server/client/chatContextUsage.test.ts` asserts the two stay equal.
 */
export const CONTEXT_WARN_PCT = 80;

export type ContextUsageTone = "normal" | "warn";

export type ContextUsageDisplay = {
  /** Compact badge text, e.g. `42%` or `128K tokens`. */
  label: string;
  /** Full sentence for the tooltip / screen readers. */
  title: string;
  /** Bar width 0-100, clamped — the raw percent is not. */
  fillPercent: number | null;
  tone: ContextUsageTone;
  /** True when the model has no known window and the gauge can't be a share. */
  windowUnknown: boolean;
};

/**
 * Read a `context` SSE frame, or return null.
 *
 * Validated the same way the `progress` frame is: an event arriving over a
 * long-lived stream is the one place a malformed payload would render as a
 * confident wrong number, so anything that isn't the expected shape is dropped
 * rather than coerced.
 */
export function parseContextUsageEvent(data: unknown): ChatContextUsage | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Partial<ChatContextUsage>;
  if (typeof candidate.tokens !== "number" || !Number.isFinite(candidate.tokens)) return null;
  if (candidate.tokens < 0) return null;
  const window =
    typeof candidate.window === "number" && Number.isFinite(candidate.window) && candidate.window > 0
      ? candidate.window
      : null;
  const percent =
    typeof candidate.percent === "number" && Number.isFinite(candidate.percent)
      ? candidate.percent
      : null;
  return {
    tokens: candidate.tokens,
    window,
    // A percent without a window is not a share of anything we can name, so
    // it's dropped alongside it rather than shown on its own.
    percent: window === null ? null : percent,
  };
}

/**
 * The newest reading in a loaded thread.
 *
 * Walks backwards over assistant messages, because the gauge describes the
 * model's prompt and only assistant turns have one. Telegram-authored replies
 * and every row written before this feature shipped carry nothing, so a thread
 * can legitimately have no reading at all.
 */
export function latestContextUsage(messages: ConversationMessage[]): ChatContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parsed = parseContextUsageEvent(message.context);
    if (parsed) return parsed;
  }
  return null;
}

/** `128000` → `128K`. Compact enough for a badge; exact figures go in the title. */
export function formatTokensCompact(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}K`;
  }
  const millions = tokens / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}M`;
}

/** Everything the badge needs, so the component holds no copy decisions. */
export function describeContextUsage(usage: ChatContextUsage): ContextUsageDisplay {
  const tokens = usage.tokens.toLocaleString();
  if (usage.percent === null || usage.window === null) {
    return {
      label: `${formatTokensCompact(usage.tokens)} tokens`,
      title:
        `This employee's last turn sent ${tokens} tokens. Genosyn doesn't know this ` +
        `AI Model's context window, so it can't show how full it is — set the window ` +
        `on the model to see a percentage.`,
      fillPercent: null,
      tone: "normal",
      windowUnknown: true,
    };
  }
  const tone: ContextUsageTone = usage.percent >= CONTEXT_WARN_PCT ? "warn" : "normal";
  return {
    label: `${usage.percent}%`,
    title:
      `Context used: ${tokens} of about ${usage.window.toLocaleString()} tokens ` +
      `(${usage.percent}%).` +
      (tone === "warn"
        ? " Genosyn will start dropping the oldest tool results to make room. Start a new context with /new to reset it."
        : ""),
    // The value can legitimately exceed 100 when a window was set too low by
    // hand; the bar clamps so it stays a bar, and the title keeps the truth.
    fillPercent: Math.max(0, Math.min(100, usage.percent)),
    tone,
    windowUnknown: false,
  };
}
