import { STATUS_CODES } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withIndefiniteArticle } from "../../../shared/indefiniteArticle.js";
import { availabilityFor, type CatalogueOperation } from "./catalogue.js";
import type { BuiltRequest, SentRequest } from "./call.js";
import type { CallerContext } from "./context.js";

/**
 * What a call tool hands back: the operation's answer, readable by a model
 * and structured for a program.
 *
 * Success carries the response — parsed JSON, text, or a file — beside a
 * one-line summary of the request it answered. Failure carries Genosyn's own
 * message, the validation issues when there are any, and a plain explanation
 * of what the status means for this caller and what to try next: a 403 says
 * which role or Finance access the operation needs against what the key's
 * Member has, a 404 reminds that every id must belong to this company.
 */

/** Text longer than this is cut, with a note on how to ask for less. */
export const MAX_TEXT_CHARS = 100_000;

/** Files up to this size come back embedded; larger ones are described with a link. */
export const MAX_EMBEDDED_FILE_BYTES = 4 * 1024 * 1024;

type Structured = Record<string, unknown>;

function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? "";
}

function headline(request: BuiltRequest, status: number, operation: CatalogueOperation): string {
  return [
    request.method,
    request.path,
    "→",
    String(status),
    reasonPhrase(status),
    `(${operation.name})`,
  ]
    .filter(Boolean)
    .join(" ");
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isJson(contentType: string): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

function isText(contentType: string): boolean {
  return /^text\//i.test(contentType) || /^application\/(?:xml|x-ndjson|csv)\b/i.test(contentType);
}

/** The file name a `Content-Disposition` header gives, if any. */
export function fileNameOf(disposition: string): string | null {
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;\s]+)/.exec(disposition);
  return plain ? (plain[1] ?? plain[2] ?? null) : null;
}

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

const NARROW_HINT =
  "The answer was too long to return whole. Ask for less: most list operations take query " +
  "parameters such as limit, offset or a search term — describe_operation shows which.";

/** A successful answer: JSON, text, or a file. */
function successResult(
  operation: CatalogueOperation,
  request: BuiltRequest,
  response: NonNullable<Extract<SentRequest, { ok: true }>["response"]>,
  context: Pick<CallerContext, "baseUrl">,
): CallToolResult {
  const contentType = headerValue(response.headers["content-type"]);
  const base: Structured = {
    operationId: operation.name,
    method: request.method,
    path: request.path,
    status: response.status,
    ok: true,
    ...(contentType ? { contentType } : {}),
  };
  const line = headline(request, response.status, operation);

  if (response.body.length === 0) {
    return {
      content: [{ type: "text", text: `${line}\nNo content.` }],
      structuredContent: { ...base, data: null },
    };
  }

  if (isJson(contentType) || (!contentType && !response.truncated)) {
    const raw = response.body.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && !response.truncated) {
      let rendered = JSON.stringify(parsed, null, 2);
      if (rendered.length > MAX_TEXT_CHARS) rendered = JSON.stringify(parsed);
      const shown = cut(rendered);
      if (!shown.truncated) {
        return {
          content: [{ type: "text", text: `${line}\n${shown.text}` }],
          structuredContent: { ...base, data: parsed },
        };
      }
      return {
        content: [{ type: "text", text: `${line}\n${shown.text}\n…\n${NARROW_HINT}` }],
        structuredContent: { ...base, truncated: true, bytes: response.body.length },
      };
    }
    // Cut off mid-stream, or not JSON after all: hand back the text.
    const shown = cut(raw);
    const truncated = shown.truncated || response.truncated;
    return {
      content: [
        { type: "text", text: `${line}\n${shown.text}${truncated ? `\n…\n${NARROW_HINT}` : ""}` },
      ],
      structuredContent: { ...base, ...(truncated ? { truncated: true } : { data: raw }) },
    };
  }

  if (isText(contentType)) {
    const shown = cut(response.body.toString("utf8"));
    const truncated = shown.truncated || response.truncated;
    return {
      content: [
        { type: "text", text: `${line}\n${shown.text}${truncated ? `\n…\n${NARROW_HINT}` : ""}` },
      ],
      structuredContent: {
        ...base,
        ...(truncated ? { truncated: true, bytes: response.body.length } : { data: shown.text }),
      },
    };
  }

  // A file: an image the model can see, or a document embedded as a resource.
  const mimeType = contentType.split(";")[0]?.trim() || "application/octet-stream";
  const url = `${context.baseUrl}${request.path}`;
  const name = fileNameOf(headerValue(response.headers["content-disposition"]));
  const embeddable = !response.truncated && response.body.length <= MAX_EMBEDDED_FILE_BYTES;
  // A file read only in part is as long as its header says, when it says.
  const declared = Number(headerValue(response.headers["content-length"]));
  const bytes = response.truncated
    ? Number.isFinite(declared) && declared > 0
      ? declared
      : null
    : response.body.length;
  const file: Structured = {
    contentType: mimeType,
    ...(bytes !== null ? { bytes } : {}),
    url,
    ...(name ? { name } : {}),
  };
  const size = bytes !== null ? `${bytes} bytes` : `over ${MAX_EMBEDDED_FILE_BYTES} bytes`;
  const described =
    `${line}\n${withIndefiniteArticle(`${mimeType} file`, { capitalized: true })}${name ? ` named ${name}` : ""}, ${size}.` +
    (embeddable
      ? ""
      : ` It is too large to return here; download it from ${url} with the same API key as a Bearer token.`);
  if (!embeddable) {
    return {
      content: [{ type: "text", text: described }],
      structuredContent: { ...base, file: { ...file, embedded: false } },
    };
  }
  const data = response.body.toString("base64");
  return {
    content: [
      { type: "text", text: described },
      mimeType.startsWith("image/")
        ? { type: "image", data, mimeType }
        : { type: "resource", resource: { uri: url, mimeType, blob: data } },
    ],
    structuredContent: { ...base, file: { ...file, embedded: true } },
  };
}

