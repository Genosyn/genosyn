import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CatalogueOperation } from "./catalogue.js";
import type { CallerContext } from "./context.js";
import {
  InProcessRequestError,
  requestInProcess,
  type InProcessRequest,
  type InProcessResponse,
} from "./dispatch.js";
import { acquireSlot } from "./limits.js";
import { MAX_EMBEDDED_FILE_BYTES, MAX_TEXT_READ_BYTES, responseReadLimit } from "./results.js";
import { PLAIN_BODY_LIMIT_BYTES } from "./transport.js";

/**
 * Turning a tool call into the HTTP request it stands for, and sending it.
 *
 * The arguments name an operation and supply its path parameters, query
 * string, body and file. Everything structural is checked here, before any
 * request — the operation's path parameters are all present and nothing else,
 * a file goes only where a form takes one — so a mistake is explained in terms
 * of the tool call. Everything about the values themselves is left to the
 * route's own validators, which answer with the same 400 any HTTP client gets.
 */

/** How long one operation may take before the tool gives up waiting. */
export const CALL_TIMEOUT_MS = 120_000;

/**
 * The most of any one response the tool reads. Each response is read only as
 * far as it can be used (`responseReadLimit`): JSON and text as far as they
 * can be shown, a file one byte past the size that can be embedded.
 */
export const MAX_RESPONSE_BYTES = Math.max(MAX_TEXT_READ_BYTES, MAX_EMBEDDED_FILE_BYTES + 1);

/** The largest file a call may carry, decoded. The request limit keeps it lower in practice. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const fileArgument = z
  .object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(255).optional(),
    base64: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

/** The arguments every call tool takes. */
export const callArguments = z
  .object({
    operationId: z.string().trim().min(1).max(120),
    path: z.record(scalar).optional(),
    query: z.record(z.unknown()).optional(),
    body: z.unknown().optional(),
    file: fileArgument.optional(),
  })
  .strict();

export type CallArguments = z.infer<typeof callArguments>;

export type BuiltRequest = {
  method: string;
  /** The concrete path and query the request targets. */
  target: string;
  /** The concrete path alone, for messages and links. */
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
};

export type BuildResult = { ok: true; request: BuiltRequest } | { ok: false; message: string };

const fail = (message: string): BuildResult => ({ ok: false, message });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const list = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

/** Append one query value the way OpenAPI's defaults spell it: repeated keys, `deepObject` brackets. */
function appendQuery(params: URLSearchParams, name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (isPlainObject(item) || Array.isArray(item))
        appendQuery(params, `${name}[${index}]`, item);
      else appendQuery(params, name, item);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) appendQuery(params, `${name}[${key}]`, inner);
    return;
  }
  params.append(name, String(value));
}

const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ndjson: "application/x-ndjson",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
};

/** A MIME type for a file name, from its extension. */
export function contentTypeFor(name: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** A file name that cannot break out of its multipart header. */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[/]/g, "_")
    .trim();
  return cleaned || "file";
}

/** `type/subtype`, with parameters such as `; charset=utf-8` — but nothing that could end a header. */
const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n\\]*"))*$/;
/** Standard or URL-safe base64; Node decodes either. */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The bytes and type of the file argument, or why it cannot be sent. */
export function decodeFile(
  file: z.infer<typeof fileArgument>,
): { ok: true; name: string; contentType: string; data: Buffer } | { ok: false; message: string } {
  const hasBase64 = typeof file.base64 === "string";
  const hasText = typeof file.text === "string";
  if (hasBase64 === hasText) {
    return {
      ok: false,
      message:
        "Give the file's contents as exactly one of base64 (any file) or text (a text file).",
    };
  }
  let data: Buffer;
  if (hasBase64) {
    const compact = (file.base64 as string).replace(/\s+/g, "");
    if (!BASE64.test(compact) || compact.length % 4 === 1) {
      return { ok: false, message: "The file's base64 is not valid base64." };
    }
    data = Buffer.from(compact, "base64");
  } else {
    data = Buffer.from(file.text as string, "utf8");
  }
  if (data.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      message: `The file is ${data.length} bytes; files sent through the MCP server can be at most ${MAX_FILE_BYTES} bytes. Upload larger files in the app.`,
    };
  }
  const contentType = file.contentType?.trim() || contentTypeFor(file.name);
  if (!MIME_TYPE.test(contentType)) {
    return {
      ok: false,
      message: `"${file.contentType}" is not a MIME type, such as application/pdf.`,
    };
  }
  return { ok: true, name: safeFileName(file.name), contentType, data };
}

/**
 * A body a model sent as JSON text rather than as JSON — `"{\"name\":\"x\"}"` —
 * which it does often enough to be worth meeting halfway. Only text that is a
 * JSON object or array is unwrapped; any other string is left as it came.
 */
