import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { indefiniteArticle } from "../../shared/indefiniteArticle.js";
import { createApp } from "../app.js";
import { buildOpenApiDocument } from "./spec.js";

// The document describes the very app the server listens with.
const app = createApp();

type Operation = {
  summary?: string;
  description?: string;
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
  }>;
  requestBody?: {
    content?: Record<string, { schema?: SchemaShape }>;
  };
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
};

type SchemaShape = {
  additionalProperties?: boolean | SchemaShape;
  description?: string;
  enum?: unknown[];
  format?: string;
  items?: SchemaShape;
  maxLength?: number;
  minLength?: number;
  oneOf?: SchemaShape[];
  nullable?: boolean;
  properties?: Record<string, SchemaShape>;
  required?: string[];
  type?: string;
};

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

function operations(document: ReturnType<typeof buildOpenApiDocument>) {
  return Object.entries(document.paths ?? {}).flatMap(([route, pathItem]) =>
    Object.entries(pathItem ?? {})
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({
        method,
        operation: operation as Operation,
        route,
      })),
  );
}

function operationAt(
  document: ReturnType<typeof buildOpenApiDocument>,
  route: string,
  method = "post",
): Operation {
  const operation = document.paths?.[route]?.[method as keyof (typeof document.paths)[string]];
  assert.ok(operation, `${method.toUpperCase()} ${route} is missing`);
  return operation as Operation;
}

function requestSchema(
  document: ReturnType<typeof buildOpenApiDocument>,
  route: string,
  mediaType: string,
): SchemaShape {
  const schema = operationAt(document, route).requestBody?.content?.[mediaType]?.schema;
  assert.ok(schema, `POST ${route} has no ${mediaType} request schema`);
  return schema;
}

