import { kebabCase, normalizeName } from "./argv.js";
import { RESERVED_FLAG_NAMES } from "./options.js";
import { SchemaResolver, type Components, type JsonSchema } from "./schema.js";

/**
 * The command tree, read from the server's OpenAPI document at run time.
 *
 * Nothing about an operation is written into the CLI: every area, command,
 * parameter and body field comes from `/api/openapi.json`, so an endpoint is
 * callable from the CLI the day the server ships it. The names follow from
 * the reference's own stable choices:
 *
 *   tag "Revenue"             → area command   `revenue`
 *   operationId listRevenueDeals → `call listRevenueDeals`, and
 *                               `revenue list-revenue-deals`, shortened to
 *                               `revenue list-deals` when the area's own
 *                               words open the name and no sibling claims it
 *   parameter amountCents     → `--amount-cents`, or `amountCents=…`
 *
 * Operation ids change only when a route's method or path does, so scripts
 * and agents should call by id; the grouped names are for people.
 */

export type OpenApiDocument = {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: Components;
};

/** `x-genosyn-access`: who may call an operation. */
export type Access = {
  apiKey?: boolean;
  browserSession?: boolean;
  /** Why only a browser may: "accountLevel", "browserSession" or "masterAdmin". */
  sessionOnly?: string | boolean;
  minimumRole?: string;
  financeAccess?: string;
  /** What a key may not do here even though it may call it: "to assign an AI Employee". */
  browserSessionRequiredTo?: string[] | string;
  [key: string]: unknown;
};

export type ParamLocation = "path" | "query" | "body";

export type OperationParam = {
  name: string;
  location: ParamLocation;
  required: boolean;
  schema: JsonSchema;
  description?: string;
  /** A multipart field that carries a file: its value is a path on disk. */
  file: boolean;
  /** `--kebab-name`; absent when a CLI option owns that name, so only `name=value` reaches it. */
  flag?: string;
  /** A query object sent as `name[key]=value`. */
  deepObject: boolean;
};

export type OperationBody = {
  kind: "json" | "multipart" | "raw";
  contentType: string;
  required: boolean;
  schema: JsonSchema;
  description?: string;
};

export type Operation = {
  operationId: string;
  method: string;
  path: string;
  /** The path below `/api/companies/{cid}` — what tables show. */
  shortPath: string;
  area: string;
  areaSlug: string;
  summary: string;
  description: string;
  access: Access;
  /** An API key may call it. */
  apiKey: boolean;
  /** Anyone may call it, with no credential at all: health, public forms, signing links. */
  public: boolean;
  /** The CLI can call it: with the key, or with nothing. */
  callable: boolean;
  /** Whether the path starts `/api/companies/{cid}`, which the CLI fills in itself. */
  companyScoped: boolean;
  /** In the order they appear in the path, without `cid`. */
  pathParams: OperationParam[];
  queryParams: OperationParam[];
  bodyFields: OperationParam[];
  body?: OperationBody;
  /** The content type of a success response that is a file rather than JSON. */
  fileResponse?: string;
  kebabId: string;
  /** The name under its area command: the shortened name when unique, else `kebabId`. */
  commandName: string;
};

export type AreaInfo = {
  name: string;
  slug: string;
  description: string;
  operations: Operation[];
  /** How many of its operations take an API key — what listings show by default. */
  apiKeyOperations: number;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const COMPANY_PREFIX = /^\/api\/companies\/\{cid\}(?=\/|$)/;

/** "Letters to the board" → `letters-to-the-board`. */
export function areaSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) return word.slice(0, -1);
  return word;
}

/**
 * The area's words dropped from just after the verb: in Revenue,
 * `list-revenue-deals` reads `list-deals`; in Routines, `run-routine` reads
 * `run`. Null when the name doesn't open with every one of them.
 */
