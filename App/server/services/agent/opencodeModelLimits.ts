/** Reconcile the saved context window with OpenCode's resolved provider metadata. */
export function openCodeModelLimits(
  catalog: { context: number; input?: number; output: number },
  savedContext: number | null,
): { context: number; input?: number; output: number } {
  const context = savedContext ?? catalog.context;
  if (!context) return { ...catalog, context: 0 };
  // Keep room for input even when an older catalog entry permits output as
  // large as its entire context. The published output ceiling always wins.
  const availableOutput = Math.max(1, Math.floor(context / 2));
  return {
    context,
    input: Math.min(catalog.input || context, context),
    output: catalog.output > 0 ? Math.min(catalog.output, availableOutput) : availableOutput,
  };
}

/** The config API responds before its background instance disposal finishes. */
export async function updateOpenCodeGlobalConfig(
  client: OpencodeClient,
  server: OpenCodeServer,
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const eventSignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(60_000),
    ...(signal ? [signal] : []),
  ]);
  const subscription = await client.global.event({ signal: eventSignal, sseMaxRetryAttempts: 0 });
  let connectedResolve!: () => void;
  let disposedResolve!: () => void;
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve;
  });
  const disposed = new Promise<void>((resolve) => {
    disposedResolve = resolve;
  });
  let completed = false;
  const listen = (async () => {
    for await (const packet of subscription.stream) {
      if (packet.payload.type === "server.connected") connectedResolve();
      if (packet.payload.type === "global.disposed") {
        completed = true;
        disposedResolve();
        return;
      }
    }
    if (!completed) throw new Error("OpenCode did not finish applying its model configuration.");
  })();
  void listen.catch(() => {});
  try {
    await Promise.race([connected, listen, server.exited]);
    await Promise.race([
      client.global.config.update({ config }, { signal: eventSignal }),
      server.exited,
    ]);
    await Promise.race([disposed, listen, server.exited]);
  } finally {
    controller.abort();
    await listen.catch(() => {});
  }
}
import type { OpencodeClient, Config } from "@opencode-ai/sdk/v2";
import type { OpenCodeServer } from "./opencodeServer.js";
