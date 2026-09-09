import type { CodexAppServer } from "./agent/codexAppServer.js";
import { assertCodexThreadPosture } from "./agent/codexThreadPosture.js";
import { ModelSetupError } from "./modelCatalog.js";

/** Authenticate alone is insufficient: verify a real, isolated model turn before saving. */
export async function verifyCodexModel(
  server: CodexAppServer,
  cwd: string,
  requestedModel: string,
): Promise<string> {
  const model = requestedModel === "auto" ? await discoverCodexDefault(server) : requestedModel;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let hasReply = false;
  let completed = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Register before turn/start: very short turns can finish before its RPC reply.
  const stop = server.onNotification((method, raw) => {
    const body = object(raw);
    if (!body || body.threadId !== threadId) return;
    if (method === "item/completed") {
      const item = object(body.item);
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
        hasReply = true;
    }
    if (method !== "turn/completed") return;
    const turn = object(body.turn);
    if (turnId && turn?.id !== turnId) return;
    if (turn?.status !== "completed") {
      rejectDone(
        new ModelSetupError(
          "ChatGPT sign-in worked, but the AI Model could not answer. Check your workspace access and usage limits, then try again.",
        ),
      );
      return;
    }
    if (!hasReply) {
      rejectDone(
        new ModelSetupError(
          "ChatGPT completed the connection test without a reply. Please try again.",
        ),
      );
      return;
    }
    resolveDone();
  });
  const stopExit = server.onExit(() =>
    rejectDone(
      new ModelSetupError(
        "ChatGPT disconnected during its connection test. Please try again.",
        502,
      ),
    ),
  );
  const timeout = setTimeout(
    () =>
      rejectDone(
        new ModelSetupError("The ChatGPT connection test timed out. Please try again.", 504),
      ),
    45_000,
  );
  // A rejected notification promise must have a handler even while the RPC is pending.
  void done.catch(() => undefined);
  try {
    const started = await server.request<unknown>(
      "thread/start",
      {
        model,
        modelProvider: "openai",
        allowProviderModelFallback: false,
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: "This is a connection test. Reply with only OK. Do not use any tools.",
        developerInstructions: "Reply with only OK.",
        personality: "none",
        ephemeral: true,
        environments: [],
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        dynamicTools: [],
        serviceName: "genosyn",
        threadSource: "genosyn",
      },
      20_000,
    );
    threadId = assertCodexThreadPosture(started, { cwd, model });
    const startedTurn = await server.request<{ turn: { id: string } }>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: "Reply with only OK.", text_elements: [] }],
        approvalPolicy: "never",
      },
      20_000,
    );
    if (!startedTurn.turn?.id)
      throw new ModelSetupError(
        "ChatGPT did not start the connection test. Please try again.",
        502,
      );
    turnId = startedTurn.turn.id;
    await done;
    completed = true;
    return model;
  } finally {
    clearTimeout(timeout);
    stop();
    stopExit();
    if (!completed && threadId && turnId) {
      await server.request("turn/interrupt", { threadId, turnId }, 2_000).catch(() => undefined);
    }
  }
}

export async function discoverCodexDefault(server: CodexAppServer): Promise<string> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page += 1) {
    const result: unknown = await server.request(
      "model/list",
      { cursor, limit: 100, includeHidden: false },
      20_000,
    );
    const body = object(result);
    if (!Array.isArray(body?.data)) break;
    for (const raw of body.data) {
      const model = object(raw);
      if (model?.isDefault !== true || model.hidden === true) continue;
      if (typeof model.model === "string" && model.model.trim() && model.model.length <= 120)
        return model.model;
    }
    if (typeof body.nextCursor !== "string" || !body.nextCursor || seen.has(body.nextCursor)) break;
    cursor = body.nextCursor;
    seen.add(cursor);
  }
  throw new ModelSetupError(
    "ChatGPT did not return a default AI Model for this workspace. Enter an available model ID in model settings, then try again.",
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
