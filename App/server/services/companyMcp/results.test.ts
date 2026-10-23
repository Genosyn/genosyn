import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createApp } from "../../app.js";
import type { BuiltRequest, SentRequest } from "./call.js";
import { operationCatalogue, type CatalogueOperation } from "./catalogue.js";
import { InProcessRequestError } from "./dispatch.js";
import {
  callMistake,
  explainStatus,
  fileNameOf,
  formatIssues,
  MAX_EMBEDDED_FILE_BYTES,
  MAX_TEXT_CHARS,
  resultFor,
} from "./results.js";

/**
 * What a call tool hands back, for every kind of answer: JSON, text, files,
 * nothing at all, and each failure status with its explanation.
 */

const catalogue = operationCatalogue(createApp());
const listTags = catalogue.byName.get("listTags") as CatalogueOperation;
const createGoal = catalogue.byName.get("createGoal") as CatalogueOperation;
const listInvoices = catalogue.byName.get("listInvoices") as CatalogueOperation;
const createInvoice = catalogue.byName.get("createInvoice") as CatalogueOperation;
const createProjectTodo = catalogue.byName.get("createProjectTodo") as CatalogueOperation;

const request: BuiltRequest = {
  method: "GET",
  target: "/api/companies/c1/tags?limit=5",
  path: "/api/companies/c1/tags",
  headers: {},
};

const member = {
  baseUrl: "https://genosyn.example.com",
  companyName: "Acme",
  member: { id: "u1", name: "Pat Doe", email: "pat@example.com" },
  standing: { role: "member" as const, financeAccess: "none" as const },
};
const owner = { ...member, standing: { role: "owner" as const, financeAccess: "full" as const } };

function answered(
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
  truncated = false,
): SentRequest {
  return {
    ok: true,
    request,
    response: {
      status,
      headers,
      body: typeof body === "string" ? Buffer.from(body) : body,
      truncated,
    },
  };
}