test("OpenAPI document exposes a versioned and authenticated scripting contract", () => {
  const document = buildOpenApiDocument(app);
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const version = fs.readFileSync(path.resolve(currentDir, "../../../VERSION"), "utf8").trim();

  assert.equal(document.openapi, "3.0.0");
  assert.equal(document.info.title, "Genosyn API");
  assert.equal(document.info.version, version);
  assert.equal(document.servers?.[0]?.description, "This Genosyn instance");
  assert.match(document.servers?.[0]?.url ?? "", /^https?:\/\//);
  assert.deepEqual(Object.keys(document.components?.securitySchemes ?? {}).sort(), [
    "bearerAuth",
    "cookieAuth",
  ]);
});

test("Finance documents expose subsidiary selection and admin-managed legal entities", () => {
  const document = buildOpenApiDocument(app);
  const base = "/api/companies/{cid}/finance";
  const list = operationAt(document, `${base}/subsidiaries`, "get");
  const create = operationAt(document, `${base}/subsidiaries`);
  const edit = operationAt(document, `${base}/subsidiaries/{id}`, "patch");
  assert.match(list.description ?? "", /Read Finance/);
  assert.match(create.description ?? "", /owner or admin/);
  assert.ok(create.responses?.["201"]);
  assert.match(edit.description ?? "", /snapshots remain unchanged/);
  const patch = edit.requestBody?.content?.["application/json"]?.schema;
  assert.equal(patch?.properties?.archived?.type, "boolean");

  for (const resource of ["invoices", "estimates", "recurring-invoices"]) {
    for (const [method, suffix] of [
      ["post", ""],
      ["patch", "/{slug}"],
    ]) {
      const operation = operationAt(document, `/api/companies/{cid}/${resource}${suffix}`, method);
      const input = operation.requestBody?.content?.["application/json"]?.schema;
      assert.equal(input?.properties?.subsidiaryId?.format, "uuid", `${method} ${resource}`);
      assert.equal(input?.properties?.subsidiaryId?.nullable, true, `${method} ${resource}`);
      assert.ok(!input?.required?.includes("subsidiaryId"));
    }
  }
  assert.ok(document.components?.schemas?.DocumentIssuerSnapshot);
  assert.ok(document.components?.schemas?.Subsidiary);
});

test("Finance document operations name the document with the article it takes", () => {
  const document = buildOpenApiDocument(app);
  const base = "/api/companies/{cid}";
  // These read "Edit a invoice" and "Edit a estimate" while the article was hard-coded.
  assert.equal(
    operationAt(document, `${base}/invoices/{slug}`, "patch").summary,
    "Edit an invoice",
  );
  assert.equal(
    operationAt(document, `${base}/estimates/{slug}`, "patch").summary,
    "Edit an estimate",
  );
  assert.equal(operationAt(document, `${base}/invoices`).summary, "Create a draft invoice");
  assert.equal(operationAt(document, `${base}/estimates`).summary, "Create a draft estimate");
});

test("every summary and description puts the article its next word takes", () => {
  const document = buildOpenApiDocument(app);
  let checked = 0;
  for (const { method, operation, route } of operations(document)) {
    for (const text of [operation.summary, operation.description]) {
      if (!text) continue;
      const where = `${method.toUpperCase()} ${route}`;
      assert.doesNotMatch(text, /\b(?:a|an|the)\s+(?:a|an|the)\b/i, `${where}: doubled article`);
      for (const [, article, word] of text.matchAll(/\b(a|an)\s+([A-Za-z]+)/gi)) {
        assert.equal(
          article.toLowerCase(),
          indefiniteArticle(word),
          `${where}: "${article} ${word}"`,
        );
        checked += 1;
      }
    }
  }
  // The scan has to have read real prose for a pass to mean anything.
  assert.ok(checked > 50, `only ${checked} articles were checked`);
});

test("Recurring invoice names default to the customer on create and stay put on edit", () => {
  const document = buildOpenApiDocument(app);
  const create = operationAt(document, "/api/companies/{cid}/recurring-invoices");
  const createInput = create.requestBody?.content?.["application/json"]?.schema;
  assert.deepEqual(createInput?.required, ["customerId", "cronExpr"]);
  assert.equal(createInput?.properties?.name?.type, "string");
  assert.equal(createInput?.properties?.name?.maxLength, 200);
  assert.equal(createInput?.properties?.name?.minLength, undefined);
  assert.match(createInput?.properties?.name?.description ?? "", /named after its customer/);
  assert.match(create.description ?? "", /blank name names the schedule after its customer/);

  const edit = operationAt(document, "/api/companies/{cid}/recurring-invoices/{slug}", "patch");
  const editInput = edit.requestBody?.content?.["application/json"]?.schema;
  assert.equal(editInput?.required, undefined);
  assert.equal(editInput?.properties?.name?.minLength, 1);
  assert.equal(editInput?.properties?.name?.maxLength, 200);
  assert.match(edit.description ?? "", /never renames the schedule/);
});

test("an AI Employee carries its Team and no reporting line", () => {
  const document = buildOpenApiDocument(app);
  const employee = document.components?.schemas?.Employee as SchemaShape | undefined;
  assert.ok(employee?.properties, "the Employee schema is published");
  assert.ok(employee.properties.teamId, "the Team stays");
  assert.equal(employee.properties.reportsToEmployeeId, undefined);
  assert.equal(employee.properties.reportsToUserId, undefined);
});

test("no operation or schema still describes reporting lines", () => {
  // Browser-recording access used to extend to the Member an AI Employee
  // reported to; it is owners and admins (or a Member browser's own owner).
  const text = JSON.stringify(buildOpenApiDocument(app));
  assert.doesNotMatch(text, /reportsTo|reporting line|reporting-line|employee reports to/i);
  const collection = operationAt(
    buildOpenApiDocument(app),
    "/api/companies/{cid}/runs/{runId}/browser-recordings",
    "get",
  );
  assert.match(collection.description ?? "", /requires an owner or admin role/);
});

test("Routine browser recordings document cookie-only metadata and range streaming", () => {
  const document = buildOpenApiDocument(app);
  const collection = operationAt(
    document,
    "/api/companies/{cid}/runs/{runId}/browser-recordings",
    "get",
  );
  const file = operationAt(
    document,
    "/api/companies/{cid}/runs/{runId}/browser-recordings/{sessionId}",
    "get",
  );

  assert.deepEqual(collection.security, [{ cookieAuth: [] }]);
  assert.deepEqual(file.security, [{ cookieAuth: [] }]);
  assert.ok(collection.responses?.["200"]);
  assert.ok(file.responses?.["206"]);
  assert.ok(file.responses?.["416"]);
});

test("every registered operation has tags, responses, and valid path parameters", () => {
  const document = buildOpenApiDocument(app);
  const registered = operations(document);

  assert.ok(registered.length >= 35, `expected broad API coverage, got ${registered.length}`);
  for (const { method, operation, route } of registered) {
    assert.ok(operation.tags?.length, `${method.toUpperCase()} ${route} has no tag`);
    assert.ok(
      Object.keys(operation.responses ?? {}).length,
      `${method.toUpperCase()} ${route} has no response`,
    );

    const routeParameters = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const declared = (operation.parameters ?? []).filter((parameter) => parameter.in === "path");
    assert.deepEqual(
      declared.map((parameter) => parameter.name).sort(),
      routeParameters.sort(),
      `${method.toUpperCase()} ${route} path parameters do not match`,
    );
    for (const parameter of declared) {
      assert.equal(
        parameter.required,
        true,
        `${method.toUpperCase()} ${route} path parameter ${parameter.name} is optional`,
      );
    }
  }
});

test("authentication endpoints explicitly distinguish public and protected operations", () => {
  const document = buildOpenApiDocument(app);
  const registered = operations(document);
  const publicRoutes = new Set([
    "POST /api/auth/forgot",
    "POST /api/auth/login",
    "POST /api/auth/login/passkey/options",
    "POST /api/auth/login/passkey/verify",
    "POST /api/auth/reset",
    "POST /api/auth/signup",
    "POST /api/auth/verify-email",
  ]);

  for (const { method, operation, route } of registered) {
    const key = `${method.toUpperCase()} ${route}`;
    if (publicRoutes.has(key)) {
      assert.deepEqual(operation.security, [], `${key} must be public`);
    }
  }

  for (const key of publicRoutes) {
    assert.ok(
      registered.some(({ method, route }) => `${method.toUpperCase()} ${route}` === key),
      `${key} is documented`,
    );
  }

  // Security comes from the guards that actually run, not from the prose.
  // Signing out takes no credential — it ends whatever session the cookie
  // carries, or none — so it is public, whatever its page once claimed.
  const logout = registered.find(
    ({ method, route }) => method === "post" && route === "/api/auth/logout",
  );
  assert.deepEqual(logout?.operation.security, []);
  const me = registered.find(({ method, route }) => method === "get" && route === "/api/auth/me");
  assert.deepEqual(me?.operation.security, [{ cookieAuth: [] }]);
});

test("memoization preserves the generated contract without reusing its server wrapper", () => {
  const first = buildOpenApiDocument(app);
  const second = buildOpenApiDocument(app);

  assert.notEqual(first, second);
  assert.equal(first.paths, second.paths);
  assert.notEqual(first.servers, second.servers);
});

test("Revenue bulk operations publish typed filters and discriminated action contracts", () => {
  const document = buildOpenApiDocument(app);
  const schema = requestSchema(document, "/api/companies/{cid}/revenue/bulk", "application/json");
  const target = schema.properties?.target;
  const filter = target?.properties?.filter;
  assert.equal(target?.additionalProperties, false);
  assert.equal(filter?.additionalProperties, false);
  for (const field of [
    "ownerId",
    "lifecycleStage",
    "dealStageId",
    "assignedEmployeeId",
    "dueFrom",
    "overdueMinDays",
    "closedDeals",
  ]) {
    assert.ok(filter?.properties?.[field], `bulk filter is missing ${field}`);
  }

  const actions = schema.properties?.action?.oneOf;
  assert.ok(actions);
  const actionByType = new Map(
    actions.map((action) => [String(action.properties?.type?.enum?.[0]), action]),
  );
  assert.deepEqual([...actionByType.keys()].sort(), [
    "archive",
    "assign_owner",
    "move_deal_stage",
    "set_account_status",
    "set_contact_lifecycle",
    "set_custom_fields",
    "update_follow_up",
    "update_standard_fields",
  ]);
  for (const action of actions) assert.equal(action.additionalProperties, false);

  const standardFields = actionByType.get("update_standard_fields");
  assert.ok(standardFields?.required?.includes("confirm"));
  assert.deepEqual(standardFields?.properties?.confirm?.enum, ["UPDATE_STANDARD_FIELDS"]);
  assert.ok(standardFields?.properties?.values?.properties?.amountCents);
  assert.equal(standardFields?.properties?.rows?.type, "array");
  assert.equal(standardFields?.properties?.rows?.items?.additionalProperties, false);
  assert.ok(standardFields?.properties?.rows?.items?.properties?.values?.properties?.notes);

  const followUp = actionByType.get("update_follow_up");
  for (const field of ["taskStatus", "priority", "assignedEmployeeId", "dueAt", "reminderAt"]) {
    assert.ok(followUp?.properties?.[field], `Follow-up action is missing ${field}`);
  }
});

test("Revenue file-import and Finance proposal contracts reflect runtime requirements", () => {
  const document = buildOpenApiDocument(app);
  const importRequired = (action: "inspect" | "preview" | "commit") =>
    requestSchema(
      document,
      `/api/companies/{cid}/revenue/imports/file/${action}`,
      "multipart/form-data",
    ).required;

  assert.deepEqual(importRequired("inspect"), ["file", "format"]);
  assert.deepEqual(importRequired("preview"), ["file", "format", "resourceType", "mapping"]);
  assert.deepEqual(importRequired("commit"), ["file", "format", "resourceType", "mapping"]);

  const finance = operationAt(
    document,
    "/api/companies/{cid}/revenue/enrichment/commercial-values/propose-from-finance",
  );
  assert.match(finance.description ?? "", /full \(write\) Finance access/i);
});

test("Creating a Routine documents the optional brief and the paused start without one", () => {
  const document = buildOpenApiDocument(app);
  const route = "/api/companies/{cid}/employees/{eid}/routines";
  const create = operationAt(document, route);
  const input = requestSchema(document, route, "application/json");

  assert.deepEqual(input.required, ["name", "cronExpr"], "the brief is the one optional piece");
  assert.equal(input.properties?.brief?.type, "string");
  assert.equal(input.properties?.brief?.maxLength, 20_000);
  assert.match(input.properties?.brief?.description ?? "", /starts paused/);
  assert.match(create.description ?? "", /created paused/);
  assert.match(create.description ?? "", /nothing runs before a real brief exists/);
  for (const status of ["200", "400", "403", "404", "409"]) {
    assert.ok(create.responses?.[status], `POST ${route} documents ${status}`);
  }
});

// ── Structure, references and stability of the whole document ─────────────

type AnyOperation = Operation & {
  operationId?: string;
  "x-genosyn-access"?: { apiKey: boolean; browserSession: boolean };
};

function allOperations(document: ReturnType<typeof buildOpenApiDocument>) {
  return operations(document) as Array<{ method: string; operation: AnyOperation; route: string }>;
}

test("the whole document is structurally valid OpenAPI 3.0", () => {
  const document = buildOpenApiDocument(app);
  assert.match(document.openapi, /^3\.0\.\d+$/);
  assert.equal(typeof document.info.title, "string");
  assert.equal(typeof document.info.version, "string");
  const declaredTags = new Set((document.tags ?? []).map((tag) => tag.name));
  const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
  const all = allOperations(document);
  assert.ok(all.length > 1000, `only ${all.length} operations`);

  for (const route of Object.keys(document.paths ?? {})) {
    assert.match(route, /^\/(?:[^/:]+(?:\/[^/:]+)*)?$/, `${route} is not an OpenAPI path`);
    assert.ok(!route.endsWith("/") || route === "/", `${route} ends with a slash`);
  }

  for (const { method, operation, route } of all) {
    const where = `${method.toUpperCase()} ${route}`;
    assert.match(operation.operationId ?? "", /^[a-z][A-Za-z0-9]{1,63}$/, `${where} operationId`);
    assert.ok(operation.summary?.trim(), `${where} has no summary`);
    assert.ok(operation.tags?.length, `${where} has no tag`);
    for (const tag of operation.tags ?? []) {
      assert.ok(declaredTags.has(tag), `${where} uses undeclared tag ${tag}`);
    }

    const responses = Object.entries(operation.responses ?? {});
    assert.ok(responses.length, `${where} has no responses`);
    for (const [status, response] of responses) {
      assert.match(status, /^(?:[1-5]\d\d|default)$/, `${where} response ${status}`);
      const shape = response as { description?: string; $ref?: string };
      assert.ok(
        shape.description !== undefined || shape.$ref,
        `${where} response ${status} has no description`,
      );
    }

    const seenParameters = new Set<string>();
    for (const parameter of operation.parameters ?? []) {
      const key = `${parameter.in}:${parameter.name}`;
      assert.ok(!seenParameters.has(key), `${where} declares ${key} twice`);
      seenParameters.add(key);
      assert.ok(
        ["path", "query", "header", "cookie"].includes(parameter.in ?? ""),
        `${where} ${key}`,
      );
      const described = parameter as { schema?: unknown; content?: unknown };
      assert.ok(described.schema || described.content, `${where} ${key} has no schema`);
    }

    if (method === "get") assert.equal(operation.requestBody, undefined, `${where} has a body`);
    if (operation.requestBody) {
      const content = Object.entries(operation.requestBody.content ?? {});
      assert.ok(content.length, `${where} has an empty body`);
      for (const [type, media] of content)
        assert.ok(media.schema, `${where} ${type} has no schema`);
    }

    for (const requirement of operation.security ?? []) {
      for (const scheme of Object.keys(requirement)) {
        assert.ok(schemes.has(scheme), `${where} names unknown scheme ${scheme}`);
      }
    }
  }
});

test("operation ids are unique across the whole document", () => {
  const seen = new Map<string, string>();
  for (const { method, operation, route } of allOperations(buildOpenApiDocument(app))) {
    const where = `${method.toUpperCase()} ${route}`;
    const id = operation.operationId as string;
    assert.ok(!seen.has(id), `${id} names both ${seen.get(id)} and ${where}`);
    seen.set(id, where);
  }
});

test("every $ref resolves inside the document", () => {
  const document = buildOpenApiDocument(app);
  const refs = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") refs.add(inner);
        else visit(inner);
      }
    }
  };
  visit(document);
  assert.ok(refs.size > 20, `only ${refs.size} references`);
  for (const ref of refs) {
    assert.match(ref, /^#\//, `${ref} is not a local reference`);
    let target: unknown = document;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      target = (target as Record<string, unknown> | undefined)?.[key];
    }
    assert.ok(target !== undefined, `${ref} does not resolve`);
  }
});