type ErrorBody = { error?: unknown; issues?: unknown };

/** Zod issues as `body.title: Required` lines, each under the part of the request it is about. */
export function formatIssues(
  issues: unknown,
  location: string | ((issue: unknown) => string),
): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 20).map((issue) => {
    const record = (issue ?? {}) as { path?: unknown; message?: unknown };
    const path = Array.isArray(record.path) ? record.path.map(String).join(".") : "";
    const part = typeof location === "function" ? location(issue) : location;
    const where = [part, path].filter(Boolean).join(".");
    return `- ${where || "(request)"}: ${typeof record.message === "string" ? record.message : "is invalid"}`;
  });
}

/**
 * The part of the request a validation issue is about. A route validates its
 * path, query and body separately and its issues do not say which; the
 * issue's first field does, for any operation that names it.
 */
function issueLocation(operation: CatalogueOperation, issue: unknown): string {
  const path = (issue as { path?: unknown } | null)?.path;
  const first = Array.isArray(path) && path.length ? String(path[0]) : undefined;
  const bodySchema = (operation.inputSchema.properties as Record<string, { properties?: object }>)
    ?.body;
  if (first !== undefined) {
    if (first === "cid" || operation.pathParams.includes(first)) return "path";
    if (bodySchema?.properties && first in bodySchema.properties) return "body";
    if (operation.queryParams.some((parameter) => parameter.name === first)) return "query";
  }
  if (operation.body) return "body";
  return operation.queryParams.length ? "query" : "path";
}

