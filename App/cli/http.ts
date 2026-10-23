import { maskKey } from "./config.js";
import { CliError, issuesFrom, kindForStatus, type RequestSummary } from "./errors.js";
import { CLI_VERSION } from "./version.js";

/**
 * One request to a Genosyn install, and what came back.
 *
 * Redirects are never followed: a bearer key must reach only the address it
 * was given, so a redirect is reported as an error naming where the server
 * pointed. A GET that fails to connect, or meets a 502/503/504, is retried
 * twice with a short backoff — reads are safe to repeat, writes are not.
 * `--verbose` logs both directions with the key reduced to its prefix; the
 * full key never reaches any output.
 */

export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | FormData | Blob;
  operationId?: string;
};

export type HttpResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  /** The media type without parameters, lowercased: `application/json`. */
  mediaType: string;
  bytes: Uint8Array;
  isJson: boolean;
  /** The parsed body when it is JSON. */
  json: unknown;
  text(): string;
};

export type HttpOptions = {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  now: () => number;
  log?: (line: string) => void;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export const USER_AGENT = `genosyn-api/${CLI_VERSION} (node ${process.versions.node})`;

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function summary(request: HttpRequest): RequestSummary {
  return { method: request.method, url: request.url, operationId: request.operationId };
}

/** Headers as they may be shown: the bearer token cut to its prefix. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") {
      const token = value.replace(/^Bearer\s+/i, "");
      shown[name] = `Bearer ${maskKey(token) ?? ""}`;
    } else {
      shown[name] = value;
    }
  }
  return shown;
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function bodyForLog(body: HttpRequest["body"]): string | null {
  if (body === undefined) return null;
  if (typeof body === "string") return body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
  if (body instanceof Uint8Array) return `(${formatBytes(body.byteLength)} of bytes)`;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const fields: string[] = [];
    body.forEach((value, name) => {
      fields.push(
        typeof value === "string"
          ? `${name}=${value.length > 200 ? `${value.slice(0, 200)}…` : value}`
          : `${name}=@${(value as File).name || "file"} (${formatBytes(value.size)})`,
      );
    });
    return `(multipart form) ${fields.join(" ")}`;
  }
  return "(binary body)";
}

/** A connection failure as a person would want it explained. */
export function networkError(error: unknown, request: HttpRequest, timeoutMs: number): CliError {
  const origin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      return request.url;
    }
  })();
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new CliError("network", `No answer from ${origin} within ${timeoutMs / 1000}s.`, {
      hint: "The server may be busy or unreachable. Raise the limit with --timeout <seconds>.",
      request: summary(request),
      cause: error,
    });
  }
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  let message = `Can't reach ${origin}: ${cause?.message ?? (error as Error)?.message ?? String(error)}`;
  let hint = "Check the address with `genosyn-api profiles`, and that Genosyn is running.";
  if (code === "ECONNREFUSED") message = `Connection refused by ${origin}.`;
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    message = `Can't find the host ${new URL(request.url).hostname}.`;
  } else if (code === "ECONNRESET") message = `${origin} closed the connection.`;
  else if (code && /CERT|SSL|TLS|SELF_SIGNED|VERIFY/.test(code)) {
    message = `${origin}'s TLS certificate was refused (${code}).`;
    hint = "For a private certificate authority, point NODE_EXTRA_CA_CERTS at its PEM file.";
  }
  return new CliError("network", message, { hint, request: summary(request), cause: error });
}

