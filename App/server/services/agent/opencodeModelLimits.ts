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

/** Apply private config and wait until the previous model instance is disposed. */
export async function updateOpenCodeGlobalConfig(
  client: OpencodeClient,
  server: OpenCodeServer,
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(60_000);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    await Promise.race([
      client.global.config.update({ config }, { signal: requestSignal }),
      server.exited,
    ]);
    // The update eagerly starts a background disposal. In the pinned engine,
    // this synchronous endpoint joins that same in-flight instance disposer.
    // Waiting for global.disposed is unsafe: the event stream sends connected
    // before attaching its listener, and unchanged config emits no disposal.
    await Promise.race([client.global.dispose({ signal: requestSignal }), server.exited]);
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw new Error("OpenCode did not finish applying its model configuration.");
    throw error;
  }
}
import type { OpencodeClient, Config } from "@opencode-ai/sdk/v2";
import type { OpenCodeServer } from "./opencodeServer.js";