function text(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("success", () => {
  test("JSON comes back parsed, and as text headed by the request it answered", () => {
    const result = resultFor(
      listTags,
      answered(200, JSON.stringify([{ id: "t1", name: "Hot" }]), {
        "content-type": "application/json; charset=utf-8",
      }),
      owner,
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      operationId: "listTags",
      method: "GET",
      path: "/api/companies/c1/tags",
      status: 200,
      ok: true,
      contentType: "application/json; charset=utf-8",
      data: [{ id: "t1", name: "Hot" }],
    });
    assert.equal(
      text(result),
      `GET /api/companies/c1/tags → 200 OK (listTags)\n${JSON.stringify([{ id: "t1", name: "Hot" }], null, 2)}`,
    );
  });

  test("an empty answer says so", () => {
    const result = resultFor(listTags, answered(204, ""), owner);
    assert.equal(result.structuredContent?.data, null);
    assert.match(text(result), /→ 204 No Content \(listTags\)\nNo content\./);
  });

  test("JSON too long to return whole is cut, with how to ask for less", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({ id: index, name: "x".repeat(30) }));
    const result = resultFor(
      listTags,
      answered(200, JSON.stringify(rows), { "content-type": "application/json" }),
      owner,
    );
    assert.equal(result.structuredContent?.truncated, true);
    assert.equal(result.structuredContent?.data, undefined);
    assert.ok(text(result).length < MAX_TEXT_CHARS + 1_000);
    assert.match(text(result), /too long to return whole\. Ask for less/);
  });

  test("JSON that fits when compact is returned compact rather than cut", () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ id: index, label: "abcdefghij" }));
    const pretty = JSON.stringify(rows, null, 2).length;
    const compact = JSON.stringify(rows).length;
    assert.ok(pretty > MAX_TEXT_CHARS && compact < MAX_TEXT_CHARS, `${pretty} / ${compact}`);
    const result = resultFor(
      listTags,
      answered(200, JSON.stringify(rows), { "content-type": "application/json" }),
      owner,
    );
    assert.equal((result.structuredContent?.data as unknown[]).length, 2_500);
    assert.ok(text(result).includes(JSON.stringify(rows)));
  });

  test("text comes back as text; a stream cut short says it was", () => {
    const csv = resultFor(
      listTags,
      answered(200, "id,name\n1,Ada\n", { "content-type": "text/csv" }),
      owner,
    );
    assert.equal(csv.structuredContent?.data, "id,name\n1,Ada\n");
    assert.match(text(csv), /1,Ada/);
    const cut = resultFor(
      listTags,
      answered(200, "event: chunk\n", { "content-type": "text/event-stream" }, true),
      owner,
    );
    assert.equal(cut.structuredContent?.truncated, true);
    assert.match(text(cut), /event: chunk/);
  });

  test("a document comes back embedded as a resource, named and linked", () => {
    const pdf = Buffer.from("%PDF-1.4 tiny");
    const result = resultFor(
      listTags,
      answered(200, pdf, {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="invoice-0001.pdf"',
      }),
      owner,
    );
    assert.deepEqual(result.structuredContent?.file, {
      contentType: "application/pdf",
      bytes: pdf.length,
      url: "https://genosyn.example.com/api/companies/c1/tags",
      name: "invoice-0001.pdf",
      embedded: true,
    });
    const resource = result.content[1] as {
      type: string;
      resource: { uri: string; mimeType: string; blob: string };
    };
    assert.equal(resource.type, "resource");
    assert.equal(resource.resource.uri, "https://genosyn.example.com/api/companies/c1/tags");
    assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), pdf);
    assert.match(text(result), /An application\/pdf file named invoice-0001\.pdf, \d+ bytes\./);
  });

  test("an image comes back as an image", () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const result = resultFor(listTags, answered(200, png, { "content-type": "image/png" }), owner);
    const image = result.content[1] as { type: string; data: string; mimeType: string };
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), png);
  });

  test("a file too large to embed is described, with where to download it", () => {
    const big = Buffer.alloc(MAX_EMBEDDED_FILE_BYTES + 1);
    const result = resultFor(
      listTags,
      answered(200, big, { "content-type": "application/zip" }),
      owner,
    );
    assert.equal(result.content.length, 1);
    assert.equal((result.structuredContent?.file as { embedded: boolean }).embedded, false);
    assert.match(
      text(result),
      /too large to return here; download it from https:\/\/genosyn\.example\.com\/api\/companies\/c1\/tags with the same API key/,
    );
  });
});