/** Send one request (retrying a GET that could not connect) and read the whole response. */
export async function sendRequest(request: HttpRequest, options: HttpOptions): Promise<HttpResponse> {
  const retries =
    request.method === "GET" || request.method === "HEAD" ? (options.retries ?? 2) : 0;
  const sleep = options.sleep ?? defaultSleep;
  const headers = { "user-agent": USER_AGENT, ...request.headers };
  for (let attempt = 0; ; attempt += 1) {
    const started = options.now();
    if (options.log) {
      options.log(`→ ${request.method} ${request.url}`);
      for (const [name, value] of Object.entries(redactHeaders(headers))) {
        options.log(`  ${name}: ${value}`);
      }
      const body = bodyForLog(request.body);
      if (body) options.log(`  ${body}`);
    }
    let response: Response;
    try {
      response = await options.fetch(request.url, {
        method: request.method,
        headers,
        body: request.body as BodyInit | undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const failure = networkError(error, request, options.timeoutMs);
      const name = (error as { name?: string })?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      if (attempt < retries && !timedOut) {
        options.log?.(`  ${failure.message} Retrying.`);
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
        continue;
      }
      throw failure;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    options.log?.(
      `← ${response.status} ${response.statusText} · ${mediaType || "no content type"} · ${formatBytes(bytes.byteLength)} · ${options.now() - started} ms`,
    );
    if (attempt < retries && RETRYABLE_STATUS.has(response.status)) {
      await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
      continue;
    }
    let decoded: string | undefined;
    const text = () => {
      decoded ??= new TextDecoder().decode(bytes);
      return decoded;
    };
    const looksJson = mediaType === "application/json" || mediaType.endsWith("+json");
    let json: unknown;
    let isJson = false;
    if (looksJson && bytes.byteLength > 0) {
      try {
        json = JSON.parse(text());
        isJson = true;
      } catch {
        isJson = false;
      }
    }
    // 304 Not Modified answers a conditional request; it is not a redirect.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      throw new CliError(
        "network",
        location
          ? `The server redirected to ${new URL(location, request.url).href}.`
          : `The server answered ${response.status} without saying where to go.`,
        {
          status: response.status,
          hint: location
            ? "The CLI doesn't follow redirects, so the key goes only where you sent it. Log in with the address it redirects to."
            : undefined,
          request: summary(request),
        },
      );
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      mediaType,
      bytes,
      isJson,
      json,
      text,
    };
  }
}

/** The server's own words for a failure, when it gave any. */
function messageFrom(response: HttpResponse): string {
  const body = response.json;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    if (error === "ValidationError") return "The request didn't pass the server's validation.";
    if (typeof error === "string" && error.trim()) return error.trim();
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const text = response.isJson ? "" : response.text().trim();
  if (text && !response.mediaType.includes("html") && text.length <= 300) return text;
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

export type ErrorContext = {
  /** The flag that sets a body or query field, for validation issues. */
  flagFor?: (path: string) => string | undefined;
  /** A command that explains the operation, for hints. */
  describeCommand?: string;
};

/** The CliError for a response with an error status. */
export function errorFromResponse(
  response: HttpResponse,
  request: HttpRequest,
  context: ErrorContext = {},
): CliError {
  const kind = kindForStatus(response.status);
  const describe = context.describeCommand ? `\`${context.describeCommand}\`` : null;
  let hint: string | undefined;
  if (kind === "auth") {
    hint =
      "The key may be revoked, expired, or for another company: check it with `genosyn-api whoami`, or mint a new one at Settings → API keys and run `genosyn-api login`.";
  } else if (kind === "forbidden") {
    hint = describe
      ? `A key can do only what its Member can, and some operations need a signed-in browser; ${describe} shows what this one needs.`
      : "A key can do only what its Member can, and some operations need a signed-in browser.";
  } else if (kind === "validation" && describe) {
    hint = `${describe} lists every parameter.`;
  } else if (kind === "rate_limited") {
    const after = response.headers.get("retry-after");
    hint = after ? `Try again in ${after} seconds.` : "Wait a moment and try again.";
  } else if (kind === "server") {
    hint = "Try again shortly; if it keeps failing, the server's logs say why.";
  }
  return new CliError(kind, messageFrom(response), {
    status: response.status,
    hint,
    issues: issuesFrom(response.json, context.flagFor),
    response: response.isJson ? response.json : undefined,
    request: summary(request),
  });
}