test("the document survives a JSON round trip unchanged", () => {
  const document = buildOpenApiDocument(app);
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test("operation ids and paths are identical across independent builds", () => {
  // A second app is a separate cache entry, so this really builds twice.
  const first = buildOpenApiDocument(app);
  const second = buildOpenApiDocument(createApp());
  const ids = (document: typeof first) =>
    allOperations(document).map(
      ({ method, operation, route }) => `${method} ${route} ${operation.operationId}`,
    );
  assert.deepEqual(ids(second), ids(first));
  assert.deepEqual(second.paths, first.paths);
  assert.deepEqual(second.tags, first.tags);
});

test("every declared tag is used once and described", () => {
  const document = buildOpenApiDocument(app);
  const names = (document.tags ?? []).map((tag) => tag.name);
  assert.equal(new Set(names).size, names.length);
  const used = new Set(allOperations(document).flatMap(({ operation }) => operation.tags ?? []));
  for (const tag of document.tags ?? []) {
    assert.ok(used.has(tag.name), `${tag.name} is declared but unused`);
    assert.ok(tag.description, `${tag.name} has no description`);
  }
});

test("API keys are only ever offered below a company", () => {
  for (const { method, operation, route } of allOperations(buildOpenApiDocument(app))) {
    const offersKey = (operation.security ?? []).some((requirement) => "bearerAuth" in requirement);
    if (offersKey) {
      assert.match(route, /^\/api\/companies\/\{cid\}(?:\/|$)/, `${method.toUpperCase()} ${route}`);
    }
    assert.equal(
      operation["x-genosyn-access"]?.apiKey ?? false,
      offersKey,
      `${method.toUpperCase()} ${route} security and x-genosyn-access disagree`,
    );
  }
});

test("browser-only actions are cookieAuth only, and everyday ones take a key", () => {
  const document = buildOpenApiDocument(app);
  const cookieOnly: Array<Record<string, string[]>> = [{ cookieAuth: [] }];
  const both: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { cookieAuth: [] }];
  const cases: Array<[string, string, Array<Record<string, string[]>>]> = [
    // Minting and revoking keys, account security, roles and invitations.
    ["post", "/api/companies/{cid}/api-keys", cookieOnly],
    ["delete", "/api/companies/{cid}/api-keys/{id}", cookieOnly],
    ["post", "/api/auth/password", cookieOnly],
    ["post", "/api/auth/two-factor/totp/setup", cookieOnly],
    ["post", "/api/companies/{cid}/invitations", cookieOnly],
    ["patch", "/api/companies/{cid}/members/{uid}", cookieOnly],
    ["delete", "/api/companies/{cid}", cookieOnly],
    // Human gates and delegated authority.
    ["post", "/api/companies/{cid}/approvals/{id}/approve", cookieOnly],
    ["post", "/api/companies/{cid}/employees/{eid}/conversations/{convId}/messages", cookieOnly],
    // Credential custody.
    ["get", "/api/companies/{cid}/vault/items", cookieOnly],
    ["post", "/api/companies/{cid}/integrations/connections", cookieOnly],
    ["post", "/api/companies/{cid}/employees/{eid}/models", cookieOnly],
    // Instance administration.
    ["get", "/api/admin/users", cookieOnly],
    // Everyday company work.
    ["get", "/api/companies/{cid}/me", both],
    ["get", "/api/companies/{cid}/employee-templates", both],
    ["get", "/api/companies/{cid}/revenue/contacts", both],
    ["post", "/api/companies/{cid}/revenue/contacts", both],
    ["post", "/api/companies/{cid}/employees/{eid}/routines", both],
    ["post", "/api/companies/{cid}/invoices", both],
    ["post", "/api/companies/{cid}/routines/{rid}/run", both],
    ["post", "/api/companies/{cid}/employees/{eid}/mcp/connect", both],
  ];
  for (const [method, route, security] of cases) {
    assert.deepEqual(
      operationAt(document, route, method).security,
      security,
      `${method.toUpperCase()} ${route}`,
    );
  }
});

test("conditional browser gates are spelled out on the operations they touch", () => {
  const document = buildOpenApiDocument(app);
  assert.match(
    operationAt(document, "/api/companies/{cid}/projects/{pSlug}/todos").description ?? "",
    /browser session is required to assign an AI Employee/,
  );
  assert.match(
    operationAt(document, "/api/companies/{cid}/todos/{tid}/comments").description ?? "",
    /browser session is required to mention an AI Employee/,
  );
  assert.match(
    operationAt(document, "/api/companies/{cid}", "patch").description ?? "",
    /browser session is required to change requireTwoFactor/,
  );
});

test("the overview explains keys, scope, browser-only operations and errors", () => {
  const description = buildOpenApiDocument(app).info.description ?? "";
  assert.match(description, /Settings → API keys/);
  assert.match(description, /Authorization: Bearer gen_/);
  assert.match(description, /\/api\/companies\/\{cid\}/);
  assert.match(description, /cookieAuth/);
  assert.match(description, /ValidationError/);
  assert.match(description, /operationId/);
});
