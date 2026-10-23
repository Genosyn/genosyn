import type { FinanceAccess, Role } from "../../db/entities/Membership.js";
import { roleAtLeast } from "../../middleware/auth.js";
import { buildOpenApiDocument } from "../../openapi/spec.js";
import { openApiToJsonSchema, type JsonSchema } from "./jsonSchema.js";

/**
 * Every operation the Genosyn MCP server can call, generated from the API
 * reference.
 *
 * The reference (`GET /api/openapi.json`) is built from the live router stack,
 * and marks each operation an API key may call with `x-genosyn-access.apiKey`.
 * Each of those becomes one generated tool here — its name the operation's
 * stable `operationId`, its input schema the path, query and body the route's
 * own validators enforce, and its MCP annotations read from the HTTP method —
 * so the server is complete the day a route lands, with no list to maintain.
 * The resident tools (`tools.ts`) search, describe and call these.
 *
 * One area is left out: `MCP`, the Streamable HTTP transports themselves (this
 * server's endpoint, and an AI Employee's). They carry JSON-RPC rather than
 * act on a record, and calling one through another would only nest sessions.
 *
 * Documented operations a key cannot call are kept apart with the reason, so
 * a request for one is refused with an explanation rather than "not found".
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Which resident tool calls an operation: reads, writes and deletes are kept apart. */
export type OperationKind = "read" | "write" | "delete";

export const CALL_TOOL_BY_KIND = {
  read: "call_read_operation",
  write: "call_write_operation",
  delete: "call_delete_operation",
} as const satisfies Record<OperationKind, string>;

export type CallToolName = (typeof CALL_TOOL_BY_KIND)[OperationKind];

/** MCP tool annotations. `readOnlyHint`, `destructiveHint` and `idempotentHint` come from the method. */
export type OperationAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
};

export type QueryParameter = {
  name: string;
  required: boolean;
  /** An object, sent `name[key]=value` as OpenAPI's `deepObject` style says. */
  deepObject: boolean;
};

export type CatalogueOperation = {
  /** The operationId, which is also the generated tool's name. */
  name: string;
  method: HttpMethod;
  /** The OpenAPI path template, `/api/companies/{cid}/…`. */
  path: string;
  area: string;
  summary: string;
  /** The summary, the reference's own prose, and what the caller needs. */
  description: string;
  kind: OperationKind;
  callTool: CallToolName;
  annotations: OperationAnnotations;
  /** `{ path, query, body, file }` as JSON Schema — the generated tool's input. */
  inputSchema: JsonSchema;
  /** Path parameters the caller supplies: every one but `cid`, which is the company. */
  pathParams: string[];
  queryParams: QueryParameter[];
  body:
    | { kind: "json" | "multipart"; required: boolean }
    | { kind: "unsupported"; contentType: string }
    | null;
  /** The file a multipart operation takes, and the form field it goes in. */
  upload: { field: string; required: boolean; description: string } | null;
  response: { status: number; contentType: string; description: string; binary: boolean };
  access: {
    minimumRole?: Exclude<Role, "member">;
    financeAccess?: Exclude<FinanceAccess, "none">;
    browserSessionRequiredTo: string[];
  };
};

/** A documented operation the MCP server cannot call, and why. */
export type UnavailableOperation = {
  name: string;
  method: HttpMethod;
  path: string;
  area: string;
  summary: string;
  reason: string;
};

export type OperationCatalogue = {
  operations: CatalogueOperation[];
  byName: Map<string, CatalogueOperation>;
  unavailable: Map<string, UnavailableOperation>;
  /** Product areas holding at least one operation, in the reference's order. */
  areas: Array<{ name: string; description: string }>;
};

/** The area of the MCP transports, which the catalogue leaves out. */
export const TRANSPORT_AREA = "MCP";

const METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

const KIND_BY_METHOD: Record<HttpMethod, OperationKind> = {
  get: "read",
  post: "write",
  put: "write",
  patch: "write",
  delete: "delete",
};

/**
 * MCP annotations from HTTP semantics. A GET only reads. A POST adds or acts
 * (creating a record, sending, starting work) without overwriting anything it
 * names; PUT and PATCH overwrite fields; DELETE removes. GET, PUT and DELETE are
 * idempotent, POST and PATCH are not. They are hints for a client deciding what
 * to ask a person about, not guarantees.
 */
