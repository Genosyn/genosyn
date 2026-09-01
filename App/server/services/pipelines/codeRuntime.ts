import { Worker } from "node:worker_threads";

import { config } from "../../../config.js";
import { makeCodeHttpClient } from "./codeHttp.js";
import { makeCodeSdk } from "./codeSdk.js";
import { NodeOutputs, RunEnv } from "./types.js";

/**
 * Main-thread orchestrator for the `logic.code` node.
 *
 * The Member's JavaScript never runs on the server's event loop: each step
 * gets a one-shot worker thread (see codeWorker.ts) whose heap is capped by
 * `resourceLimits` and which the deadline below can always stop with
 * `worker.terminate()` — including a `for(;;){}` resumed after an await,
 * which no in-process timer could preempt. The worker holds no database or
 * config access; the `genosyn` Base SDK and the axios transport execute here
 * and answer the worker over a message RPC carrying only JSON.
 *
 * Trust model: a pipeline is authored by a company admin in the UI, and every
 * node already runs with company authority (`logic.http` reaches the network,
 * `integration.invoke` spends real money). The vm context inside the worker
 * keeps honest code honest — fresh globals, dynamic code generation disabled,
 * hard time and memory bounds — but it is not a hard security boundary
 * against a determined attacker; admin-gated authoring is.
 */

const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 60;
/** Worker heap caps — an allocation storm kills the worker, not the server. */
const WORKER_MAX_OLD_GEN_MB = 256;
const WORKER_MAX_YOUNG_GEN_MB = 32;
/**
 * The worker enforces the deadline itself for async waits; this grace period
 * only delays the terminate() backstop that catches CPU-bound loops, so the
 * friendly in-worker timeout error wins whenever the worker is responsive.
 */
const TERMINATE_GRACE_MS = 500;

export type ExecutePipelineCodeArgs = {
  code: string;
  timeoutSeconds: unknown;
  companyId: string;
  env: RunEnv;
  log: (line: string) => void;
};

export function clampTimeoutSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(n)));
}

/** JSON round-trip so the worker sees plain data, never live host objects. */
function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as T;
  } catch {
    return null as T;
  }
}

/**
 * In dev and tests this module runs from TypeScript source under tsx, whose
 * loader (inherited through execArgv) also resolves a `.ts` worker entry; the
 * compiled build ships the `.js` sibling in dist.
 */
function workerEntryUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./codeWorker.${ext}`, import.meta.url);
}

type WorkerMessage =
  | { type: "log"; line: string }
  | { type: "call"; id: number; target: string; args: unknown[] }
  | { type: "done"; serialized: string | null }
  | { type: "fail"; message: string };

/**
 * Shared SaaS refuses the code node outright.
 *
 * `vm.createContext` is not a security boundary and this module has always
 * said so: the callables handed to the sandbox are ordinary host functions, so
 * `axios.constructor.constructor("return process")()` walks back out to the
 * worker's own realm. That realm is a *thread*, not a process — it shares the
 * pid, it receives a copy of the parent environment because no `env` is passed
 * to `new Worker`, and `process.binding` still reaches `spawn_sync` and `fs`.
 * On a hosted install that is the encryption secret (the root of every
 * tenant's Vault), the session secret, and the database URL, for any signup
 * that reaches company admin — which is every signup, on its own company.
 *
 * Scrubbing the worker environment would not fix it: the escaped realm can
 * still exec and read the mounted config. The boundary has to be that the code
 * never runs at all, which is what this refusal is.
 *
 * Single-tenant self-host keeps the node. There the documented trust model —
 * a company admin authored it, and every other node already runs with company
 * authority — is coherent, because the admin already owns the box.
 */
export function pipelineCodeAllowed(): boolean {
  return !config.security.multiTenant;
}

export function assertPipelineCodeAllowed(): void {
  if (!pipelineCodeAllowed()) {
    throw new Error(
      "The Run JavaScript step is unavailable in shared SaaS mode, because its sandbox is not a security boundary.",
    );
  }
}

export async function executePipelineCode(args: ExecutePipelineCodeArgs): Promise<NodeOutputs> {
  assertPipelineCodeAllowed();
  const timeoutSeconds = clampTimeoutSeconds(args.timeoutSeconds);
  const timeoutMs = timeoutSeconds * 1000;
  const deadlineAt = Date.now() + timeoutMs;
  const timedOut = () => new Error(`Code step timed out after ${timeoutSeconds}s`);

  const sdk = makeCodeSdk({ companyId: args.companyId, deadlineAt, log: args.log });
  const http = makeCodeHttpClient({ deadlineAt, log: args.log });

  async function dispatch(target: string, callArgs: unknown[]): Promise<unknown> {
    if (target === "http.request") {
      const config = (callArgs[0] ?? {}) as Record<string, unknown>;
      // Status validation happens in the worker, where the sandbox's own
      // `validateStatus` function lives — always hand the response back.
      return http.request({ ...config, validateStatus: null });
    }
    if (target.startsWith("base.")) {
      const method = target.slice("base.".length) as keyof ReturnType<
        typeof makeCodeSdk
      >["base"];
      const fn = sdk.base[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof fn === "function") return fn(...callArgs);
    }
    throw new Error(`Unknown SDK call: ${target}`);
  }

  const worker = new Worker(workerEntryUrl(), {
    workerData: {
      code: args.code,
      timeoutSeconds,
      deadlineAt,
      input: cloneJson(args.env.trigger.payload),
      trigger: cloneJson(args.env.trigger),
      steps: cloneJson(args.env.nodeOutputs),
    },
    resourceLimits: {
      maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB,
      maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GEN_MB,
    },
  });

  let terminateTimer: NodeJS.Timeout | null = null;
  // Main-side SDK/HTTP calls still running when the step settles (a
  // fire-and-forget call, or a slow write racing the deadline) are drained
  // before this function returns, so their effects and log lines land inside
  // the step instead of leaking into the next node or a finalized run row.
  const inflight = new Set<Promise<void>>();
  let settled = false;
  try {
    const serialized = await new Promise<string | null>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      terminateTimer = setTimeout(
        () => {
          // Only a stuck worker reaches this point — a responsive one has
          // already reported its own, identical timeout error.
          void worker.terminate();
          settle(() => reject(timedOut()));
        },
        Math.max(1, deadlineAt - Date.now()) + TERMINATE_GRACE_MS,
      );

      worker.on("message", (message: WorkerMessage) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "log") {
          args.log(String(message.line));
          return;
        }
        if (message.type === "call") {
          if (settled) return;
          const pending = dispatch(
            String(message.target),
            Array.isArray(message.args) ? message.args : [],
          )
            .then((value) => {
              worker.postMessage({ type: "reply", id: message.id, ok: true, value });
            })
            .catch((err: unknown) => {
              worker.postMessage({
                type: "reply",
                id: message.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          inflight.add(pending);
          void pending.finally(() => inflight.delete(pending));
          return;
        }
        if (message.type === "done") {
          settle(() => resolve(message.serialized));
          return;
        }
        if (message.type === "fail") {
          settle(() => reject(new Error(String(message.message))));
        }
      });

      worker.on("error", (err) => {
        const oom = (err as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY";
        settle(() =>
          reject(
            oom
              ? new Error(`Code step ran out of memory (${WORKER_MAX_OLD_GEN_MB}MB limit)`)
              : err,
          ),
        );
      });

      worker.on("exit", (exitCode) => {
        settle(() => reject(new Error(`Code step worker exited unexpectedly (code ${exitCode})`)));
      });
    });

    if (serialized === null) return {};
    const plain = JSON.parse(serialized) as unknown;
    if (plain && typeof plain === "object" && !Array.isArray(plain)) {
      return plain as NodeOutputs;
    }
    return { result: plain };
  } finally {
    if (terminateTimer) clearTimeout(terminateTimer);
    if (inflight.size > 0) await Promise.allSettled([...inflight]);
    void worker.terminate();
  }
}
