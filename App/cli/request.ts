import path from "node:path";

import { suggest, type FlagParam, type ItemParam } from "./argv.js";
import { CliError, UnknownParameterError, usageError } from "./errors.js";
import { redactHeaders, type HttpRequest } from "./http.js";
import type { Operation, OperationIndex, OperationParam } from "./operations.js";

/**
 * From what someone typed to the HTTP request an operation needs.
 *
 * Every parameter is reachable three ways — `--amount-cents 500`,
 * `amountCents=500`, or inside `--data '{"amountCents":500}'` — and path
 * parameters also positionally, in path order (`routines run <rid>`). Text
 * becomes the type the field's schema names: numbers, booleans, JSON for
 * objects and arrays, repeated flags for a list, `name:=<json>` for anything
 * exact. The company in the path is filled in from the profile.
 *
 * The client checks structure only — a path parameter or upload file that is
 * missing can't make a request at all. Whether values are acceptable is the
 * server's call; it answers 400 with the exact issues.
 */

export type DataInput =
  | { kind: "json"; value: unknown; source: string }
  | { kind: "bytes"; value: Uint8Array; source: string };

export type BuildInput = {
  index: OperationIndex;
  operation: Operation;
  flags: FlagParam[];
  items: ItemParam[];
  positionals: string[];
  data?: DataInput;
  baseUrl: string;
  companyId?: string;
  apiKey?: string;
  cwd: string;
  openFile: (file: string) => Promise<Blob>;
};

export type RequestPreview = {
  operationId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type BuiltRequest = { request: HttpRequest; preview: RequestPreview; query: Record<string, string | undefined> };

type Given = { param: OperationParam; raw: string | boolean; json: boolean; label: string };

/** How a parameter is written in messages: its flag, or `name=…` when it has none. */
export function paramLabel(param: OperationParam): string {
  if (param.location === "path") return `<${param.name}>`;
  return param.flag ?? `${param.name}=…`;
}

function typeError(given: Given, expected: string): never {
  throw usageError(
    `${given.label} expects ${expected}, not ${JSON.stringify(String(given.raw))}.`,
    `Write ${given.param.name}:=<json> to send an exact JSON value.`,
  );
}

function parseJson(given: Given, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return typeError(given, "JSON");
  }
}

/** One value as the schema's type wants it. */
export function coerceValue(
  index: OperationIndex,
  schemaParam: OperationParam,
  given: Given,
  schema = schemaParam.schema,
): unknown {
  const raw = given.raw;
  if (typeof raw === "boolean") return raw;
  if (given.json) return parseJson(given, raw);
  const resolver = index.resolver;
  const resolved = resolver.deref(schema);
  const types = resolver.allowedTypes(resolved);
  const nullable = types.has("null");
  if (raw === "null" && nullable && (!types.has("string") || !!resolved.format)) return null;
  if (types.has("string") || types.size === 0) return raw;
  if (types.has("integer") || types.has("number")) {
    const trimmed = raw.trim();
    const number = trimmed === "" ? Number.NaN : Number(trimmed);
    if (Number.isFinite(number)) {
      if (types.has("integer") && !types.has("number") && !Number.isInteger(number)) {
        typeError(given, "a whole number");
      }
      return number;
    }
    if (!types.has("boolean") && !types.has("object") && !types.has("array")) {
      typeError(given, "a number");
    }
  }
  if (types.has("boolean")) {
    const lowered = raw.trim().toLowerCase();
    if (["true", "yes", "1"].includes(lowered)) return true;
    if (["false", "no", "0"].includes(lowered)) return false;
    if (!types.has("object") && !types.has("array")) typeError(given, "true or false");
  }
  if (types.has("array") || types.has("object")) {
    const trimmed = raw.trim();
    if (types.has("array") && !trimmed.startsWith("[") && resolved.items) {
      return [coerceValue(index, schemaParam, given, resolved.items)];
    }
    return parseJson(given, trimmed);
  }
  return raw;
}

function isArraySchema(index: OperationIndex, param: OperationParam): boolean {
  const types = index.resolver.allowedTypes(param.schema);
  return types.has("array") && !types.has("string") && !types.has("object");
}

