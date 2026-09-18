import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { Agent } from "undici";
import type { AIModel } from "../../db/entities/AIModel.js";
import type { ModelEffort } from "../../../shared/modelEffort.js";
import type { PrivilegedToolCallAuthorizer } from "../memberTurnAuthority.js";
import type { AgentMessage, StreamCallbacks } from "./types.js";
import type { ToolRegistry } from "./tools/toolRegistry.js";
import {
  buildOpenCodeConfig,
  openCodePromptParts,
  OPENCODE_AGENT,
  openCodeProviderId,
  OPENCODE_NATIVE_PERMISSIONS,
  resolveOpenCodeModel,
} from "./opencodeConfig.js";
import { serveOpenCodeTools } from "./opencodeMcp.js";
import { startOpenCodeServer, type OpenCodeServer } from "./opencodeServer.js";
import { OpenCodeEvents, openCodeActivityError } from "./opencodeEvents.js";
import { serveOpenCodeModel } from "./opencodeProxy.js";
import { openCodeModelLimits, updateOpenCodeGlobalConfig } from "./opencodeModelLimits.js";
import { OpenCodeToolGate } from "./opencodeToolGate.js";
import { recoverOpenCodePrompt } from "./opencodeRecovery.js";

export type OpenCodeTurnParams = {
  model: AIModel;
  effort?: ModelEffort | null;
  system: string;
  messages: AgentMessage[];
  registry: ToolRegistry;
  maxSteps: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
  cwd?: string;
  toolEnv?: Record<string, string>;
  bashTimeoutMs?: number;
  nativeCoding?: boolean;
  authorizePrivilegedToolCall?: PrivilegedToolCallAuthorizer;
};
export type OpenCodeTurnResult = { finalText: string; steps: number; stopReason: string };

/** OpenCode owns model calls, tool sequencing, retries and context compaction. */
export async function runOpenCodeTurn(params: OpenCodeTurnParams): Promise<OpenCodeTurnResult> {
  if (params.signal?.aborted) return { finalText: "", steps: 0, stopReason: "aborted" };
  const model = await resolveOpenCodeModel(params.model);
  const gate = new OpenCodeToolGate(params.signal);
  let bridge: Awaited<ReturnType<typeof serveOpenCodeTools>> | undefined;
  let proxy: Awaited<ReturnType<typeof serveOpenCodeModel>> | undefined;
  let server: OpenCodeServer | undefined;
  try {
    bridge = await serveOpenCodeTools({ ...params, beforeCall: (name) => gate.enter(name) });
    proxy = await serveOpenCodeModel(model, params.signal);
    server = await startOpenCodeServer({
      config: buildOpenCodeConfig({
        model: proxy.model,
        effort: params.effort,
        maxSteps: params.maxSteps,
        nativeCoding: params.nativeCoding ?? false,
        mcp: bridge,
      }),
      cwd: params.nativeCoding ? params.cwd : undefined,
      toolEnv: params.nativeCoding ? params.toolEnv : undefined,
      bashTimeoutMs: params.bashTimeoutMs,
      signal: params.signal,
    });
    return await runOpenCodeSession(server, model.id, params, gate);
  } catch (error) {
    if (params.signal?.aborted) return { finalText: "", steps: 0, stopReason: "aborted" };
    throw error;
  } finally {
    gate.close();
    await server?.close();
    await proxy?.close();
    await bridge?.close();
  }
}

export async function runOpenCodeSession(
  server: OpenCodeServer,
  modelId: string,
  params: OpenCodeTurnParams,
  toolGate?: OpenCodeToolGate,
): Promise<OpenCodeTurnResult> {
  // The prompt response spans the entire session, including tool work. Its
  // deadline belongs to the caller, not undici's shorter response timeout.
  const dispatcher = new Agent({ pipelining: 0, headersTimeout: 0, bodyTimeout: 0 });
  const localFetch: typeof fetch = (input, init) => {
    const options = { ...init, dispatcher, redirect: "error" as const };
    return fetch(input, options);
  };
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: server.directory,
    headers: { Authorization: server.authorization },
    throwOnError: true,
    fetch: localFetch,
  });
  try {
    return await runOpenCodeSessionWithClient(server, modelId, params, toolGate, client);
  } finally {
    await dispatcher.destroy();
  }
}

