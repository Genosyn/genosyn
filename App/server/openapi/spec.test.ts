import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./spec.js";

type Operation = {
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
  items?: SchemaShape;
  oneOf?: SchemaShape[];
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
