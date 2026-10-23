import assert from "node:assert/strict";
import { describe, test } from "node:test";

import express, { Router, type Request, type Response } from "express";
import multer from "multer";
import { z, type ZodTypeAny } from "zod";

import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { requireFinanceRead } from "../middleware/financeAccess.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { buildApiDocument, inferredQueryParameters, successStatusOf } from "./document.js";

/**
 * How a route the router describes becomes an operation, on a synthetic app
 * whose every route exercises one rule. The App-wide properties — coverage,
 * structure, stability — live in `coverage.test.ts` and `spec.test.ts`.
 */

type Operation = {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: string;
    required: boolean;
    schema: Record<string, unknown>;
    style?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses: Record<string, Record<string, unknown>>;
  "x-genosyn-access": Record<string, unknown>;
};

interface Node {
  label: string;
  children?: Node[];
}
const recursive: z.ZodType<Node> = z.lazy(() =>
  z.object({ label: z.string(), children: z.array(recursive).optional() }),
);

const handler = (_req: Request, res: Response) => {
  res.json({});
};

function syntheticApp() {
  const company = Router({ mergeParams: true });
  company.use(requireAuth);
  company.use(requireCompanyMember);
  company.use(onRoutePaths(["/secret-things"], requireBrowserSession));
  company.use(onRoutePaths(["/managed"], requireCompanyRoleForMutations("admin")));

  company.get(
    "/widgets",
    validateQuery(
      z.object({
        status: z.enum(["open", "closed"]).optional(),
        limit: z.coerce.number().int().max(100).default(20),
        filter: z.object({ owner: z.string() }).optional(),
      }),
    ),
    handler,
  );
  company.post(
    "/widgets",
    validateBody(
      z.object({ name: z.string().min(1).max(80), tags: z.array(z.string()).optional() }),
    ),
    (_req: Request, res: Response) => {
      res.status(201).json({});
    },
  );
  company.get(
    "/widgets/:widgetId",
    validateParams(z.object({ cid: z.string().uuid(), widgetId: z.string().uuid() })),
    handler,
  );
  company.get("/widgets/:widgetId/file", handler);
  company.get("/widgets/:widgetId/pdf", handler);
  company.get("/exports/widgets.csv", handler);
  company.get("/reports", (req: Request, res: Response) => {
    res.json({ from: req.query.from, to: req.query?.to, sort: req.query["sort"] });
  });
  company.post("/trees", validateBody(recursive as unknown as ZodTypeAny), handler);
  company.get("/secret-things", handler);
  company.patch("/managed/:id", validateBody(z.object({ on: z.boolean() })), handler);
  company.get("/ledger", requireFinanceRead, handler);
  company.post("/contracts", multer({ storage: multer.memoryStorage() }).single("file"), handler);

  const app = express();
  app.get("/api/ping", handler);
  app.use("/api/companies/:cid", company);
  app.post("/api/account/thing", requireAuth, handler);
  return app;
}

const { document, report } = buildApiDocument(syntheticApp(), { version: "9.9.9" });
const paths = document.paths as Record<string, Record<string, Operation>>;
const op = (method: string, path: string) => {
  const found = paths[path]?.[method];
  assert.ok(found, `${method.toUpperCase()} ${path} is not documented`);
  return found;
};