export function annotationsFor(method: HttpMethod, title: string): OperationAnnotations {
  switch (method) {
    case "get":
      return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    case "post":
      return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    case "put":
      return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    case "patch":
      return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false };
    case "delete":
      return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  }
}

export function kindOf(method: HttpMethod): OperationKind {
  return KIND_BY_METHOD[method];
}

// ── reading the document ───────────────────────────────────────────────────

type OpenApiParameter = {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  description?: unknown;
  schema?: unknown;
  style?: unknown;
};

type OpenApiOperation = {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: unknown;
  parameters?: unknown;
  requestBody?: { required?: unknown; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: unknown; content?: Record<string, unknown> }>;
  "x-genosyn-access"?: {
    apiKey?: unknown;
    sessionOnly?: unknown;
    minimumRole?: unknown;
    financeAccess?: unknown;
    browserSessionRequiredTo?: unknown;
  };
};

/** The parts of an OpenAPI document the catalogue reads. */
export type OpenApiDocumentLike = {
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: { schemas?: Record<string, unknown> };
  tags?: Array<{ name: string; description?: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** End a summary as a sentence. */
function sentence(value: string): string {
  if (!value) return value;
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/** The reference's prose without its Access paragraph, which the requirements below replace. */
function proseOf(description: string): string {
  return description
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("**Access.**"))
    .join("\n\n");
}

function requirementSentences(access: CatalogueOperation["access"]): string[] {
  const sentences: string[] = [];
  if (access.minimumRole) sentences.push(`Needs the ${access.minimumRole} company role or higher.`);
  if (access.financeAccess) {
    sentences.push(
      access.financeAccess === "full" ? "Needs full Finance access." : "Needs Finance read access.",
    );
  }
  for (const when of access.browserSessionRequiredTo) {
    sentences.push(
      `A person at a signed-in browser is required ${when}; an API key is refused for that.`,
    );
  }
  return sentences;
}

/** Why a documented operation is not in the catalogue. */
function unavailableReason(operation: OpenApiOperation, area: string): string {
  const access = operation["x-genosyn-access"] ?? {};
  if (area === TRANSPORT_AREA) {
    return "It is an MCP transport endpoint, not an operation: point an MCP client at it directly.";
  }
  switch (access.sessionOnly) {
    case "browserSession":
      return "It needs a person at a signed-in browser — Genosyn refuses API keys for it by design.";
    case "masterAdmin":
      return "It is instance administration, for a master admin at a signed-in browser.";
    case "accountLevel":
      return "It acts on a signed-in account rather than one company, so no API key reaches it.";
  }
  if (access.apiKey !== true) {
    return "It is public and outside the company API: it takes no API key, so call it over HTTP.";
  }
  return "It is not available to this server.";
}

function successResponse(operation: OpenApiOperation): CatalogueOperation["response"] {
  const statuses = Object.keys(operation.responses ?? {})
    .filter((status) => /^2\d\d$/.test(status))
    .sort();
  const status = statuses[0] ?? "200";
  const response = operation.responses?.[status];
  const contentType = Object.keys(response?.content ?? {})[0] ?? "application/json";
  return {
    status: Number(status),
    contentType,
    description: text(response?.description),
    binary: contentType !== "application/json",
  };
}

/** The tool input for one operation, and what the caller supplies where. */
function inputFor(
  operation: OpenApiOperation,
  components: Record<string, unknown>,
): Pick<CatalogueOperation, "inputSchema" | "pathParams" | "queryParams" | "body" | "upload"> {
  const parameters = (Array.isArray(operation.parameters) ? operation.parameters : []).filter(
    (parameter): parameter is OpenApiParameter => isRecord(parameter),
  );
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const pathParams: string[] = [];
  const pathProperties: Record<string, JsonSchema> = {};
  for (const parameter of parameters) {
    const name = text(parameter.name);
    if (parameter.in !== "path" || !name || name === "cid") continue;
    pathParams.push(name);
    const schema = openApiToJsonSchema(parameter.schema ?? { type: "string" }, components);
    const description = text(parameter.description);
    pathProperties[name] = description && !schema.description ? { ...schema, description } : schema;
  }
  if (pathParams.length) {
    properties.path = {
      type: "object",
      description: "Path parameters. The company is always this server's own.",
      properties: pathProperties,
      required: pathParams,
      additionalProperties: false,
    };
    required.push("path");
  }

  const queryParams: QueryParameter[] = [];
  const queryProperties: Record<string, JsonSchema> = {};
  for (const parameter of parameters) {
    const name = text(parameter.name);
    if (parameter.in !== "query" || !name) continue;
    const schema = openApiToJsonSchema(parameter.schema ?? { type: "string" }, components);
    const description = text(parameter.description);
    queryProperties[name] =
      description && !schema.description ? { ...schema, description } : schema;
    queryParams.push({
      name,
      required: parameter.required === true,
      deepObject:
        parameter.style === "deepObject" ||
        (isRecord(parameter.schema) && parameter.schema.type === "object"),
    });
  }
  if (queryParams.length) {
    const requiredQuery = queryParams.filter((parameter) => parameter.required).map((p) => p.name);
    properties.query = {
      type: "object",
      description: "Query-string parameters.",
      properties: queryProperties,
      ...(requiredQuery.length ? { required: requiredQuery } : {}),
      additionalProperties: false,
    };
    if (requiredQuery.length) required.push("query");
  }

  let body: CatalogueOperation["body"] = null;
  let upload: CatalogueOperation["upload"] = null;
  const content = operation.requestBody?.content ?? {};
  const bodyRequired = operation.requestBody?.required === true;
  if (content["application/json"]) {
    body = { kind: "json", required: bodyRequired };
    properties.body = {
      ...openApiToJsonSchema(content["application/json"].schema ?? {}, components),
    };
    if (bodyRequired) required.push("body");
  } else if (content["multipart/form-data"]) {
    const form = openApiToJsonSchema(content["multipart/form-data"].schema ?? {}, components);
    const formProperties = isRecord(form.properties) ? form.properties : {};
    const formRequired = Array.isArray(form.required) ? (form.required as string[]) : [];
    const fileField = Object.entries(formProperties).find(
      ([, schema]) => isRecord(schema) && schema.format === "binary",
    );
    const fields: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(formProperties)) {
      if (name !== fileField?.[0]) fields[name] = schema;
    }
    const fieldsRequired = formRequired.filter((name) => name !== fileField?.[0]);
    body = { kind: "multipart", required: fieldsRequired.length > 0 };
    if (Object.keys(fields).length) {
      properties.body = {
        type: "object",
        description:
          "The form's text fields. An object or array is sent as JSON text, as the form expects.",
        properties: fields,
        ...(fieldsRequired.length ? { required: fieldsRequired } : {}),
      };
      if (fieldsRequired.length) required.push("body");
    }
    if (fileField) {
      const fileRequired = formRequired.includes(fileField[0]);
      const description =
        isRecord(fileField[1]) && typeof fileField[1].description === "string"
          ? fileField[1].description
          : "The file to upload.";
      upload = { field: fileField[0], required: fileRequired, description };
      properties.file = fileArgumentSchema(
        `${description} Sent as the form's "${fileField[0]}" field.`,
      );
      if (fileRequired) required.push("file");
    }
  } else {
    const contentType = Object.keys(content)[0];
    if (contentType) body = { kind: "unsupported", contentType };
  }

  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    pathParams,
    queryParams,
    body,
    upload,
  };
}

