import { retryAfterMs as retryAfterFromHeaders } from "./apiKeyRing.js";

/**
 * Telling an AI Model that is **unavailable** apart from every other failure.
 *
 * Three kinds of model failure look alike from a distance and call for three
 * different answers:
 *
 *   - **Unavailable** — the AI Model's service could not be reached or failed
 *     on its own side: a refused or reset connection, a host that does not
 *     resolve, a broken TLS handshake, a connect or read timeout, any 5xx,
 *     Anthropic's 529 `overloaded_error`, OpenAI's `server_error`, the Codex
 *     app-server's overloaded or disconnected turn, an Ollama or vLLM server
 *     that is down. Nothing about the request or the key is wrong, and the same
 *     request succeeds once the service is back. Work waits for it
 *     (`services/modelAvailability.ts`) instead of failing.
 *   - **A refused key** — 401, 403, 402, or a 400 or 429 that says the account
 *     is out of credit or quota. The key ring moves the request to the next key
 *     and rests the refused one (`apiKeyRing.ts`); when every key is refused the
 *     failure is about credentials, which waiting does not fix. Not an outage.
 *   - **A bad request** — 400, 404, 413, 422, an over-long prompt. Every key
 *     and every retry gets the same answer. Not an outage; the work fails as it
 *     always has, so a person sees why.
 *
 * One case sits between the first two: a **rate limit** that reaches the work
 * after the key ring has tried every key — every key rests on a 429 — or from
 * a custom endpoint, which has no ring. The provider is saying "not now", and
 * waiting is exactly what fixes it, so it counts as unavailable for as long as
 * the provider asked (`retry-after`), never as a failed piece of work. Running
 * out of quota or credit is different, and stays a refused key.
 *
 * Everything here is pure, and nothing it returns carries a secret: `detail`
 * is built from the status, a short error type token and a network error code,
 * never from what the service wrote back, which can quote the key it was sent.
 */

/** Why an AI Model is unavailable, for the copy a person reads. */
export type ModelUnavailableCause =
  /** No connection: refused, reset, unknown host, unreachable network, TLS. */
  | "unreachable"
  /** It accepted the connection but did not answer in time. */
  | "timeout"
  /** It answered with a server error (5xx). */
  | "server_error"
  /** It said it is overloaded (Anthropic 529, OpenAI or Codex "overloaded"). */
  | "overloaded"
  /** Every key is rate-limited, or the endpoint is, or the ChatGPT plan's limit is reached. */
  | "rate_limited";

export type ModelUnavailability = {
  cause: ModelUnavailableCause;
  /** The HTTP status, when the service answered with one. */
  status: number | null;
  /** The network error code, or the service's short error type, when there was one. */
  code: string | null;
  /** How long the service asked callers to wait, when it said. */
  retryAfterMs: number | null;
  /** One line a person can read. Never holds a key or a response body. */
  detail: string;
  /**
   * The failure says the service is unavailable on its own — nothing listens
   * at the address, the host does not resolve, the certificate is refused, a
   * server Genosyn already waited out — so one is enough to mark the model
   * unavailable. Anything else (a 503, a reset, a timeout) can be a blip and
   * counts toward a run of failures instead.
   */
  definite: boolean;
};

/** Network error codes that mean the endpoint cannot be reached at all. */
const DEFINITE_UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
]);
/** A connection that was there and broke, or a lookup that may work next time. */
const TRANSIENT_UNREACHABLE = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
/** TLS failures: the endpoint answered, but not with a certificate this host trusts. */
const TLS_CODE =
  /^(?:CERT_|UNABLE_TO_(?:VERIFY|GET)_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_|ERR_SSL_|EPROTO$)/;

const CAUSE_WORDS: Record<ModelUnavailableCause, string> = {
  unreachable: "could not be reached",
  timeout: "did not answer in time",
  server_error: "answered with a server error",
  overloaded: "is overloaded",
  rate_limited: "is rate-limited",
};