export function shortenWithinArea(kebabId: string, slug: string): string | null {
  const words = kebabId.split("-");
  const areaWords = slug.split("-").filter(Boolean);
  if (words.length < 2 || areaWords.length === 0) return null;
  const rest = words.slice(1);
  if (rest.length < areaWords.length) return null;
  const matches = areaWords.every((word, index) => singular(word) === singular(rest[index]));
  if (!matches) return null;
  return [words[0], ...rest.slice(areaWords.length)].join("-");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The flag a parameter may use, unless a CLI option already owns the name. */
function flagFor(name: string): string | undefined {
  const kebab = kebabCase(name);
  return RESERVED_FLAG_NAMES.has(kebab) || RESERVED_FLAG_NAMES.has(name)
    ? undefined
    : `--${kebab}`;
}

export class OperationIndex {
  readonly operations: Operation[] = [];
  readonly areas: AreaInfo[] = [];
  readonly resolver: SchemaResolver;
  readonly serverVersion?: string;
  private readonly byId = new Map<string, Operation>();
  private readonly byLowerId = new Map<string, Operation>();
  private readonly byKebab = new Map<string, Operation>();
  private readonly lookups = new Map<
    Operation,
    { exact: Map<string, OperationParam>; normalized: Map<string, OperationParam | null> }
  >();

  constructor(readonly document: OpenApiDocument) {
    this.resolver = new SchemaResolver(document.components ?? {});
    this.serverVersion = document.info?.version;
    const descriptions = new Map(
      (document.tags ?? []).map((tag) => [tag.name, tag.description ?? ""]),
    );
    const areaOrder = (document.tags ?? []).map((tag) => tag.name);
    const areas = new Map<string, AreaInfo>();

    for (const [path, item] of Object.entries(document.paths ?? {})) {
      const pathItem = asRecord(item);
      for (const method of METHODS) {
        if (!(method in pathItem)) continue;
        const raw = asRecord(pathItem[method]);
        const operationId = text(raw.operationId);
        if (!operationId || this.byId.has(operationId)) continue;
        const operation = this.readOperation(method, path, raw, pathItem);
        this.operations.push(operation);
        this.byId.set(operationId, operation);
        this.byLowerId.set(operationId.toLowerCase(), operation);
        this.byKebab.set(operation.kebabId, operation);
        let area = areas.get(operation.area);
        if (!area) {
          area = {
            name: operation.area,
            slug: operation.areaSlug,
            description: descriptions.get(operation.area) ?? "",
            operations: [],
            apiKeyOperations: 0,
          };
          areas.set(operation.area, area);
        }
        area.operations.push(operation);
        if (operation.apiKey) area.apiKeyOperations += 1;
      }
    }

    const ordered = [
      ...areaOrder.filter((name) => areas.has(name)),
      ...[...areas.keys()].filter((name) => !areaOrder.includes(name)).sort(),
    ];
    for (const name of ordered) {
      const area = areas.get(name) as AreaInfo;
      this.assignCommandNames(area);
      this.areas.push(area);
    }
  }

  private readOperation(
    method: string,
    path: string,
    raw: Record<string, unknown>,
    pathItem: Record<string, unknown>,
  ): Operation {
    const operationId = text(raw.operationId);
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === "string") : [];
    const area = (tags[0] as string | undefined) ?? "Other";
    const access = asRecord(raw["x-genosyn-access"]) as Access;
    const security = Array.isArray(raw.security) ? raw.security : undefined;
    const bearer = (security ?? []).some((entry) => "bearerAuth" in asRecord(entry));
    const apiKey = typeof access.apiKey === "boolean" ? access.apiKey : bearer;
    const isPublic =
      !apiKey &&
      !access.sessionOnly &&
      (access.browserSession === false ||
        (access.browserSession === undefined && Array.isArray(security) && security.length === 0));
    const companyScoped = COMPANY_PREFIX.test(path);

    const parameters = [
      ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
      ...(Array.isArray(raw.parameters) ? raw.parameters : []),
    ].map((entry) => this.resolver.deref(asRecord(entry) as JsonSchema) as Record<string, unknown>);
    const pathOrder = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pathParams: OperationParam[] = [];
    const queryParams: OperationParam[] = [];
    const declaredPath = new Map<string, Record<string, unknown>>();
    for (const parameter of parameters) {
      const name = text(parameter.name);
      if (!name) continue;
      if (parameter.in === "path") declaredPath.set(name, parameter);
      else if (parameter.in === "query") {
        const schema = asRecord(parameter.schema) as JsonSchema;
        queryParams.push({
          name,
          location: "query",
          required: parameter.required === true,
          schema,
          description: text(parameter.description) || text(schema.description) || undefined,
          file: false,
          flag: flagFor(name),
          deepObject: parameter.style === "deepObject",
        });
      }
    }
    for (const name of pathOrder) {
      if (name === "cid" && companyScoped) continue;
      const parameter = declaredPath.get(name) ?? {};
      const schema = asRecord(parameter.schema) as JsonSchema;
      pathParams.push({
        name,
        location: "path",
        required: true,
        schema: Object.keys(schema).length ? schema : { type: "string" },
        description: text(parameter.description) || undefined,
        file: false,
        flag: flagFor(name),
        deepObject: false,
      });
    }

    let body: OperationBody | undefined;
    const bodyFields: OperationParam[] = [];
    const requestBody = this.resolver.deref(asRecord(raw.requestBody) as JsonSchema) as Record<
      string,
      unknown
    >;
    const content = asRecord(requestBody.content);
    const contentTypes = Object.keys(content);
    const chosen =
      contentTypes.find((type) => type.includes("json")) ??
      contentTypes.find((type) => type === "multipart/form-data") ??
      contentTypes[0];
    if (chosen) {
      const schema = asRecord(asRecord(content[chosen]).schema) as JsonSchema;
      const kind = chosen.includes("json")
        ? "json"
        : chosen === "multipart/form-data"
          ? "multipart"
          : "raw";
      body = {
        kind,
        contentType: chosen,
        required: requestBody.required === true,
        schema,
        description: text(requestBody.description) || undefined,
      };
      if (kind !== "raw") {
        const taken = new Set([...pathParams, ...queryParams].map((param) => param.name));
        const { properties, required } = this.resolver.objectFields(schema);
        for (const [name, property] of Object.entries(properties)) {
          if (taken.has(name)) continue;
          const resolved = this.resolver.deref(property);
          bodyFields.push({
            name,
            location: "body",
            required: required.has(name),
            schema: property,
            description: text(resolved.description) || undefined,
            file: kind === "multipart" && this.resolver.isBinary(resolved),
            flag: flagFor(name),
            deepObject: false,
          });
        }
      }
    }

    const responses = asRecord(raw.responses);
    const successTypes = Object.entries(responses)
      .filter(([status]) => /^2/.test(status))
      .flatMap(([, response]) =>
        Object.keys(asRecord(asRecord(this.resolver.deref(asRecord(response) as JsonSchema)).content)),
      );
    const fileResponse =
      successTypes.length && !successTypes.some((type) => type.includes("json"))
        ? successTypes[0]
        : undefined;

    const kebabId = kebabCase(operationId);
    return {
      operationId,
      method: method.toUpperCase(),
      path,
      shortPath: companyScoped ? path.replace(COMPANY_PREFIX, "") || "/" : path,
      area,
      areaSlug: areaSlug(area) || "other",
      summary: text(raw.summary),
      description: text(raw.description),
      access,
      apiKey,
      public: isPublic,
      callable: apiKey || isPublic,
      companyScoped,
      pathParams,
      queryParams,
      bodyFields,
      body,
      fileResponse,
      kebabId,
      commandName: kebabId,
    };
  }

  /** Shortened names where they are unambiguous within the area; the full name otherwise. */
  private assignCommandNames(area: AreaInfo): void {
    const candidates = new Map<Operation, string>();
    const counts = new Map<string, number>();
    const fullNames = new Set(area.operations.map((operation) => operation.kebabId));
    for (const operation of area.operations) {
      const short = shortenWithinArea(operation.kebabId, area.slug);
      if (!short || short === operation.kebabId) continue;
      candidates.set(operation, short);
      counts.set(short, (counts.get(short) ?? 0) + 1);
    }
    for (const [operation, short] of candidates) {
      if (counts.get(short) === 1 && !fullNames.has(short)) operation.commandName = short;
    }
  }

  /** An operation by id (exact or any case) or by its kebab-case id. */
  find(name: string): Operation | undefined {
    return (
      this.byId.get(name) ??
      this.byLowerId.get(name.toLowerCase()) ??
      this.byKebab.get(name.toLowerCase())
    );
  }

  /** An area by slug or name, any case. */
  area(name: string): AreaInfo | undefined {
    const wanted = name.toLowerCase();
    return this.areas.find(
      (area) => area.slug === wanted || area.name.toLowerCase() === wanted,
    );
  }

  /** An operation under an area command: its command name, kebab id or operation id. */
  findInArea(area: AreaInfo, name: string): Operation | undefined {
    const wanted = name.toLowerCase();
    return (
      area.operations.find((operation) => operation.commandName === wanted) ??
      area.operations.find(
        (operation) =>
          operation.kebabId === wanted || operation.operationId.toLowerCase() === wanted,
      )
    );
  }

  /** Every parameter of an operation, path first, then query, then body fields. */
  parametersOf(operation: Operation): OperationParam[] {
    return [...operation.pathParams, ...operation.queryParams, ...operation.bodyFields];
  }

  /**
   * The parameter a flag or `name=value` names: exact first, then ignoring
   * case and separators (`--amount-cents` finds `amountCents`) when that is
   * unambiguous.
   */
  findParam(operation: Operation, name: string): OperationParam | undefined {
    let lookup = this.lookups.get(operation);
    if (!lookup) {
      lookup = { exact: new Map(), normalized: new Map() };
      for (const param of this.parametersOf(operation)) {
        if (!lookup.exact.has(param.name)) lookup.exact.set(param.name, param);
        const key = normalizeName(param.name);
        const existing = lookup.normalized.get(key);
        lookup.normalized.set(key, existing === undefined ? param : existing === param ? param : null);
      }
      this.lookups.set(operation, lookup);
    }
    return lookup.exact.get(name) ?? lookup.normalized.get(normalizeName(name)) ?? undefined;
  }

  /** The command people type for an operation: `revenue list-deals`. */
  commandFor(operation: Operation): string {
    return `${operation.areaSlug} ${operation.commandName}`;
  }

  /**
   * Operations matching every word of `query` somewhere in their id, command,
   * summary, path or area, best first.
   */
  search(query: string, options: { includeAll?: boolean } = {}): Operation[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ operation: Operation; score: number; order: number }> = [];
    this.operations.forEach((operation, order) => {
      if (!operation.apiKey && !options.includeAll) return;
      if (words.length === 0) {
        scored.push({ operation, score: 0, order });
        return;
      }
      const id = operation.operationId.toLowerCase();
      const fields: Array<[string, number]> = [
        [id, 30],
        [operation.kebabId, 30],
        [operation.commandName, 25],
        [operation.summary.toLowerCase(), 20],
        [operation.path.toLowerCase(), 15],
        [operation.area.toLowerCase(), 10],
        [operation.areaSlug, 10],
      ];
      let score = 0;
      for (const word of words) {
        let best = 0;
        for (const [field, weight] of fields) {
          if (field.includes(word)) best = Math.max(best, weight);
        }
        if (best === 0) return;
        score += best;
      }
      if (words.length === 1 && id === words[0]) score += 1000;
      else if (id.startsWith(words[0])) score += 5;
      scored.push({ operation, score, order });
    });
    return scored
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ operation }) => operation);
  }
}