/** How an MCP client hands over a file: its name, and its bytes as base64 or text. */
export function fileArgumentSchema(description: string): JsonSchema {
  return {
    type: "object",
    description: `${description} Give its name and exactly one of base64 (any file) or text (a text file).`,
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        description: "The file name, with its extension: contract.pdf, leads.csv.",
      },
      contentType: {
        type: "string",
        maxLength: 255,
        description: "Its MIME type. Guessed from the name when left out.",
      },
      base64: { type: "string", description: "The file's bytes, base64-encoded." },
      text: {
        type: "string",
        description: "The file's contents as UTF-8 text, instead of base64.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
}

function accessOf(operation: OpenApiOperation): CatalogueOperation["access"] {
  const access = operation["x-genosyn-access"] ?? {};
  const role =
    access.minimumRole === "admin" || access.minimumRole === "owner"
      ? access.minimumRole
      : undefined;
  const finance =
    access.financeAccess === "read" || access.financeAccess === "full"
      ? access.financeAccess
      : undefined;
  return {
    ...(role ? { minimumRole: role } : {}),
    ...(finance ? { financeAccess: finance } : {}),
    browserSessionRequiredTo: Array.isArray(access.browserSessionRequiredTo)
      ? access.browserSessionRequiredTo.filter((when): when is string => typeof when === "string")
      : [],
  };
}

/** Build the catalogue from an API reference document. Pure: the same document, the same catalogue. */
export function buildOperationCatalogue(document: OpenApiDocumentLike): OperationCatalogue {
  const components = document.components?.schemas ?? {};
  const operations: CatalogueOperation[] = [];
  const unavailable = new Map<string, UnavailableOperation>();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!isRecord(operation)) continue;
      const name = text(operation.operationId);
      if (!name) continue;
      const area =
        Array.isArray(operation.tags) && typeof operation.tags[0] === "string"
          ? operation.tags[0]
          : "Other";
      const summary = text(operation.summary) || name;
      const callable =
        operation["x-genosyn-access"]?.apiKey === true &&
        area !== TRANSPORT_AREA &&
        /^\/api\/companies\/\{cid\}(?:\/|$)/.test(path);
      if (!callable) {
        unavailable.set(name, {
          name,
          method,
          path,
          area,
          summary,
          reason: unavailableReason(operation, area),
        });
        continue;
      }
      const access = accessOf(operation);
      const prose = proseOf(text(operation.description));
      const kind = kindOf(method);
      operations.push({
        name,
        method,
        path,
        area,
        summary,
        description: [sentence(summary), prose, ...requirementSentences(access)]
          .filter(Boolean)
          .join("\n\n"),
        kind,
        callTool: CALL_TOOL_BY_KIND[kind],
        annotations: annotationsFor(method, summary),
        ...inputFor(operation, components),
        response: successResponse(operation),
        access,
      });
    }
  }

  // Code-unit order, not the locale's: the same on every machine.
  operations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const used = new Set(operations.map((operation) => operation.area));
  const areas = (document.tags ?? [])
    .filter((tag) => used.has(tag.name))
    .map((tag) => ({ name: tag.name, description: tag.description ?? "" }));
  for (const name of [...used].sort()) {
    if (!areas.some((area) => area.name === name)) areas.push({ name, description: "" });
  }
  return {
    operations,
    byName: new Map(operations.map((operation) => [operation.name, operation])),
    unavailable,
    areas,
  };
}