/** Collect each parameter's value(s): repeated flags extend a list, otherwise the last wins. */
function collect(input: BuildInput): Map<OperationParam, unknown> {
  const { index, operation } = input;
  const given: Given[] = [];
  const known = index.parametersOf(operation);
  const unknown = (name: string, raw: string): never => {
    const labels = new Map(
      known.map((param) => [param.flag ? param.flag.slice(2) : param.name, param] as const),
    );
    const close = suggest(name, [...labels.keys()]).map((candidate) =>
      paramLabel(labels.get(candidate) as OperationParam),
    );
    throw new UnknownParameterError(
      `${operation.operationId} has no parameter "${name}" (from ${raw}).`,
      close.length
        ? `Did you mean ${close.join(", ")}? \`genosyn-api describe ${operation.operationId}\` lists them all.`
        : `\`genosyn-api describe ${operation.operationId}\` lists its parameters, and --data takes a whole body.`,
    );
  };
  for (const flag of input.flags) {
    const param = index.findParam(operation, flag.name);
    if (!param) unknown(flag.name, flag.raw);
    given.push({
      param: param as OperationParam,
      raw: flag.value,
      json: false,
      label: `--${flag.name}`,
    });
  }
  for (const item of input.items) {
    const param = index.findParam(operation, item.name);
    if (!param) unknown(item.name, item.raw);
    given.push({ param: param as OperationParam, raw: item.value, json: item.json, label: item.name });
  }

  const values = new Map<OperationParam, unknown>();
  for (const entry of given) {
    const value = coerceValue(index, entry.param, entry);
    if (isArraySchema(index, entry.param) && entry.param.location !== "path") {
      const list = (values.get(entry.param) as unknown[] | undefined) ?? [];
      if (Array.isArray(value)) list.push(...value);
      else list.push(value);
      values.set(entry.param, list);
    } else {
      values.set(entry.param, value);
    }
  }

  const unfilled = operation.pathParams.filter((param) => !values.has(param));
  const positionals = [...input.positionals];
  for (const param of unfilled) {
    if (positionals.length === 0) break;
    values.set(param, positionals.shift());
  }
  if (positionals.length) {
    throw usageError(
      `Unexpected argument${positionals.length > 1 ? "s" : ""}: ${positionals.join(" ")}.`,
      operation.pathParams.length
        ? `${operation.operationId} takes ${operation.pathParams.map((param) => `<${param.name}>`).join(" ")}; give other parameters as --name value or name=value.`
        : `${operation.operationId} takes no positional arguments; give parameters as --name value or name=value.`,
    );
  }
  const missing = operation.pathParams.filter((param) => !values.has(param));
  if (missing.length) {
    throw usageError(
      `${operation.operationId} needs ${missing.map((param) => `<${param.name}>`).join(" ")}.`,
      `Usage: genosyn-api call ${operation.operationId} ${operation.pathParams.map((param) => `<${param.name}>`).join(" ")}`,
    );
  }
  return values;
}

function queryString(values: Map<OperationParam, unknown>, operation: Operation): {
  search: URLSearchParams;
  query: Record<string, string | undefined>;
} {
  const search = new URLSearchParams();
  const query: Record<string, string | undefined> = {};
  for (const param of operation.queryParams) {
    if (!values.has(param)) continue;
    const value = values.get(param);
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(param.name, typeof item === "object" ? JSON.stringify(item) : String(item));
    } else if (typeof value === "object") {
      if (param.deepObject) {
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          if (inner === undefined || inner === null) continue;
          search.append(`${param.name}[${key}]`, typeof inner === "object" ? JSON.stringify(inner) : String(inner));
        }
      } else {
        search.append(param.name, JSON.stringify(value));
      }
    } else {
      search.append(param.name, String(value));
    }
    query[param.name] = search.getAll(param.name).at(-1);
  }
  return { search, query };
}

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".epub": "application/epub+zip",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

