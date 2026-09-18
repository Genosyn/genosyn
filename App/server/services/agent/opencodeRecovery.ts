import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Part, createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { StreamCallbacks } from "./types.js";

type SessionReader = Pick<
  ReturnType<typeof createOpencodeClient>["session"],
  "status" | "messages"
>;

/**
 * Losing the synchronous prompt response does not stop OpenCode's work.
 * Reconnect to that same session using reads only: replaying the prompt could
 * repeat tools that have already changed company records or external systems.
 */
export async function recoverOpenCodePrompt(args: {
  session: SessionReader;
  sessionID: string;
  error: unknown;
  signal: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<{ data: { info: AssistantMessage; parts: Part[] } }> {
  const { session, sessionID, error, signal, callbacks } = args;
  signal.throwIfAborted();
  if (!isTransientConnectionError(error)) throw error;

  let failures = 0;
  for (let retry = 1; ; retry++) {
    signal.throwIfAborted();
    const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(retry - 1, 5));
    const delayMs = Math.floor(ceiling * (0.75 + Math.random() * 0.25));
    callbacks?.onModelRetry?.({
      attempt: retry + 1,
      maxAttempts: null,
      delayMs,
      reason: "Reconnecting to ongoing work",
    });
    await delay(delayMs, undefined, { signal });

    let last: { info: AssistantMessage; parts: Part[] } | undefined;
    try {
      // The original Run deadline bounds a healthy session that remains busy.
      // Individual reads also need a deadline so a stuck local server cannot
      // consume the whole Run without giving recovery another chance.
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const status = await session.status({}, { signal: readSignal });
      if (!status.data) throw new Error("OpenCode did not return its session status.");
      if (status.data[sessionID] && status.data[sessionID].type !== "idle") {
        failures = 0;
        continue;
      }
      // OpenCode removes idle sessions from its status map. Missing status
      // alone is not completion: a prompt that never arrived is missing too.
      const messages = await session.messages({ sessionID, limit: 1 }, { signal: readSignal });
      const message = messages.data?.at(-1);
      if (message?.info.role === "assistant") {
        last = { info: message.info, parts: message.parts };
      }
      failures = 0;
    } catch (readError) {
      signal.throwIfAborted();
      failures++;
      if (failures >= 10 || !isTransientConnectionError(readError)) throw readError;
      continue;
    }

    signal.throwIfAborted();
    if (last?.info.error?.name === "MessageAbortedError") {
      throw new Error("OpenCode stopped before the AI Model turn completed.");
    }
    if (
      !last ||
      last.info.time.completed == null ||
      (!last.info.error &&
        (!last.info.finish || ["tool-calls", "unknown"].includes(last.info.finish)))
    ) {
      throw error;
    }
    return { data: last };
  }
}

function isTransientConnectionError(error: unknown): boolean {
  const chain: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }
  // The SDK wraps HTTP errors with the status in cause.status. A permanent
  // response still wins when its human-readable message happens to say timeout.
  for (const record of chain) {
    const status = record.status ?? record.statusCode;
    if (typeof status === "number") return [408, 409, 429].includes(status) || status >= 500;
  }
  return chain.some((record) => {
    const description = [record.name, record.message, record.code]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /fetch failed|connection error|network|socket|timed? ?out|timeout|econnreset|econnrefused|eai_again|enotfound|epipe|und_err_/i.test(
      description,
    );
  });
}
