import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { indefiniteArticle } from "../../shared/indefiniteArticle.js";
import { buildOpenApiDocument } from "./spec.js";

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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
  const employee = document.components?.schemas?.Employee as SchemaShape | undefined;
  assert.ok(employee?.properties, "the Employee schema is published");
  assert.ok(employee.properties.teamId, "the Team stays");
  assert.equal(employee.properties.reportsToEmployeeId, undefined);
  assert.equal(employee.properties.reportsToUserId, undefined);
});

test("no operation or schema still describes reporting lines", () => {
  // Browser-recording access used to extend to the Member an AI Employee
  // reported to; it is owners and admins (or a Member browser's own owner).
  const text = JSON.stringify(buildOpenApiDocument());
  assert.doesNotMatch(text, /reportsTo|reporting line|reporting-line|employee reports to/i);
  const collection = operationAt(
    buildOpenApiDocument(),
    "/api/companies/{cid}/runs/{runId}/browser-recordings",
    "get",
  );
  assert.match(collection.description ?? "", /requires an owner or admin role/);
});

test("Routine browser recordings document cookie-only metadata and range streaming", () => {
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
  const registered = operations(document);
  const publicRoutes = new Set([
    "POST /api/auth/forgot-password",
    "POST /api/auth/login",
    "POST /api/auth/login/passkey/options",
    "POST /api/auth/login/passkey/verify",
    "POST /api/auth/reset-password",
    "POST /api/auth/signup",
    "POST /api/auth/verify-email",
  ]);

  for (const { method, operation, route } of registered) {
    const key = `${method.toUpperCase()} ${route}`;
    if (publicRoutes.has(key)) {
      assert.deepEqual(operation.security, [], `${key} must be public`);
    }
  }

  const logout = registered.find(
    ({ method, route }) => method === "post" && route === "/api/auth/logout",
  );
  assert.deepEqual(logout?.operation.security, [{ bearerAuth: [] }, { cookieAuth: [] }]);
});

test("memoization preserves the generated contract without reusing its server wrapper", () => {
  const first = buildOpenApiDocument();
  const second = buildOpenApiDocument();

  assert.notEqual(first, second);
  assert.equal(first.paths, second.paths);
  assert.notEqual(first.servers, second.servers);
});

test("Revenue bulk operations publish typed filters and discriminated action contracts", () => {
  const document = buildOpenApiDocument();
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
  const document = buildOpenApiDocument();
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