/** A file's media type from its extension, for the upload's part header. */
export function mediaTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function formText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Build the request. Throws a usage error for anything that can't be sent. */
export async function buildRequest(input: BuildInput): Promise<BuiltRequest> {
  const { operation } = input;
  const values = collect(input);

  if (operation.companyScoped && !input.companyId) {
    throw usageError(`${operation.operationId} acts in a company, and none is set.`);
  }
  let urlPath = operation.path;
  if (operation.companyScoped) {
    urlPath = urlPath.replace("{cid}", encodeURIComponent(input.companyId as string));
  }
  for (const param of operation.pathParams) {
    urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(values.get(param))));
  }
  const { search, query } = queryString(values, operation);
  const url = `${input.baseUrl}${urlPath}${search.size ? `?${search.toString()}` : ""}`;
  // The path comes from the server's description. Whatever it says, the key
  // goes to the install it belongs to and nowhere else.
  if (!operation.path.startsWith("/") || new URL(url).origin !== new URL(input.baseUrl).origin) {
    throw new CliError(
      "network",
      `${operation.operationId}'s path (${operation.path}) leads away from ${input.baseUrl}; nothing was sent.`,
    );
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;

  const bodyValues = operation.bodyFields.filter((param) => values.has(param));
  let body: HttpRequest["body"];
  let previewBody: unknown;
  const kind = operation.body?.kind;

  if (!operation.body) {
    if (input.data) {
      throw usageError(`${operation.operationId} takes no request body, so --data has nowhere to go.`);
    }
  } else if (kind === "json") {
    let payload: unknown;
    if (input.data) {
      payload =
        input.data.kind === "json"
          ? input.data.value
          : (() => {
              throw usageError("--data must be JSON for this operation.");
            })();
    }
    if (bodyValues.length) {
      if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
        throw usageError(
          "--data is not a JSON object, so individual fields can't be added to it.",
          "Put every field in --data, or drop --data and pass them as flags.",
        );
      }
      const object: Record<string, unknown> = { ...((payload as Record<string, unknown>) ?? {}) };
      for (const param of bodyValues) object[param.name] = values.get(param);
      payload = object;
    }
    if (payload === undefined && operation.body.required) payload = {};
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["content-type"] = "application/json";
      previewBody = payload;
    }
  } else if (kind === "multipart") {
    const form = new FormData();
    const shown: Record<string, string> = {};
    if (input.data) {
      const extra = input.data.kind === "json" ? input.data.value : undefined;
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
        throw usageError("--data must be a JSON object of form fields for this upload.");
      }
      for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
        form.append(name, formText(value));
        shown[name] = formText(value);
      }
    }
    for (const param of bodyValues) {
      const value = values.get(param);
      if (param.file) {
        if (typeof value !== "string" || value === "") {
          throw usageError(`${paramLabel(param)} takes the path of a file to upload.`);
        }
        const file = path.resolve(input.cwd, value);
        let blob: Blob;
        try {
          blob = await input.openFile(file);
        } catch (error) {
          throw usageError(`Can't read ${value}: ${(error as Error).message}`);
        }
        form.append(param.name, blob, path.basename(file));
        shown[param.name] = `@${file} (${blob.size} bytes)`;
      } else {
        form.delete(param.name);
        form.append(param.name, formText(value));
        shown[param.name] = formText(value);
      }
    }
    const missingFiles = operation.bodyFields.filter(
      (param) => param.file && param.required && !values.has(param),
    );
    if (missingFiles.length) {
      throw usageError(
        `${operation.operationId} uploads a file: pass ${missingFiles.map((param) => `${paramLabel(param)} <path>`).join(" and ")}.`,
      );
    }
    body = form;
    previewBody = { form: shown };
  } else {
    if (!input.data) {
      if (operation.body.required) {
        throw usageError(
          `${operation.operationId} takes raw ${operation.body.contentType}: pass --data @<file> or --data - for stdin.`,
        );
      }
    } else {
      const bytes =
        input.data.kind === "bytes"
          ? input.data.value
          : new TextEncoder().encode(JSON.stringify(input.data.value));
      body = bytes;
      headers["content-type"] = operation.body.contentType;
      previewBody = { bytes: bytes.byteLength, contentType: operation.body.contentType };
    }
  }

  const request: HttpRequest = {
    method: operation.method,
    url,
    headers,
    body,
    operationId: operation.operationId,
  };
  const preview: RequestPreview = {
    operationId: operation.operationId,
    method: operation.method,
    url,
    headers: redactHeaders(headers),
    ...(previewBody !== undefined ? { body: previewBody } : {}),
  };
  return { request, preview, query };
}

/** Replace query values on an already-built request: the next page of a list. */
export function withQuery(request: HttpRequest, replace: Record<string, string>): HttpRequest {
  const url = new URL(request.url);
  for (const [name, value] of Object.entries(replace)) url.searchParams.set(name, value);
  return { ...request, url: url.toString() };
}