async function runOpenCodeSessionWithClient(
  server: OpenCodeServer,
  modelId: string,
  params: OpenCodeTurnParams,
  toolGate: OpenCodeToolGate | undefined,
  client: ReturnType<typeof createOpencodeClient>,
): Promise<OpenCodeTurnResult> {
  const providerID = openCodeProviderId(params.model.provider);
  if (providerID === "openai") {
    const catalog = await Promise.race([
      client.provider.list({}, { signal: params.signal }),
      server.exited,
    ]);
    const registered = catalog.data?.all.find((provider) => provider.id === providerID)?.models[
      modelId
    ];
    if (!registered) throw new Error("OpenCode could not resolve the configured OpenAI model.");
    // Global config belongs to the disposable server HOME. Never use the
    // directory config endpoint, which could write into the employee cwd.
    await updateOpenCodeGlobalConfig(
      client,
      server,
      {
        provider: {
          [providerID]: {
            models: {
              [modelId]: {
                limit: openCodeModelLimits(registered.limit, params.model.contextWindow),
              },
            },
          },
        },
      },
      params.signal,
    );
  }
  const created = await client.session.create(
    { title: "Genosyn AI Employee", agent: OPENCODE_AGENT },
    { signal: params.signal },
  );
  if (!created.data) throw new Error("OpenCode did not create a session.");
  const sessionID = created.data.id;
  const events = new OpenCodeEvents(
    sessionID,
    params.callbacks,
    params.model.contextWindow,
    (part) => toolGate?.observe(part),
  );
  const streamController = new AbortController();
  const promptController = new AbortController();
  let limited = false;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await client.session
        .abort({ sessionID }, { signal: AbortSignal.timeout(5000) })
        .catch(() => {});
      promptController.abort();
    })());
  let connectedResolve!: () => void;
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve;
  });
  const abort = () => {
    void stop();
    streamController.abort();
    connectedResolve();
  };
  params.signal?.addEventListener("abort", abort, { once: true });
  let streamError: Error | undefined;
  let listen = Promise.resolve();
  const controlSignal = () =>
    AbortSignal.any([streamController.signal, AbortSignal.timeout(10_000)]);
  async function handlePermission(event: Event): Promise<void> {
    if (event.type === "permission.asked" && event.properties.sessionID === sessionID) {
      let denial = params.signal?.aborted
        ? "The turn has ended."
        : !params.nativeCoding || !OPENCODE_NATIVE_PERMISSIONS.includes(event.properties.permission)
          ? "This native tool is unavailable for this work surface."
          : await params.authorizePrivilegedToolCall?.();
      if (params.signal?.aborted) denial = "The turn has ended.";
      await client.permission.reply(
        {
          requestID: event.properties.id,
          reply: denial ? "reject" : "once",
          ...(denial ? { message: denial } : {}),
        },
        { signal: controlSignal() },
      );
    } else if (event.type === "question.asked" && event.properties.sessionID === sessionID) {
      await client.question.reject({ requestID: event.properties.id }, { signal: controlSignal() });
    }
  }

  try {
    if (params.signal?.aborted) abort();
    const subscription = await client.event.subscribe(
      {},
      {
        signal: streamController.signal,
        sseMaxRetryAttempts: 0,
        onSseError: (error) => {
          if (!streamController.signal.aborted) streamError = openCodeActivityError(error);
        },
      },
    );
    listen = (async () => {
      for await (const event of subscription.stream) {
        if (event.type === "server.connected") connectedResolve();
        events.accept(event);
        await handlePermission(event);
        if (events.steps >= params.maxSteps && !["end_turn", "stop"].includes(events.stopReason)) {
          limited = true;
          await stop();
        }
      }
      if (!streamController.signal.aborted)
        throw (
          streamError ?? new Error("OpenCode's activity stream ended before the turn finished.")
        );
    })().catch((error: unknown) => {
      if (streamController.signal.aborted) return;
      streamError =
        error instanceof Error ? error : new Error("OpenCode's activity stream failed.");
      promptController.abort();
      connectedResolve();
    });

    await Promise.race([
      connected,
      server.exited,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OpenCode's activity stream did not connect.")),
          10_000,
        );
        void connected.finally(() => clearTimeout(timer));
      }),
    ]);
    if (streamError) throw streamError;
    if (params.signal?.aborted) return { finalText: "", steps: 0, stopReason: "aborted" };
    const response = await Promise.race([
      client.session
        .prompt(
          {
            sessionID,
            agent: OPENCODE_AGENT,
            model: { providerID, modelID: modelId },
            system: `${params.system}\n\nGenosyn company tool names have a genosyn_ prefix in this runtime. When the instructions name a Genosyn tool such as find_tools or repository_read_file, call genosyn_find_tools or genosyn_repository_read_file. Arguments to call_tool still use the original unprefixed tool name. Conversation history is supplied as labelled records; continue the current request without replaying recorded actions.${params.nativeCoding ? "\nFor native coding, older Skills may name read_file, write_file, edit_file, or list_dir. Their OpenCode equivalents are read (filePath), write (filePath, content), edit (filePath, oldString, newString), and list (path). Native glob and grep use pattern and an optional path; bash uses command and description. Follow each available tool's actual schema. These native tools have no genosyn_ prefix." : ""}`,
            parts: openCodePromptParts(params.messages),
          },
          { signal: promptController.signal },
        )
        .catch((error: unknown) =>
          recoverOpenCodePrompt({
            session: client.session,
            sessionID,
            error,
            signal: params.signal
              ? AbortSignal.any([params.signal, promptController.signal])
              : promptController.signal,
            callbacks: params.callbacks,
          }),
        ),
      server.exited,
    ]);
    if (response.data) {
      events.accept({
        id: "final",
        type: "message.updated",
        properties: { sessionID, info: response.data.info },
      });
      for (const part of response.data.parts) events.part(part);
    }
    if (streamError) throw streamError;
    if (events.error) throw events.error;
    return {
      finalText: events.finalText,
      steps: events.steps,
      stopReason: limited ? "max_steps" : params.signal?.aborted ? "aborted" : events.stopReason,
    };
  } catch (error) {
    if (limited || params.signal?.aborted)
      return {
        finalText: events.finalText,
        steps: events.steps,
        stopReason: limited ? "max_steps" : "aborted",
      };
    throw streamError ?? events.error ?? error;
  } finally {
    params.signal?.removeEventListener("abort", abort);
    streamController.abort();
    promptController.abort();
    await listen;
    // A recovery wait can stop before the asynchronous session abort reaches
    // OpenCode. Keep its HTTP dispatcher alive until that bounded request ends.
    await stopping;
  }
}