/** What a failed status means for this caller, and what to try next. */
export function explainStatus(
  status: number,
  message: string,
  operation: CatalogueOperation,
  context: Pick<CallerContext, "companyName" | "member" | "standing">,
): string {
  switch (status) {
    case 400:
      return message === "ValidationError"
        ? `The arguments do not match what ${operation.name} accepts. Fix the fields listed above — describe_operation shows its schema — and call it again.`
        : "Genosyn rejected the request as it stands. Adjust the arguments as the message says and try again.";
    case 401:
      return "The API key was not accepted. It may have been revoked, or have expired, since this conversation began. Mint a new key at Settings → API keys and reconnect.";
    case 403: {
      if (/browser session|logged-in|signed-in/i.test(message)) {
        return "This needs a person at a signed-in browser, so Genosyn refuses it to API keys by design. Do it in the Genosyn app.";
      }
      const finance =
        context.standing.financeAccess === "full"
          ? "full Finance access"
          : context.standing.financeAccess === "read"
            ? "read-only Finance access"
            : "no Finance access";
      const parts = [
        `The key acts as ${context.member.name}, ${context.standing.role === "member" ? "a member" : `an ${context.standing.role}`} of ${context.companyName} with ${finance}, and Genosyn does not let them do this.`,
      ];
      const availability = availabilityFor(operation, context.standing);
      if (!availability.available) parts.push(availability.reason);
      for (const when of operation.access.browserSessionRequiredTo) {
        parts.push(`A person at a signed-in browser is required ${when}.`);
      }
      parts.push("Ask an owner or admin for the access, or use a key from a Member who has it.");
      return parts.join(" ");
    }
    case 404:
      return `Nothing matched. Check the ids: each must belong to ${context.companyName}, the only company this server reaches. A list or search operation finds the right one.`;
    case 405:
      return "The operation does not take that method.";
    case 409:
      return "It conflicts with the record's current state: it changed since it was read, or it already exists. Read it again and retry against what is there now.";
    case 413:
      return "The request is too large for Genosyn to accept. Send less at once, or upload large files in the app.";
    case 415:
      return "Genosyn could not read the request body's format.";
    case 422:
      return "Genosyn understood the request but cannot do it in the record's current state; the message says what is in the way.";
    case 429:
      return "Genosyn is limiting how often this can be done. Wait a little and try again.";
    default:
      if (status >= 500) {
        return "Genosyn failed while handling it: a server error, not a problem with the arguments. Try again later; if it keeps failing, check Settings → System Health or the server log.";
      }
      return `Genosyn answered ${status} ${reasonPhrase(status)}.`.trim();
  }
}

/** A refused or failed operation, explained. */
function failureResult(
  operation: CatalogueOperation,
  request: BuiltRequest,
  response: NonNullable<Extract<SentRequest, { ok: true }>["response"]>,
  context: Pick<CallerContext, "companyName" | "member" | "standing">,
): CallToolResult {
  const raw = response.body.toString("utf8");
  let parsed: ErrorBody | null = null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as ErrorBody;
  } catch {
    parsed = null;
  }
  const message =
    typeof parsed?.error === "string"
      ? parsed.error
      : raw.trim()
        ? cut(raw.trim()).text.slice(0, 2000)
        : reasonPhrase(response.status) || `HTTP ${response.status}`;
  const issues = formatIssues(parsed?.issues, (issue) => issueLocation(operation, issue));
  const location = headerValue(response.headers.location);
  const explanation =
    response.status >= 300 && response.status < 400 && location
      ? `It redirects to ${location}, a page for a browser rather than an answer for a client.`
      : explainStatus(response.status, message, operation, context);
  const text = [
    headline(request, response.status, operation),
    message,
    ...issues,
    "",
    explanation,
  ].join("\n");
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: {
      operationId: operation.name,
      method: request.method,
      path: request.path,
      status: response.status,
      ok: false,
      error: {
        message,
        explanation,
        ...(Array.isArray(parsed?.issues) ? { issues: parsed.issues } : {}),
      },
    },
  };
}

/** The tool result for a sent request, whatever became of it. */
export function resultFor(
  operation: CatalogueOperation,
  sent: SentRequest,
  context: Pick<CallerContext, "baseUrl" | "companyName" | "member" | "standing">,
): CallToolResult {
  if (!sent.ok) {
    const text =
      sent.error.code === "timeout"
        ? `${sent.request.method} ${sent.request.path} (${operation.name}): ${sent.error.message}. It may still finish; read the record before calling it again.`
        : sent.error.code === "aborted"
          ? `${sent.request.method} ${sent.request.path} (${operation.name}) was cancelled before Genosyn answered. It may still finish; read the record before calling it again.`
          : `${sent.request.method} ${sent.request.path} (${operation.name}) failed before Genosyn answered: ${sent.error.message}`;
    return { isError: true, content: [{ type: "text", text }] };
  }
  const { response } = sent;
  if (response.status >= 200 && response.status < 300) {
    return successResult(operation, sent.request, response, context);
  }
  return failureResult(operation, sent.request, response, context);
}

/** A tool error that never reached Genosyn: a mistake in the call itself. */
export function callMistake(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