const catalogues = new WeakMap<object, OperationCatalogue>();

/**
 * The catalogue for the Express app the server listens with. Built once per
 * app, like the reference it reads: routes never change while the process runs.
 */
export function operationCatalogue(app: object): OperationCatalogue {
  let catalogue = catalogues.get(app);
  if (!catalogue) {
    catalogue = buildOperationCatalogue(
      buildOpenApiDocument(app) as unknown as OpenApiDocumentLike,
    );
    catalogues.set(app, catalogue);
  }
  return catalogue;
}

// ── what one Member may call ───────────────────────────────────────────────

/** The facts availability depends on: the key's Member, as the company sees them now. */
export type CallerStanding = { role: Role; financeAccess: FinanceAccess };

/**
 * Whether the Member could call the operation, judged from the reference's
 * access notes. A hint for search results: the operation's own guards decide,
 * and a handler may check more than the reference can see.
 */
export function availabilityFor(
  operation: Pick<CatalogueOperation, "access">,
  caller: CallerStanding,
): { available: true } | { available: false; reason: string } {
  const { minimumRole, financeAccess } = operation.access;
  if (minimumRole && !roleAtLeast(minimumRole, caller.role)) {
    return {
      available: false,
      reason: `Needs the ${minimumRole} company role or higher; the key's Member is ${withArticle(caller.role)}.`,
    };
  }
  if (financeAccess === "read" && caller.financeAccess === "none") {
    return {
      available: false,
      reason: "Needs Finance read access; the key's Member has no Finance access.",
    };
  }
  if (financeAccess === "full" && caller.financeAccess !== "full") {
    return {
      available: false,
      reason: `Needs full Finance access; the key's Member has ${caller.financeAccess === "read" ? "read-only" : "no"} Finance access.`,
    };
  }
  return { available: true };
}

function withArticle(role: Role): string {
  return role === "owner" || role === "admin" ? `an ${role}` : `a ${role}`;
}
