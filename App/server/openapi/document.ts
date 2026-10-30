import {
  OpenApiGeneratorV3,
  type OpenAPIRegistry,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import type { ZodTypeAny } from "zod";
import { routeMetadataOf, type RequestSchemaLocation } from "../middleware/routeMetadata.js";
import { AREAS, areaOf } from "./areas.js";
import { exclusionFor, NOT_PUBLIC_API, type Exclusion } from "./exclusions.js";
import {
  assignOperationIds,
  OPERATION_ID_OVERRIDES,
  operationNameFor,
  summaryFor,
} from "./naming.js";
import { registry } from "./registry.js";
import {
  accessDescription,
  accessExtension,
  accessOf,
  securityFor,
  type RouteAccess,
} from "./routeAccess.js";
import {
  discoverRoutes,
  type DiscoveredRoute,
  type HttpMethod,
  type UndocumentableRoute,
} from "./routeDiscovery.js";
import {
  convertZodSchemas,
  isOptionalSchema,
  objectShapeOf,
  type JsonSchema,
} from "./schemaConversion.js";
import { MULTIPART_UPLOADS, RAW_UPLOADS } from "./uploads.js";
// The hand-written registrations, imported for their side effect: each calls
// `registry.registerPath(...)` at module load. A new one goes here.
import "./auth.js";
import "./companies.js";
import "./apiKeys.js";
import "./employees.js";
import "./employeeAccess.js";
import "./routines.js";
import "./revenue.js";
import "./finance.js";
import "./pagedLists.js";
import "./mcp.js";
import "./webhooks.js";

/**
 * The whole API reference: every route the App answers, minus the short list
 * in `exclusions.ts`.
 *
 * Two sources meet here. The hand-written registrations under
 * `server/openapi/` carry prose and response schemas no generator could know,
 * so for the routes they cover they win — except for who may call the route,
 * which always comes from the guards that actually run (`routeAccess.ts`), so
 * a hand-written page can never promise access the server refuses. Every other
 * route is described from the router itself (`routeDiscovery.ts`): its path
 * and parameters, the zod schemas its validators enforce, its upload form, the
 * area it belongs to, an operation id and summary derived from its path, and
 * the same access paragraph.
 *
 * {@link buildApiDocument} also returns what it could not do — routes no area
 * claims, hand-written pages for routes that no longer exist, exclusions that
 * match nothing — which the coverage test turns into failures.
 */

export type DocumentedOperation = {
  method: HttpMethod;
  path: string;
  operationId: string;
  area: string;
  /** False when a hand-written registration describes the route. */
  generated: boolean;
  access: RouteAccess;
};

export type CoverageReport = {
  documented: DocumentedOperation[];
  excluded: Array<{ method: HttpMethod; path: string; reason: string }>;
  /** Routes the walker found but could not describe. */
  undocumentable: UndocumentableRoute[];
  /** Documented routes no area rule places. */
  unplaced: string[];
  /** Hand-written registrations for routes the App does not serve. */
  staleHandWritten: string[];
  /** Exclusions that match no route. */
  staleExclusions: Exclusion[];
  /** Upload table entries that match no route. */
  staleUploads: string[];
  /** Operation id overrides that match no route. */
  staleOverrides: string[];
  /** Routes that run multer without an upload table entry. */
  uploadsWithoutEntry: string[];
  /** Routes registered earlier that answer another route's requests first. */
  shadowed: string[];
  /** Operations whose schemas zod-to-openapi refused, described by the fallback. */
  fallbacks: string[];
};

type OpenApiObject = ReturnType<OpenApiGeneratorV3["generateDocument"]>;

/** One registry entry — a route, schema or component. The library does not export the name. */
type OpenAPIDefinitions = OpenAPIRegistry["definitions"][number];

const keyOf = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

/** The zod schemas a route's validators record, by request location. Later validators win. */
function recordedSchemas(
  route: DiscoveredRoute,
): Partial<Record<RequestSchemaLocation, ZodTypeAny>> {
  const found: Partial<Record<RequestSchemaLocation, ZodTypeAny>> = {};
  for (const handle of [...route.chain.map((link) => link.handle), ...route.handlers]) {
    const metadata = routeMetadataOf(handle);
    if (metadata?.kind === "requestSchema") found[metadata.location] = metadata.schema;
  }
  return found;
}

/**
 * Query parameters a handler reads without a `validateQuery` schema, by the
 * `req.query.name` accesses in its source. Documented as optional strings:
 * the name is certain, the accepted values are the handler's business.
 */
export function inferredQueryParameters(handlers: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const handler of handlers) {
    if (typeof handler !== "function") continue;
    const source = Function.prototype.toString.call(handler);
    for (const match of source.matchAll(/\breq\.query\??\.([A-Za-z_$][\w$]*)/g))
      names.add(match[1]);
    for (const match of source.matchAll(/\breq\.query\??\.?\[\s*["'`]([^"'`]+)["'`]\s*\]/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/**
 * The success status a route answers with: 201 when its handler says so, 200
 * otherwise. Read from the handler's source, like the query names above; any
 * 2xx means success to a client, so the cost of a miss is a less exact page.
 */
export function successStatusOf(handlers: readonly unknown[]): 200 | 201 {
  for (const handler of handlers) {
    if (typeof handler !== "function") continue;
    if (/\.status\(\s*201\s*\)/.test(Function.prototype.toString.call(handler))) return 201;
  }
  return 200;
}

/** Whether a route runs multer, which the upload table must then describe. */
function runsMulter(route: DiscoveredRoute): boolean {
  return route.handlers.some(
    (handle) => typeof handle === "function" && handle.name === "multerMiddleware",
  );
}

const BINARY_SEGMENTS = new Set([
  "avatar",
  "download",
  "file",
  "html",
  "logo",
  "pdf",
  "recording",
  "resume",
]);

/** The success response for a generated operation: JSON, or the bytes of a file. */
function successResponse(method: HttpMethod, path: string, status: 200 | 201) {
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const previous = segments[segments.length - 2] ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(last)?.[1]?.toLowerCase();
  const binary =
    method === "get" &&
    (BINARY_SEGMENTS.has(last) ||
      (last.startsWith("{") && previous.endsWith("attachments")) ||
      (extension !== undefined && extension !== "json"));
  if (binary) {
    const type =
      extension === "csv"
        ? "text/csv"
        : last === "html"
          ? "text/html"
          : last === "pdf"
            ? "application/pdf"
            : "application/octet-stream";
    return {
      description: "The file. `Content-Type` names its type.",
      content: { [type]: { schema: { type: "string", format: "binary" } } },
    };
  }
  return {
    description: status === 201 ? "Created." : "Success.",
    content: { "application/json": { schema: {} } },
  };
}

/** Shared error responses, referenced by every generated operation. */
const ERROR_COMPONENTS: OpenAPIDefinitions[] = [
  {
    type: "component",
    componentType: "schemas",
    name: "Error",
    component: {
      type: "object",
      properties: { error: { type: "string", description: "What went wrong, in plain words." } },
      required: ["error"],
    },
  },
  {
    type: "component",
    componentType: "schemas",
    name: "ValidationError",
    component: {
      type: "object",
      properties: {
        error: { type: "string", enum: ["ValidationError"] },
        issues: {
          type: "array",
          description: "The zod issues: each names the `path` to the field and a `message`.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["error", "issues"],
    },
  },
  {
    type: "component",
    componentType: "responses",
    name: "ValidationFailed",
    component: {
      description: "The request did not match the schema.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationError" } } },
    },
  },
  {
    type: "component",
    componentType: "responses",
    name: "Unauthorized",
    component: {
      description:
        "No valid session or API key — or a key used outside its own company's paths.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  },
  {
    type: "component",
    componentType: "responses",
    name: "Forbidden",
    component: {
      description:
        "Authenticated, but not allowed: not a Member of this company, a missing role or Finance " +
        "access, or a browser-only action.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  },
  {
    type: "component",
    componentType: "responses",
    name: "NotFound",
    component: {
      description: "Nothing with that id in this company.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  },
];

const ref = (name: string) => ({ $ref: `#/components/responses/${name}` });

type Built = { document: OpenApiObject; report: CoverageReport };

/** Build the API reference for `app`, and the report the coverage test reads. */
export function buildApiDocument(app: unknown, info: { version: string }): Built {
  const discovery = discoverRoutes(app);
  const report: CoverageReport = {
    documented: [],
    excluded: [],
    undocumentable: discovery.undocumentable,
    unplaced: [],
    staleHandWritten: [],
    staleExclusions: [],
    staleUploads: [],
    staleOverrides: [],
    uploadsWithoutEntry: [],
    shadowed: [],
    fallbacks: [],
  };

  // Hand-written registrations, keyed the way discovered routes are.
  const handWritten = new Map<string, RouteConfig>();
  const otherDefinitions: OpenAPIDefinitions[] = [];
  for (const definition of registry.definitions) {
    if ("type" in definition && definition.type === "route") {
      handWritten.set(keyOf(definition.route.method, definition.route.path), definition.route);
    } else {
      otherDefinitions.push(definition);
    }
  }

  // Keep the routes that belong in the reference.
  const routes: DiscoveredRoute[] = [];
  const seen = new Set<string>();
  const matchedExclusions = new Set<Exclusion>();
  for (const route of discovery.routes) {
    const key = keyOf(route.method, route.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const exclusion = exclusionFor(route.method, route.path);
    if (exclusion) {
      matchedExclusions.add(exclusion);
      report.excluded.push({ method: route.method, path: route.path, reason: exclusion.reason });
      continue;
    }
    if (route.shadowedBy) report.shadowed.push(`${key} (answered first by ${route.shadowedBy})`);
    routes.push(route);
  }
  report.staleExclusions = NOT_PUBLIC_API.filter((entry) => !matchedExclusions.has(entry));
  for (const key of handWritten.keys()) if (!seen.has(key)) report.staleHandWritten.push(key);
  report.staleUploads = [...Object.keys(MULTIPART_UPLOADS), ...Object.keys(RAW_UPLOADS)].filter(
    (key) => !seen.has(key),
  );

  // Convert every schema the generated operations need in one pass.
  const schemasByRoute = new Map<
    DiscoveredRoute,
    Partial<Record<RequestSchemaLocation, ZodTypeAny>>
  >();
  const wanted: ZodTypeAny[] = [];
  for (const route of routes) {
    if (handWritten.has(keyOf(route.method, route.path))) continue;
    const schemas = recordedSchemas(route);
    schemasByRoute.set(route, schemas);
    if (schemas.body) wanted.push(schemas.body);
    for (const location of ["query", "params"] as const) {
      const schema = schemas[location];
      if (schema) wanted.push(...Object.values(objectShapeOf(schema) ?? {}));
    }
    const upload = MULTIPART_UPLOADS[keyOf(route.method, route.path)];
    if (upload?.fieldsSchema)
      wanted.push(...Object.values(objectShapeOf(upload.fieldsSchema) ?? {}));
  }
  const conversion = convertZodSchemas(wanted);
  const json = (schema: ZodTypeAny): JsonSchema => conversion.converted.get(schema) ?? {};
  const fellBack = new Set(conversion.fallbacks);

  // Operation ids: hand-written ones are kept, then the override table, and the
  // rest are derived from method + path.
  const reserved = new Map<string, string>();
  for (const [key, id] of Object.entries(OPERATION_ID_OVERRIDES))
    if (seen.has(key)) reserved.set(key, id);
  for (const [key, route] of handWritten)
    if (route.operationId) reserved.set(key, route.operationId);
  report.staleOverrides = Object.keys(OPERATION_ID_OVERRIDES).filter((key) => !seen.has(key));
  const operationIds = assignOperationIds(
    routes.map((route) => ({ method: route.method, path: route.path })),
    reserved,
  );

  const definitions: OpenAPIDefinitions[] = [...otherDefinitions, ...ERROR_COMPONENTS];
  for (const [name, component] of Object.entries(conversion.components)) {
    definitions.push({ type: "component", componentType: "schemas", name, component });
  }
  const usedAreas = new Set<string>();

  for (const route of routes) {
    const key = keyOf(route.method, route.path);
    const access = accessOf(route);
    const area = areaOf(route);
    if (!area) report.unplaced.push(key);
    const operationId = operationIds.get(key) as string;
    const security = securityFor(access);
    const accessText = accessDescription(access, route.path);
    if (runsMulter(route) && !MULTIPART_UPLOADS[key] && !handWritten.has(key)) {
      report.uploadsWithoutEntry.push(key);
    }

    const hand = handWritten.get(key);
    if (hand) {
      const tags = hand.tags?.length ? hand.tags : [area ?? "Other"];
      tags.forEach((tag) => usedAreas.add(tag));
      definitions.push({
        type: "route",
        route: {
          ...hand,
          operationId,
          tags,
          security,
          description: [hand.description, accessText].filter(Boolean).join("\n\n"),
          "x-genosyn-access": accessExtension(access),
        } as RouteConfig,
      });
      report.documented.push({
        method: route.method,
        path: route.path,
        operationId,
        area: tags[0],
        generated: false,
        access,
      });
      continue;
    }

    const tag = area ?? "Other";
    usedAreas.add(tag);
    const schemas = schemasByRoute.get(route) ?? {};
    const usedFallback = Object.values(schemas).some(
      (schema) =>
        schema &&
        (fellBack.has(schema) ||
          Object.values(objectShapeOf(schema) ?? {}).some((inner) => fellBack.has(inner))),
    );
    if (usedFallback) report.fallbacks.push(key);

    // Path parameters, typed by `validateParams` where a route has one.
    const paramShape = schemas.params ? objectShapeOf(schemas.params) : null;
    const parameters: Array<Record<string, unknown>> = route.pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: paramShape?.[name] ? json(paramShape[name]) : { type: "string" },
      ...(name === "cid"
        ? { description: "The company id. API keys only work for their own company." }
        : {}),
    }));

    // Query parameters: the `validateQuery` schema, or the names the handler reads.
    const queryShape = schemas.query ? objectShapeOf(schemas.query) : null;
    if (queryShape) {
      for (const [name, schema] of Object.entries(queryShape)) {
        const converted = json(schema);
        parameters.push({
          name,
          in: "query",
          required: !isOptionalSchema(schema),
          schema: converted,
          ...(converted.type === "object" ? { style: "deepObject", explode: true } : {}),
        });
      }
    } else if (!schemas.query) {
      for (const name of inferredQueryParameters(route.handlers)) {
        parameters.push({ name, in: "query", required: false, schema: { type: "string" } });
      }
    }

    // The request body: an upload form, raw bytes, or the `validateBody` schema.
    let requestBody: Record<string, unknown> | undefined;
    const upload = MULTIPART_UPLOADS[key];
    const raw = RAW_UPLOADS[key];
    if (upload) {
      const fieldShape = upload.fieldsSchema ? (objectShapeOf(upload.fieldsSchema) ?? {}) : {};
      const properties: Record<string, JsonSchema> = {
        [upload.fileField]: { type: "string", format: "binary", description: upload.file },
        ...Object.fromEntries(
          Object.entries(fieldShape).map(([name, schema]) => [name, json(schema)]),
        ),
        ...(upload.fields ?? {}),
      };
      const required = [
        ...(upload.fileOptional ? [] : [upload.fileField]),
        ...Object.entries(fieldShape)
          .filter(([, schema]) => !isOptionalSchema(schema))
          .map(([name]) => name),
      ];
      requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties, ...(required.length ? { required } : {}) },
          },
        },
      };
    } else if (raw) {
      requestBody = {
        required: true,
        description: raw.description,
        content: { [raw.contentType]: { schema: { type: "string", format: "binary" } } },
      };
    } else if (schemas.body) {
      requestBody = {
        required: !isOptionalSchema(schemas.body),
        content: { "application/json": { schema: json(schemas.body) } },
      };
    }

    const success = successStatusOf(route.handlers);
    const responses: Record<string, unknown> = {
      [success]: successResponse(route.method, route.path, success),
    };
    if (schemas.body || schemas.query || schemas.params || upload)
      responses[400] = ref("ValidationFailed");
    if (access.authenticated) {
      responses[401] = ref("Unauthorized");
      responses[403] = ref("Forbidden");
    }
    if (route.pathParams.some((name) => name !== "cid")) responses[404] = ref("NotFound");

    const name = operationNameFor(route.method, route.path);
    definitions.push({
      type: "route",
      route: {
        method: route.method,
        path: route.path,
        operationId,
        summary: summaryFor(name),
        description: accessText,
        tags: [tag],
        security,
        ...(parameters.length ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
        "x-genosyn-access": accessExtension(access),
      } as unknown as RouteConfig,
    });
    report.documented.push({
      method: route.method,
      path: route.path,
      operationId,
      area: tag,
      generated: true,
      access,
    });
  }

  const tags = [
    ...AREAS.filter((area) => usedAreas.has(area.name)),
    ...[...usedAreas]
      .filter((name) => !AREAS.some((area) => area.name === name))
      .sort()
      .map((name) => ({ name, description: "" })),
  ];

  const generated = new OpenApiGeneratorV3(definitions).generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Genosyn API",
      version: info.version,
      description: API_DESCRIPTION,
      contact: { name: "Genosyn", url: "https://github.com/Genosyn/genosyn" },
      license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    tags: tags.map((area) => (area.description ? area : { name: area.name })),
  });
  // Plain JSON from here on: the library leaves `undefined` defaults on some
  // extended schemas, and the cached document must equal the one served.
  const document = JSON.parse(JSON.stringify(generated)) as OpenApiObject;
  return { document, report };
}

