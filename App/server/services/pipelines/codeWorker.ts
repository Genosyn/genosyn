import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker-thread entry for the `logic.code` node.
 *
 * The Member's JavaScript runs here, not on the server's event loop, so a
 * busy loop can always be stopped: the main thread calls `worker.terminate()`
 * when the deadline passes, and `resourceLimits` caps the heap. This module
 * deliberately imports nothing from the app — the worker holds no database,
 * config, or credential access. Everything stateful (the `genosyn` Base SDK
 * and the axios transport) lives on the main thread and is reached through a
 * small message RPC; only JSON crosses the boundary.
 *
 * Protocol (worker → main): `{type:"log"}`, `{type:"call"}` (awaits a
 * `{type:"reply"}`), then one final `{type:"done"}` or `{type:"fail"}`.
 */

type WorkerInput = {
  code: string;
  timeoutSeconds: number;
  deadlineAt: number;
  input: unknown;
  trigger: unknown;
  steps: unknown;
};

type RpcReply = { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

/** Keep a runaway return value from bloating the PipelineRun row. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CONSOLE_LINE_CHARS = 2_000;

if (!parentPort) throw new Error("codeWorker must run inside a worker thread");
const port = parentPort;

const data = workerData as WorkerInput;
const timeoutMs = data.timeoutSeconds * 1000;
const timedOut = () => new Error(`Code step timed out after ${data.timeoutSeconds}s`);

// ── RPC to the main thread ──────────────────────────────────────────────────

let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

port.on("message", (message: RpcReply) => {
  if (!message || message.type !== "reply") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new Error(message.error ?? "Call failed"));
});

function rpc(target: string, args: unknown[]): Promise<unknown> {
  if (Date.now() >= data.deadlineAt) return Promise.reject(timedOut());
  // JSON round-trip so functions/undefined/cycles never hit structured clone.
  let cleanArgs: unknown[];
  try {
    cleanArgs = JSON.parse(JSON.stringify(args ?? []));
  } catch {
    return Promise.reject(new Error(`Arguments to ${target} must be JSON-serializable`));
  }
  const id = nextCallId;
  nextCallId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "call", id, target, args: cleanArgs });
  });
}

// ── Sandbox surface ─────────────────────────────────────────────────────────

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  // Errors raised inside the vm belong to the context realm, so check the
  // shape rather than `instanceof Error`.
  if (arg && typeof arg === "object" && "message" in arg && "stack" in arg) {
    return String((arg as { message: unknown }).message);
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function consoleLine(level: string, parts: unknown[]): void {
  const text = parts.map(formatConsoleArg).join(" ").slice(0, MAX_CONSOLE_LINE_CHARS);
  port.postMessage({ type: "log", line: level ? `${level} ${text}` : text });
}

const BASE_METHODS = [
  "listBases",
  "listTables",
  "getTable",
  "createRecord",
  "getRecord",
  "queryRecords",
  "countRecords",
  "updateRecord",
  "deleteRecord",
] as const;

const baseSdk: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const method of BASE_METHODS) {
  baseSdk[method] = (...args: unknown[]) => rpc(`base.${method}`, args);
}

type HttpConfig = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  timeout?: number;
  validateStatus?: ((status: number) => boolean) | null;
};

type HttpResponse = { status: number; [key: string]: unknown };

async function httpRequest(config: HttpConfig): Promise<HttpResponse> {
  // `validateStatus` may be a sandbox function, which cannot cross the thread
  // boundary — the main thread returns every status and validation runs here.
  const { validateStatus, ...transportConfig } = config ?? {};
  const response = (await rpc("http.request", [transportConfig])) as HttpResponse;
  const validate =
    typeof validateStatus === "function"
      ? validateStatus
      : validateStatus === null
        ? () => true
        : (status: number) => status >= 200 && status < 300;
  if (!validate(response.status)) {
    const err = new Error(`Request failed with status code ${response.status}`) as Error & {
      response: HttpResponse;
      isAxiosError: boolean;
    };
    err.response = response;
    err.isAxiosError = true;
    throw err;
  }
  return response;
}

const axios = ((urlOrConfig: string | HttpConfig, config?: HttpConfig) => {
  if (typeof urlOrConfig === "string") return httpRequest({ ...(config ?? {}), url: urlOrConfig });
  return httpRequest(urlOrConfig ?? {});
}) as ((urlOrConfig: string | HttpConfig, config?: HttpConfig) => Promise<HttpResponse>) &
  Record<string, (...args: never[]) => Promise<HttpResponse>>;
axios.request = (config: HttpConfig) => httpRequest(config ?? {});
axios.get = (url: string, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, method: "GET" });
axios.delete = (url: string, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, method: "DELETE" });
axios.head = (url: string, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, method: "HEAD" });
axios.post = (url: string, body?: unknown, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, data: body, method: "POST" });
axios.put = (url: string, body?: unknown, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, data: body, method: "PUT" });
axios.patch = (url: string, body?: unknown, config?: HttpConfig) =>
  httpRequest({ ...(config ?? {}), url, data: body, method: "PATCH" });

const sandbox: Record<string, unknown> = {
  input: data.input,
  trigger: data.trigger,
  steps: data.steps,
  genosyn: Object.freeze({ base: Object.freeze(baseSdk) }),
  axios: Object.freeze(axios),
  console: Object.freeze({
    log: (...parts: unknown[]) => consoleLine("", parts),
    info: (...parts: unknown[]) => consoleLine("", parts),
    debug: (...parts: unknown[]) => consoleLine("", parts),
    warn: (...parts: unknown[]) => consoleLine("[warn]", parts),
    error: (...parts: unknown[]) => consoleLine("[error]", parts),
  }),
  sleep: (ms: unknown) => {
    const requested = Math.max(0, Number(ms) || 0);
    const remaining = data.deadlineAt - Date.now();
    // A sleep that outlives the budget would only ever end in the deadline
    // firing mid-sleep — fail deterministically up front instead.
    if (remaining <= 0 || requested > remaining) return Promise.reject(timedOut());
    return new Promise((resolve) => setTimeout(resolve, requested));
  },
};

// ── Evaluation ──────────────────────────────────────────────────────────────

async function evaluate(): Promise<string | null> {
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  // The async wrapper lets top-level `await` and `return` work; lineOffset
  // makes thrown stacks report the Member's own line numbers.
  const wrapped = `"use strict";\n(async () => {\n${data.code}\n})()`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "code-step.js", lineOffset: -2 });
  } catch (err) {
    throw new Error(`Syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }

  let deadlineTimer: NodeJS.Timeout | null = null;
  let result: unknown;
  try {
    // The vm `timeout` interrupts a busy loop before the first await. The
    // race below catches async code that idles past the deadline. A busy
    // loop *after* an await can block this whole thread — that case is why
    // the main thread holds a `worker.terminate()` backstop.
    const evaluated = Promise.resolve(script.runInContext(context, { timeout: timeoutMs }));
    // If the deadline wins the race, a late rejection from the abandoned
    // sandbox promise must not surface as an unhandled rejection.
    evaluated.catch(() => {});
    result = await Promise.race([
      evaluated,
      new Promise((_resolve, reject) => {
        deadlineTimer = setTimeout(
          () => reject(timedOut()),
          Math.max(1, data.deadlineAt - Date.now()),
        );
      }),
    ]);
  } catch (err) {
    // The vm's timeout error is built inside the contextified realm, so a
    // host-side `instanceof Error` is false — match on the message instead.
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    if (/Script execution timed out/i.test(message)) {
      throw timedOut();
    }
    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("The returned value must be JSON-serializable");
  }
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`The returned value is too large (over ${MAX_OUTPUT_BYTES / 1024}KB)`);
  }
  return serialized;
}

evaluate().then(
  (serialized) => port.postMessage({ type: "done", serialized }),
  (err) => {
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    // A thrown message must not become a multi-MB errorMessage row — the
    // same reason the return value is capped.
    port.postMessage({ type: "fail", message: message.slice(0, 8_192) });
  },
);
