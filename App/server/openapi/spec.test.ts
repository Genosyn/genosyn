import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./spec.js";

type Operation = {
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
  }>;
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
};

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

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

test("OpenAPI document exposes a versioned and authenticated scripting contract", () => {
  const document = buildOpenApiDocument();
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const version = fs.readFileSync(path.resolve(currentDir, "../../../VERSION"), "utf8").trim();

  assert.equal(document.openapi, "3.0.0");
  assert.equal(document.info.title, "Genosyn API");
  assert.equal(document.info.version, version);
  assert.equal(document.servers?.[0]?.description, "This Genosyn instance");
  assert.match(document.servers?.[0]?.url ?? "", /^https?:\/\//);
  assert.deepEqual(
    Object.keys(document.components?.securitySchemes ?? {}).sort(),
    ["bearerAuth", "cookieAuth"],
  );
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