const API_DESCRIPTION = [
  "The REST API behind every screen of Genosyn — the open-source platform for running companies " +
    "with AI Employees. Anything a Member can do in the app goes through the endpoints listed here.",
  "**Authentication.** Mint a personal API key at **Settings → API keys** and send it as " +
    "`Authorization: Bearer gen_…`. A key acts as the Member who minted it, with that Member's " +
    "current role, and only for the one company it was minted for: every company operation lives " +
    "under `/api/companies/{cid}`, and anywhere else — another company, the account — a key is " +
    "not recognized and gets 401. Start with `GET /api/companies/{cid}/me`, which names the " +
    "Member, role and key a request acts as. Each operation's **Access** paragraph says what it " +
    "needs.",
  "**Browser-only operations.** A few operations are marked `cookieAuth` only and refuse API keys: " +
    "account and sign-in changes, minting and revoking keys, invitations and Member roles, " +
    "instance administration, deciding Approvals, the credentials behind Integrations, AI Models, " +
    "MCP servers, phone numbers and Repositories, and conversations that carry a Member's " +
    "delegated authority to an AI Employee. They need a person at a signed-in browser by design.",
  '**Errors.** Failures answer with a JSON body `{ "error": "…" }`; a request that fails its ' +
    'schema answers 400 with `{ "error": "ValidationError", "issues": […] }`.',
  "**Stability.** Every operation has a stable `operationId` derived from its method and path, " +
    "and is grouped under a tag for its product area. `GET /api/openapi.json` serves this " +
    "document; `/api/docs` renders it.",
].join("\n\n");