export function unwrapJsonText(body: unknown): unknown {
  // Past the App's own 1 MB body limit the route would refuse it anyway.
  if (typeof body !== "string" || body.length > PLAIN_BODY_LIMIT_BYTES) return body;
  const trimmed = body.trim();
  if (!/^[[{]/.test(trimmed)) return body;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : body;
  } catch {
    return body;
  }
}

/** A `multipart/form-data` body: the text fields, then the file. */
export function multipartBody(
  fields: Record<string, unknown>,
  file: { field: string; name: string; contentType: string; data: Buffer } | null,
): { contentType: string; body: Buffer } {
  const boundary = `----GenosynMcp${randomBytes(16).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name.replace(/[\r\n"]/g, "_")}"\r\n\r\n`,
      ),
      Buffer.from(text, "utf8"),
      Buffer.from("\r\n"),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

/**
 * The HTTP request a call stands for, or the structural mistake that stops it.
 * `cid` is always the caller's company: it may be left out, and naming another
 * company is refused.
 */
export function buildRequest(
  operation: CatalogueOperation,
  args: CallArguments,
  context: Pick<CallerContext, "companyId" | "companyName" | "authorization" | "forwardedHeaders">,
): BuildResult {
  const supplied = args.path ?? {};
  for (const [name, value] of Object.entries(supplied)) {
    if (name === "cid") {
      if (String(value) !== context.companyId) {
        return fail(
          `This server acts for ${context.companyName} (${context.companyId}) only. Leave cid out — it is filled in for you.`,
        );
      }
      continue;
    }
    if (!operation.pathParams.includes(name)) {
      return fail(
        operation.pathParams.length
          ? `${operation.name} has no path parameter "${name}". Its path parameters are ${list(operation.pathParams)}.`
          : `${operation.name} takes no path parameters; "${name}" is not one. Query-string values go in query.`,
      );
    }
  }
  const missing = operation.pathParams.filter((name) => {
    const value = supplied[name];
    return value === undefined || String(value).trim() === "";
  });
  if (missing.length) {
    return fail(
      `${operation.name} needs the path parameter${missing.length === 1 ? "" : "s"} ${list(missing)} (${operation.path}). Find the id${missing.length === 1 ? "" : "s"} with a list or search operation first.`,
    );
  }
  for (const name of operation.pathParams) {
    const value = String(supplied[name]).trim();
    if (value === "." || value === "..") {
      return fail(`The path parameter "${name}" cannot be "${value}".`);
    }
  }
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(name === "cid" ? context.companyId : String(supplied[name]).trim()),
  );

  const query = args.query ?? {};
  const missingQuery = operation.queryParams.filter(
    (parameter) =>
      parameter.required && (query[parameter.name] === undefined || query[parameter.name] === null),
  );
  if (missingQuery.length) {
    return fail(
      `${operation.name} needs the query parameter${missingQuery.length === 1 ? "" : "s"} ${list(missingQuery.map((parameter) => parameter.name))}.`,
    );
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) appendQuery(params, name, value);
  const queryString = params.toString();

  const headers: Record<string, string> = {
    ...context.forwardedHeaders,
    authorization: context.authorization,
    accept: "application/json, */*;q=0.8",
  };
  let body: Buffer | undefined;
  const bodyArgument = unwrapJsonText(args.body);
  const hasBody =
    bodyArgument !== undefined &&
    !(isPlainObject(bodyArgument) && Object.keys(bodyArgument).length === 0);

  if (operation.body === null) {
    if (hasBody) {
      return fail(
        `${operation.name} takes no request body. Its inputs go in ${operation.pathParams.length ? "path and " : ""}query.`,
      );
    }
    if (args.file) return fail(`${operation.name} takes no file.`);
  } else if (operation.body.kind === "unsupported") {
    return fail(
      `${operation.name} takes a ${operation.body.contentType} body, which this server cannot send. Call the REST API directly for it.`,
    );
  } else if (operation.body.kind === "json") {
    if (args.file) {
      return fail(`${operation.name} takes a JSON body, not a file. Put the data in body instead.`);
    }
    body = Buffer.from(JSON.stringify(bodyArgument === undefined ? {} : bodyArgument), "utf8");
    headers["content-type"] = "application/json";
  } else {
    if (bodyArgument !== undefined && !isPlainObject(bodyArgument)) {
      return fail(`${operation.name} takes a form: body must be an object of its text fields.`);
    }
    let file: Parameters<typeof multipartBody>[1] = null;
    if (args.file) {
      if (!operation.upload) return fail(`${operation.name} takes no file.`);
      const decoded = decodeFile(args.file);
      if (!decoded.ok) return fail(decoded.message);
      file = { field: operation.upload.field, ...decoded };
    } else if (operation.upload?.required) {
      return fail(
        `${operation.name} needs a file: ${operation.upload.description} Pass it as file, with its name and its contents as base64 or text.`,
      );
    }
    const form = multipartBody((bodyArgument as Record<string, unknown> | undefined) ?? {}, file);
    body = form.body;
    headers["content-type"] = form.contentType;
  }

  return {
    ok: true,
    request: {
      method: operation.method.toUpperCase(),
      target: queryString ? `${path}?${queryString}` : path,
      path,
      headers,
      body,
    },
  };
}

export type SentRequest =
  | { ok: true; request: BuiltRequest; response: InProcessResponse }
  | { ok: false; request: BuiltRequest; error: InProcessRequestError };

/** Send a built request to the App, in memory, as the caller. */
export async function sendRequest(
  context: Pick<CallerContext, "app" | "remote"> & { member?: Pick<CallerContext["member"], "id"> },
  request: BuiltRequest,
  signal?: AbortSignal,
): Promise<SentRequest> {
  const inner: InProcessRequest = {
    method: request.method,
    path: request.target,
    headers: request.headers,
    body: request.body,
    remote: context.remote,
    timeoutMs: CALL_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    responseLimit: responseReadLimit,
    signal,
  };
  let release: (() => void) | null = null;
  try {
    // A Member runs a few operations at a time; the rest wait their turn.
    if (context.member) release = await acquireSlot(context.member.id, { signal });
    return { ok: true, request, response: await requestInProcess(context.app, inner) };
  } catch (error) {
    return {
      ok: false,
      request,
      error:
        error instanceof InProcessRequestError
          ? error
          : new InProcessRequestError(
              error instanceof Error ? error.message : String(error),
              signal?.aborted ? "aborted" : "failed",
            ),
    };
  } finally {
    release?.();
  }
}