/** What a cause reads as in a sentence: "The AI Model is overloaded". */
export function unavailableCauseWords(cause: ModelUnavailableCause): string {
  return CAUSE_WORDS[cause];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A short machine token a service uses for an error type, or null for anything else. */
function token(value: unknown): string | null {
  const raw = text(value);
  return raw && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(raw) ? raw : null;
}

function seconds(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function modelUnavailability(
  cause: ModelUnavailableCause,
  parts: {
    status?: number | null;
    code?: string | null;
    retryAfterMs?: number | null;
    definite?: boolean;
    what?: string;
  },
): ModelUnavailability {
  const status = parts.status ?? null;
  const code = parts.code ?? null;
  const retryAfterMs = parts.retryAfterMs ?? null;
  const facts = [
    status !== null ? `HTTP ${status}` : null,
    code && !(status !== null && code === String(status)) ? code : null,
  ].filter(Boolean);
  const detail =
    `The AI Model ${parts.what ?? CAUSE_WORDS[cause]}` +
    (facts.length ? ` (${facts.join(", ")})` : "") +
    (retryAfterMs !== null && retryAfterMs > 0 ? `; it asked to wait ${seconds(retryAfterMs)}` : "") +
    ".";
  return { cause, status, code, retryAfterMs, detail, definite: parts.definite === true };
}

type BodyHints = {
  /** The error type or code the body names, as a short token. */
  type: string | null;
  /** Lowercased message text, for markers only — never copied into `detail`. */
  message: string;
};

/** The error type and message an Anthropic, OpenAI or OpenAI-compatible body carries. */
function bodyHints(body: string | null | undefined): BodyHints {
  if (!body) return { type: null, message: "" };
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = asRecord(parsed?.error);
    if (error) {
      return {
        type: token(error.type) ?? token(error.code),
        message: (text(error.message) ?? "").toLowerCase(),
      };
    }
    return {
      type: token(parsed?.type === "error" ? null : parsed?.type),
      message: (text(parsed?.error) ?? text(parsed?.message) ?? text(parsed?.detail) ?? "")
        .toLowerCase(),
    };
  } catch {
    return { type: null, message: body.slice(0, 2_000).toLowerCase() };
  }
}

/**
 * Out of quota or credit: the key's problem, which waiting does not fix. A 429
 * that names a quota in any words ("quota exceeded") is read as one, so work
 * ends with the service's own words rather than waiting on a limit that may
 * never reset by itself.
 */
function saysOutOfCredit(hints: BodyHints): boolean {
  const type = (hints.type ?? "").toLowerCase();
  return (
    type.includes("insufficient_quota") ||
    type.includes("billing") ||
    /\bquota\b/.test(hints.message) ||
    hints.message.includes("credit balance") ||
    hints.message.includes("billing")
  );
}

function saysOverloaded(hints: BodyHints): boolean {
  const type = (hints.type ?? "").toLowerCase();
  return (
    type === "overloaded_error" ||
    type.includes("overloaded") ||
    /\boverloaded\b|over capacity|at capacity/.test(hints.message)
  );
}

/**
 * Whether an HTTP answer from an AI Model's service says it is unavailable.
 * Null for an answer about the request or the key, and for success.
 *
 * `body` is read for markers only — an overloaded or quota error type — and
 * never copied into what this returns.
 */
export function classifyModelResponse(args: {
  status: number;
  body?: string | null;
  headers?: Headers | null;
  now?: number;
}): ModelUnavailability | null {
  const { status } = args;
  if (status < 400) return null;
  const hints = bodyHints(args.body);
  const retryAfterMs = retryAfterFromHeaders(args.headers ?? null, args.now);
  const code = hints.type;
  if (status === 429) {
    if (saysOutOfCredit(hints)) return null;
    return modelUnavailability("rate_limited", { status, code, retryAfterMs });
  }
  if (status === 529 || (status >= 500 && saysOverloaded(hints))) {
    return modelUnavailability("overloaded", { status, code, retryAfterMs });
  }
  if (status === 408 || status === 504) return modelUnavailability("timeout", { status, code, retryAfterMs });
  // 501 and 505 are about the request's method or protocol, not the service's health.
  if (status >= 500 && status !== 501 && status !== 505) {
    return modelUnavailability("server_error", { status, code, retryAfterMs });
  }
  // A 4xx that still says "overloaded" (some gateways answer 4xx for it).
  if (status >= 400 && status < 500 && status !== 401 && status !== 403 && saysOverloaded(hints)) {
    return modelUnavailability("overloaded", { status, code, retryAfterMs });
  }
  return null;
}

/** Each object in an error's cause chain, the error first. */
function causeChain(error: unknown, depth = 6): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let i = 0; i < depth; i++) {
    const record = asRecord(current);
    if (!record || chain.includes(record)) break;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

/** An abort is somebody stopping the work on purpose — never an outage. */
export function isAbortError(error: unknown): boolean {
  return causeChain(error).some((record) => {
    const name = text(record.name) ?? "";
    const code = text(record.code) ?? "";
    return name === "AbortError" || code === "ABORT_ERR" || code === "UND_ERR_ABORTED";
  });
}

/**
 * Whether a request that never got an HTTP answer — fetch threw — failed
 * because the service could not be reached. Null for an abort, a refused
 * private address (the outbound policy's `EACCES`), and anything else that is
 * this side's own problem.
 */
export function classifyModelTransportError(error: unknown): ModelUnavailability | null {
  if (!error || isAbortError(error)) return null;
  const chain = causeChain(error);
  let coded = false;
  for (const record of chain) {
    const code = token(record.code) ?? token(record.errno);
    if (!code) continue;
    coded = true;
    const upper = code.toUpperCase();
    if (DEFINITE_UNREACHABLE.has(upper)) {
      return modelUnavailability("unreachable", {
        code: upper,
        definite: true,
        what: upper === "ENOTFOUND" ? "host could not be found" : CAUSE_WORDS.unreachable,
      });
    }
    if (TLS_CODE.test(upper)) {
      return modelUnavailability("unreachable", {
        code: upper,
        definite: true,
        what: "refused a secure connection",
      });
    }
    if (TRANSIENT_UNREACHABLE.has(upper)) {
      return modelUnavailability("unreachable", {
        code: upper,
        what: upper === "EAI_AGAIN" ? "host could not be looked up" : "dropped the connection",
      });
    }
    if (TIMEOUT_CODES.has(upper)) return modelUnavailability("timeout", { code: upper });
  }
  // A code names what happened, and none above means this host's own problem
  // — the outbound policy's EACCES, a bad argument. Words decide only when no
  // code was given.
  if (coded) return null;
  const words = chain
    .map((record) => `${text(record.name) ?? ""} ${text(record.message) ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (/apiconnectiontimeouterror|timed? ?out|timeout/.test(words)) return modelUnavailability("timeout", {});
  if (
    /apiconnectionerror|fetch failed|socket hang up|network error|connection error|other side closed/.test(
      words,
    )
  ) {
    return modelUnavailability("unreachable", { what: "dropped the connection" });
  }
  return null;
}

/** The Codex app-server's `codexErrorInfo`, as a variant name and any HTTP status inside it. */
export function codexErrorKind(info: unknown): { kind: string | null; status: number | null } {
  const name = token(info);
  if (name) return { kind: name, status: null };
  const record = asRecord(info);
  if (!record) return { kind: null, status: null };
  const [kind] = Object.keys(record);
  if (!kind) return { kind: null, status: null };
  const inner = asRecord(record[kind]);
  return {
    kind: token(kind),
    status: finiteNumber(inner?.httpStatusCode) ?? finiteNumber(inner?.http_status_code),
  };
}

/**
 * Whether a failed Codex subscription turn says the service is unavailable,
 * from the variant the app-server reported (`codexErrorInfo`).
 */
export function classifyCodexError(info: unknown): ModelUnavailability | null {
  const { kind, status } = codexErrorKind(info);
  if (!kind) return null;
  switch (kind) {
    case "serverOverloaded":
      return modelUnavailability("overloaded", { status, code: kind });
    case "internalServerError":
      return modelUnavailability("server_error", { status, code: kind });
    case "usageLimitExceeded":
      // The ChatGPT plan's usage window: the subscription's own rate limit.
      return modelUnavailability("rate_limited", { status, code: kind, definite: true, what: "reached its usage limit" });
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts": {
      if (status !== null) {
        const answered = classifyModelResponse({ status });
        return answered ? { ...answered, code: kind } : null;
      }
      return modelUnavailability("unreachable", {
        code: kind,
        what:
          kind === "responseStreamDisconnected" ? "dropped the connection" : CAUSE_WORDS.unreachable,
      });
    }
    default:
      return null;
  }
}

/** Read the Codex variant off an error the runtime threw, wherever it sits. */
function codexInfoOf(record: Record<string, unknown>): unknown {
  if (record.name !== "CodexAppServerError") return undefined;
  const code = record.code;
  if (typeof code === "string" && code !== "failed" && code !== "interrupted") return code;
  const data = asRecord(record.data);
  return data?.codexErrorInfo;
}

const ATTACHED = Symbol.for("genosyn.modelUnavailable");

/**
 * Remember on an error that the runtime saw the AI Model's service fail while
 * the turn ran, so {@link classifyModelError} reports the precise cause — the
 * proxy saw a refused connection where OpenCode only says "HTTP 502".
 */
export function markModelUnavailable<T>(error: T, unavailability: ModelUnavailability): T {
  const record = asRecord(error);
  if (record) {
    Object.defineProperty(record, ATTACHED, {
      value: unavailability,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

function attachedTo(record: Record<string, unknown>): ModelUnavailability | null {
  const value = (record as Record<symbol, unknown>)[ATTACHED];
  return value && typeof value === "object" ? (value as ModelUnavailability) : null;
}

/** Statuses and markers the runtime's own messages carry, for a turn's final error. */
function providerText(record: Record<string, unknown>): string {
  return [text(record.providerDetail), text(record.message)].filter(Boolean).join("\n");
}

/**
 * Whether the error a model turn ended with means the AI Model is unavailable.
 * Reads, in order: what the turn's model proxy saw (attached with
 * {@link markModelUnavailable}), a Codex app-server variant, the HTTP status
 * of a model service's own answer, then a network failure in the cause chain.
 * Null for an abort, a refused key, a bad request, and the runtime's own
 * problems.
 *
 * Only an error built from the service's answer has a status or words worth
 * reading: the one `openCodeError` makes, which always carries what the
 * provider said on `providerDetail`. Genosyn's own errors carry HTTP statuses
 * and messages too — the status a route answers with, such as the 502 of a
 * letter that could not be written, the OpenCode server's own, a message that
 * happens to say "overloaded" — and those say nothing about the AI Model, so
 * they are never read as one. Work that fails on its own terms and knows the
 * turn's model was unavailable says so with {@link markModelUnavailable}.
 */
export function classifyModelError(error: unknown): ModelUnavailability | null {
  if (!error || isAbortError(error)) return null;
  const chain = causeChain(error);
  for (const record of chain) {
    const attached = attachedTo(record);
    if (attached) return attached;
  }
  for (const record of chain) {
    const info = codexInfoOf(record);
    if (info !== undefined) {
      const codex = classifyCodexError(info);
      if (codex) return codex;
      // A Codex failure that names its variant and is not an outage is not one.
      if (codexErrorKind(info).kind) return null;
    }
  }
  const fromService = chain.filter((record) =>
    Object.prototype.hasOwnProperty.call(record, "providerDetail"),
  );
  for (const record of fromService) {
    const status = finiteNumber(record.status) ?? finiteNumber(record.statusCode);
    if (status === null) continue;
    const words = providerText(record);
    // The runtime's message names the status, and its provider detail the
    // error type and words — enough for the markers.
    const type =
      /\b(overloaded_error|insufficient_quota|billing_error|server_error|api_error)\b/i.exec(words)?.[1] ??
      null;
    return classifyModelResponse({
      status,
      body: JSON.stringify({ error: { type, message: words } }),
    });
  }
  const transport = classifyModelTransportError(error);
  if (transport) return transport;
  // A streamed error with no status: Anthropic sends an overloaded error as an
  // event after a 200, and OpenCode reports it by the provider's words alone.
  const words = fromService.map((record) => providerText(record)).join("\n").toLowerCase();
  if (/\boverloaded(_error)?\b/.test(words)) return modelUnavailability("overloaded", { code: "overloaded_error" });
  return null;
}

/**
 * Scan a streamed answer for the error event a service sends after it has
 * already answered 200: Anthropic's `event: error` with `overloaded_error` or
 * `api_error`, OpenAI's `response.failed` with a `server_error`. Returns the
 * unavailability once one is seen; null otherwise. Bounded: keeps only the
 * tail of what it has read.
 */
export class StreamedErrorScanner {
  #buffer = "";
  #found: ModelUnavailability | null = null;

  get found(): ModelUnavailability | null {
    return this.#found;
  }

  push(chunk: string): ModelUnavailability | null {
    if (this.#found) return this.#found;
    this.#buffer = (this.#buffer + chunk).slice(-16_384);
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const found = this.#scanEvent(line.slice(5).trim());
        if (found) {
          this.#found = found;
          return found;
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
    return null;
  }

  #scanEvent(data: string): ModelUnavailability | null {
    if (!data.includes("error") && !data.includes("failed")) return null;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(data));
    } catch {
      return null;
    }
    if (!event) return null;
    // Anthropic: {"type":"error","error":{"type":"overloaded_error",...}}
    if (event.type === "error") {
      const error = asRecord(event.error);
      const type = token(error?.type) ?? token(error?.code);
      if (type === "overloaded_error") return modelUnavailability("overloaded", { code: type });
      if (type === "api_error" || type === "server_error")
        return modelUnavailability("server_error", { code: type });
      return null;
    }
    // OpenAI Responses: {"type":"response.failed","response":{"error":{"code":"server_error"}}}
    if (event.type === "response.failed") {
      const response = asRecord(event.response);
      const error = asRecord(response?.error);
      const type = token(error?.code) ?? token(error?.type);
      if (!type) return null;
      if (/overloaded/i.test(type)) return modelUnavailability("overloaded", { code: type });
      if (type === "server_error" || type === "internal_error")
        return modelUnavailability("server_error", { code: type });
    }
    return null;
  }
}