describe("failure", () => {
  test("a validation failure lists the issues by field and points at the schema", () => {
    const result = resultFor(
      createGoal,
      answered(
        400,
        JSON.stringify({
          error: "ValidationError",
          issues: [
            { path: ["title"], message: "Required" },
            { path: ["targetValue"], message: "Expected number, received string" },
          ],
        }),
      ),
      owner,
    );
    assert.equal(result.isError, true);
    const structured = result.structuredContent as {
      status: number;
      ok: boolean;
      error: { message: string; explanation: string; issues: unknown[] };
    };
    assert.equal(structured.status, 400);
    assert.equal(structured.ok, false);
    assert.equal(structured.error.issues.length, 2);
    const shown = text(result);
    assert.match(
      shown,
      /→ 400 Bad Request \(createGoal\)\nValidationError\n- body\.title: Required\n- body\.targetValue: Expected number/,
    );
    assert.match(shown, /describe_operation shows its schema/);
  });

  test("403 names the Member's standing against what the operation needs", () => {
    const role = resultFor(
      createGoal,
      answered(403, JSON.stringify({ error: "admin company role required" })),
      member,
    );
    assert.match(text(role), /admin company role required/);
    assert.match(text(role), /The key acts as Pat Doe, a member of Acme with no Finance access/);
    assert.match(
      text(role),
      /Needs the admin company role or higher; the key's Member is a member\./,
    );
    assert.match(text(role), /Ask an owner or admin for the access/);

    const finance = resultFor(
      listInvoices,
      answered(403, JSON.stringify({ error: "nope" })),
      member,
    );
    assert.match(
      text(finance),
      /Needs Finance read access; the key's Member has no Finance access\./,
    );
    const readOnly = resultFor(
      createInvoice,
      answered(403, JSON.stringify({ error: "You have read-only finance access." })),
      { ...member, standing: { role: "member", financeAccess: "read" } },
    );
    assert.match(text(readOnly), /with read-only Finance access/);
    assert.match(
      text(readOnly),
      /Needs full Finance access; the key's Member has read-only Finance access\./,
    );
  });

  test("403 for a browser-only use says to do it in the app", () => {
    const result = resultFor(
      createProjectTodo,
      answered(403, JSON.stringify({ error: "This action requires a logged-in browser session" })),
      owner,
    );
    assert.match(text(result), /needs a person at a signed-in browser.*Do it in the Genosyn app/);
  });

  test("each status gets an explanation of its own", () => {
    const cases: Array<[number, RegExp]> = [
      [401, /revoked, or have expired/],
      [404, /each must belong to Acme/],
      [405, /does not take that method/],
      [409, /changed since it was read, or it already exists/],
      [413, /too large for Genosyn to accept/],
      [415, /body's format/],
      [422, /cannot do it in the record's current state/],
      [429, /Wait a little/],
      [500, /a server error, not a problem with the arguments/],
      [503, /a server error/],
      [418, /Genosyn answered 418 I'm a Teapot\./],
    ];
    for (const [status, expected] of cases) {
      assert.match(explainStatus(status, "x", listTags, owner), expected, String(status));
      const result = resultFor(listTags, answered(status, JSON.stringify({ error: "msg" })), owner);
      assert.equal(result.isError, true, String(status));
      assert.equal(result.structuredContent?.status, status);
    }
  });

  test("a failure with no JSON body still says what happened", () => {
    const html = resultFor(listTags, answered(502, "<html>Bad gateway</html>"), owner);
    assert.match(text(html), /<html>Bad gateway<\/html>/);
    const empty = resultFor(listTags, answered(404, ""), owner);
    assert.equal((empty.structuredContent?.error as { message: string }).message, "Not Found");
  });

  test("no answer at all: a timeout, a cancellation, a broken connection", () => {
    const failed = (code: "timeout" | "aborted" | "failed", message: string): SentRequest => ({
      ok: false,
      request,
      error: new InProcessRequestError(message, code),
    });
    const timeout = resultFor(
      listTags,
      failed("timeout", "Genosyn did not answer within 120 seconds"),
      owner,
    );
    assert.equal(timeout.isError, true);
    assert.equal(timeout.structuredContent, undefined);
    assert.match(
      text(timeout),
      /did not answer within 120 seconds\. It may still finish; read the record before calling it again/,
    );
    assert.match(
      text(resultFor(listTags, failed("aborted", "x"), owner)),
      /was cancelled before Genosyn answered/,
    );
    assert.match(
      text(resultFor(listTags, failed("failed", "socket hang up"), owner)),
      /failed before Genosyn answered: socket hang up/,
    );
  });

  test("a mistake in the call itself is a plain tool error", () => {
    assert.deepEqual(callMistake("No such thing."), {
      isError: true,
      content: [{ type: "text", text: "No such thing." }],
    });
  });
});

describe("helpers", () => {
  test("issues name their field under the part of the request they came from", () => {
    assert.deepEqual(
      formatIssues([{ path: ["a", 0, "b"], message: "Bad" }, { message: "Whole" }, null], "body"),
      ["- body.a.0.b: Bad", "- body: Whole", "- body: is invalid"],
    );
    assert.deepEqual(formatIssues("not issues", "body"), []);
    assert.equal(
      formatIssues(
        Array.from({ length: 50 }, () => ({ message: "x" })),
        "q",
      ).length,
      20,
    );
  });

  test("file names come from either form of Content-Disposition", () => {
    assert.equal(fileNameOf('attachment; filename="report.pdf"'), "report.pdf");
    assert.equal(fileNameOf("attachment; filename=report.pdf"), "report.pdf");
    assert.equal(fileNameOf("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), "résumé.pdf");
    assert.equal(fileNameOf("inline"), null);
    assert.equal(fileNameOf(""), null);
  });
});