describe("a generated operation", () => {
  test("is named from its method and path, and tagged", () => {
    const list = op("get", "/api/companies/{cid}/widgets");
    assert.equal(list.operationId, "listWidgets");
    assert.equal(list.summary, "List widgets");
    // No area rule claims a synthetic router, so it lands in "Other" and the report says so.
    assert.deepEqual(list.tags, ["Other"]);
    assert.ok(report.unplaced.includes("GET /api/companies/{cid}/widgets"));
    assert.equal(op("post", "/api/companies/{cid}/widgets").operationId, "createWidget");
    assert.equal(op("get", "/api/companies/{cid}/widgets/{widgetId}").operationId, "getWidget");
  });

  test("declares every path parameter, typed by validateParams where there is one", () => {
    const get = op("get", "/api/companies/{cid}/widgets/{widgetId}");
    const path = (get.parameters ?? []).filter((parameter) => parameter.in === "path");
    assert.deepEqual(
      path.map((parameter) => parameter.name),
      ["cid", "widgetId"],
    );
    for (const parameter of path) {
      assert.equal(parameter.required, true);
      assert.equal(parameter.schema.format, "uuid");
    }
    const untyped = op("get", "/api/companies/{cid}/widgets/{widgetId}/file");
    assert.deepEqual(
      (untyped.parameters ?? []).map((parameter) => [parameter.name, parameter.schema.type]),
      [
        ["cid", "string"],
        ["widgetId", "string"],
      ],
    );
  });

  test("lists validateQuery fields as query parameters", () => {
    const query = (op("get", "/api/companies/{cid}/widgets").parameters ?? []).filter(
      (parameter) => parameter.in === "query",
    );
    const byName = new Map(query.map((parameter) => [parameter.name, parameter]));
    assert.deepEqual([...byName.keys()], ["status", "limit", "filter"]);
    assert.deepEqual(byName.get("status")?.schema.enum, ["open", "closed"]);
    assert.equal(byName.get("status")?.required, false);
    assert.equal(byName.get("limit")?.schema.default, 20);
    assert.equal(byName.get("limit")?.required, false);
    assert.equal(byName.get("filter")?.style, "deepObject");
  });

  test("lists the query names a handler reads when it has no schema", () => {
    const query = (op("get", "/api/companies/{cid}/reports").parameters ?? []).filter(
      (parameter) => parameter.in === "query",
    );
    assert.deepEqual(
      query.map((parameter) => [parameter.name, parameter.required, parameter.schema.type]),
      [
        ["from", false, "string"],
        ["sort", false, "string"],
        ["to", false, "string"],
      ],
    );
  });

  test("carries the validateBody schema as its JSON request body", () => {
    const body = op("post", "/api/companies/{cid}/widgets").requestBody;
    assert.equal(body?.required, true);
    const schema = body?.content["application/json"].schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    assert.equal(schema.properties.name.maxLength, 80);
    assert.deepEqual(schema.required, ["name"]);
    assert.equal(op("get", "/api/companies/{cid}/widgets").requestBody, undefined);
  });

  test("describes a schema zod-to-openapi refuses with the fallback, and says so", () => {
    const schema = op("post", "/api/companies/{cid}/trees").requestBody?.content["application/json"]
      .schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.equal(schema.properties.label.type, "string");
    assert.equal(schema.properties.children.type, "array");
    assert.deepEqual(report.fallbacks, ["POST /api/companies/{cid}/trees"]);
  });

  test("documents an upload as a multipart form with its file field", () => {
    const body = op("post", "/api/companies/{cid}/contracts").requestBody;
    const schema = body?.content["multipart/form-data"].schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    assert.deepEqual(schema.properties.file, {
      type: "string",
      format: "binary",
      description: "The signed agreement.",
    });
    // The contract's text fields come from the zod schema the handler parses them with.
    assert.equal(schema.properties.title.maxLength, 200);
    assert.deepEqual(schema.required, ["file"]);
    assert.deepEqual(report.uploadsWithoutEntry, []);
  });

  test("answers JSON, or the bytes of a file", () => {
    assert.ok(op("get", "/api/companies/{cid}/widgets").responses[200].content);
    const json = op("get", "/api/companies/{cid}/widgets").responses[200].content as Record<
      string,
      unknown
    >;
    assert.ok(json["application/json"]);
    const file = op("get", "/api/companies/{cid}/widgets/{widgetId}/file").responses[200]
      .content as Record<string, unknown>;
    assert.ok(file["application/octet-stream"]);
    const pdf = op("get", "/api/companies/{cid}/widgets/{widgetId}/pdf").responses[200]
      .content as Record<string, unknown>;
    assert.ok(pdf["application/pdf"]);
    const csv = op("get", "/api/companies/{cid}/exports/widgets.csv").responses[200]
      .content as Record<string, unknown>;
    assert.ok(csv["text/csv"]);
  });

  test("answers 201 where its handler creates, 200 elsewhere", () => {
    const created = op("post", "/api/companies/{cid}/widgets").responses;
    assert.equal(created[201].description, "Created.");
    assert.equal(created[200], undefined);
    assert.equal(op("get", "/api/companies/{cid}/widgets").responses[200].description, "Success.");
  });

  test("lists the errors it can answer with", () => {
    const create = op("post", "/api/companies/{cid}/widgets").responses;
    assert.deepEqual(create[400], { $ref: "#/components/responses/ValidationFailed" });
    assert.deepEqual(create[401], { $ref: "#/components/responses/Unauthorized" });
    assert.deepEqual(create[403], { $ref: "#/components/responses/Forbidden" });
    assert.equal(create[404], undefined);
    assert.deepEqual(op("get", "/api/companies/{cid}/widgets/{widgetId}").responses[404], {
      $ref: "#/components/responses/NotFound",
    });
    const ping = op("get", "/api/ping").responses;
    assert.deepEqual(Object.keys(ping), ["200"]);
  });
});

