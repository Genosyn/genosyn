import { Request, Response, NextFunction } from "express";

/**
 * What may be written to the operator log when a request fails.
 *
 * `console.error("[error]", err)` printed the whole object, and TypeORM's
 * `QueryFailedError` carries `query` and `parameters` as own enumerable
 * properties — so every failed INSERT or UPDATE exported its bound values.
 * Those values are the row being written: chat text, a mail body, a Soul, a
 * customer's name. On a hosted install stdout goes to an aggregator with its
 * own retention, outside any tenant's deletion request, which makes this the
 * one leak on the list that cannot be fixed after the fact — you cannot
 * un-export logs you already shipped.
 *
 * The projection keeps what an on-call engineer actually uses: the error's
 * name, its message, the status, the stack, and — for a query failure — the
 * parameterized SQL, which names the table and the columns without carrying a
 * single value. `parameters` never appears.
 */
export type RedactedError = {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  /** Parameterized SQL only. The bound values are deliberately dropped. */
  query?: string;
  /** Present when the original carried a `cause`, redacted the same way. */
  cause?: RedactedError;
};

const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const MAX_QUERY = 2_000;

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… (truncated)` : value;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Project any thrown value onto {@link RedactedError}.
 *
 * Deliberately allowlist-shaped: it reads the fields it names and nothing
 * else, so a driver error that grows a new value-bearing property in a future
 * release does not silently start being logged.
 */
export function redactErrorForLog(err: unknown, depth = 0): RedactedError {
  if (typeof err === "string") {
    return { name: "Error", message: clamp(err, MAX_MESSAGE) };
  }
  if (!err || typeof err !== "object") {
    return { name: "Error", message: clamp(String(err), MAX_MESSAGE) };
  }

  const source = err as Record<string, unknown>;
  const redacted: RedactedError = {
    name: readString(source, "name") ?? "Error",
    message: clamp(readString(source, "message") ?? "", MAX_MESSAGE),
  };

  const stack = readString(source, "stack");
  if (stack) redacted.stack = clamp(stack, MAX_STACK);

  const status = source["status"];
  if (typeof status === "number" && Number.isInteger(status)) redacted.status = status;

  const code = source["code"];
  if (typeof code === "string" && code) redacted.code = code;
  else if (typeof code === "number") redacted.code = String(code);

  // TypeORM's QueryFailedError. The SQL is parameterized, so it identifies the
  // statement without carrying the row; `parameters` is the row and is never
  // read here.
  const query = readString(source, "query");
  if (query) redacted.query = clamp(query, MAX_QUERY);

  // One level only. A cause chain is almost always driver-wrapping-driver, and
  // walking it without a bound is how a cyclic `cause` takes the process down
  // inside the handler that exists to keep it alive.
  if (depth === 0 && source["cause"]) {
    redacted.cause = redactErrorForLog(source["cause"], depth + 1);
  }

  return redacted;
}

/** The single place an error reaches the operator log. */
export function logRedactedError(label: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(label, redactErrorForLog(err));
}

/**
 * Catch what escapes every request. Without these Node prints the raw error —
 * the exact object {@link redactErrorForLog} exists to keep out of the log —
 * and then, for an uncaught exception, exits.
 *
 * Registered once from `index.ts`. Idempotent so a test importing the module
 * twice does not stack listeners.
 */
let processHandlersInstalled = false;
export function installProcessErrorHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on("unhandledRejection", (reason) => {
    logRedactedError("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (err) => {
    logRedactedError("[uncaughtException]", err);
    // Node's default for an uncaught exception is to exit, and staying up on a
    // corrupted process is worse than restarting: the pod restarts, in-flight
    // work is recovered by the lease sweeps, and the operator sees the crash.
    // The only change here is that the log line on the way out is redacted.
    process.exit(1);
  });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  logRedactedError("[error]", err);
  const candidateStatus =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
  const status =
    Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : 500;
  // Expected 4xx errors are safe API feedback. Unexpected server failures may
  // include SQL, filesystem paths, credentials, or upstream response bodies;
  // keep their detail in operator logs only.
  const message = status < 500 && err instanceof Error ? err.message : "Internal server error";
  res.status(status).json({ error: message });
}