describe("access in a generated operation", () => {
  test("follows the guards: key or session, session only, public", () => {
    assert.deepEqual(op("get", "/api/companies/{cid}/widgets").security, [
      { bearerAuth: [] },
      { cookieAuth: [] },
    ]);
    assert.deepEqual(op("get", "/api/companies/{cid}/secret-things").security, [
      { cookieAuth: [] },
    ]);
    assert.deepEqual(op("post", "/api/account/thing").security, [{ cookieAuth: [] }]);
    assert.deepEqual(op("get", "/api/ping").security, []);
  });

  test("states roles and Finance access in prose and in the extension", () => {
    const managed = op("patch", "/api/companies/{cid}/managed/{id}");
    assert.match(managed.description, /Needs the admin company role or higher/);
    assert.equal(managed["x-genosyn-access"].minimumRole, "admin");
    const ledger = op("get", "/api/companies/{cid}/ledger");
    assert.match(ledger.description, /Needs Finance read access/);
    assert.equal(ledger["x-genosyn-access"].financeAccess, "read");
    assert.equal(op("get", "/api/companies/{cid}/secret-things")["x-genosyn-access"].apiKey, false);
  });
});

describe("the document around the operations", () => {
  test("names the API, its version and the shared error components", () => {
    assert.equal(document.openapi, "3.0.0");
    assert.equal(document.info.version, "9.9.9");
    const components = document.components as Record<string, Record<string, unknown>>;
    for (const name of ["ValidationFailed", "Unauthorized", "Forbidden", "NotFound"]) {
      assert.ok(components.responses[name], name);
    }
    assert.ok(components.schemas.Error);
    assert.ok(components.schemas.ValidationError);
    assert.ok(components.securitySchemes.bearerAuth);
    assert.ok(components.securitySchemes.cookieAuth);
  });

  test("lists only the tags its operations use", () => {
    assert.deepEqual(
      document.tags?.map((tag) => tag.name),
      ["Other"],
    );
  });

  test("reports the App's hand-written pages as stale against an app without their routes", () => {
    assert.ok(report.staleHandWritten.includes("POST /api/auth/login"));
  });
});

describe("the success status read from a handler", () => {
  test("is 201 when the handler answers 201, 200 otherwise", () => {
    assert.equal(
      successStatusOf([(_req: Request, res: Response) => res.status(201).json({})]),
      201,
    );
    assert.equal(successStatusOf([(_req: Request, res: Response) => res.json({})]), 200);
    assert.equal(successStatusOf(["not a function"]), 200);
  });
});

describe("query names inferred from a handler", () => {
  test("covers dotted, optional-chained and bracketed reads, once each, sorted", () => {
    const names = inferredQueryParameters([
      (req: Request) => [req.query.b, req.query?.a, req.query["c-d"], req.query["e"], req.query.b],
      "not a function",
    ]);
    assert.deepEqual(names, ["a", "b", "c-d", "e"]);
  });

  test("finds nothing in a handler that does not read the query", () => {
    assert.deepEqual(inferredQueryParameters([(req: Request) => req.body]), []);
  });
});
