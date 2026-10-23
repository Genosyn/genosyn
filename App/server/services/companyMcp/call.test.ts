import assert from "node:assert/strict";
import { describe, test } from "node:test";

import multer from "multer";
import express from "express";
import type { RequestListener } from "node:http";

import { createApp } from "../../app.js";
import {
  buildRequest,
  callArguments,
  contentTypeFor,
  decodeFile,
  MAX_FILE_BYTES,
  multipartBody,
  sendRequest,
  unwrapJsonText,
  type BuiltRequest,
  type CallArguments,
} from "./call.js";
import { operationCatalogue } from "./appCatalogue.js";
import { buildOperationCatalogue, type CatalogueOperation } from "./catalogue.js";

/**
 * Turning a tool call into the HTTP request it stands for. Everything
 * structural is settled here, before any request; these pin each rule, and
 * that the request built is the one an HTTP client would have sent.
 */

const catalogue = operationCatalogue(createApp());
const COMPANY = "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f";
const context = {
  companyId: COMPANY,
  companyName: "Acme",
  authorization: "Bearer gen_test",
  forwardedHeaders: {
    host: "genosyn.example.test",
    "user-agent": "claude-code/2.0",
    "x-forwarded-for": "203.0.113.9",
  },
};

function operation(name: string): CatalogueOperation {
  const found = catalogue.byName.get(name);
  assert.ok(found, name);
  return found;
}

function built(name: string, args: Partial<CallArguments> = {}): BuiltRequest {
  const result = buildRequest(operation(name), { operationId: name, ...args }, context);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.request;
}

function refused(name: string, args: Partial<CallArguments>): string {
  const result = buildRequest(operation(name), { operationId: name, ...args }, context);
  assert.equal(result.ok, false, `${name} ${JSON.stringify(args)} was not refused`);
  return (result as { message: string }).message;
}

describe("the request a call stands for", () => {
  test("method, path and the caller's headers — the same key, never a cookie", () => {
    const request = built("listTags");
    assert.equal(request.method, "GET");
    assert.equal(request.target, `/api/companies/${COMPANY}/tags`);
    assert.equal(request.path, request.target);
    assert.deepEqual(request.headers, {
      host: "genosyn.example.test",
      "user-agent": "claude-code/2.0",
      "x-forwarded-for": "203.0.113.9",
      authorization: "Bearer gen_test",
      accept: "application/json, */*;q=0.8",
    });
    assert.equal(request.body, undefined);
  });

  test("path parameters are filled in and encoded; cid is always the company", () => {
    const request = built("updateTag", { path: { tagId: "a b/c?d" }, body: { name: "x" } });
    assert.equal(request.path, `/api/companies/${COMPANY}/tags/a%20b%2Fc%3Fd`);
    assert.equal(
      built("getRevenueContact", { path: { id: 42 } }).path,
      `/api/companies/${COMPANY}/revenue/contacts/42`,
    );
    assert.equal(
      built("getRevenueContact", { path: { id: "  padded  " } }).path,
      `/api/companies/${COMPANY}/revenue/contacts/padded`,
    );
    assert.equal(
      built("listTags", { path: { cid: COMPANY } }).path,
      `/api/companies/${COMPANY}/tags`,
    );
  });

  test("query values: scalars as text, arrays repeat, objects as name[key]", () => {
    const request = built("listRevenueContacts", {
      query: {
        q: "ada lovelace",
        limit: 10,
        includeArchived: true,
        tags: ["a", "b"],
        filter: { stage: "lead", score: { min: 5 } },
        skipped: null,
        missing: undefined,
      },
    });
    const url = new URL(`http://x${request.target}`);
    assert.equal(url.searchParams.get("q"), "ada lovelace");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("includeArchived"), "true");
    assert.deepEqual(url.searchParams.getAll("tags"), ["a", "b"]);
    assert.equal(url.searchParams.get("filter[stage]"), "lead");
    assert.equal(url.searchParams.get("filter[score][min]"), "5");
    assert.equal(url.searchParams.has("skipped"), false);
    assert.equal(request.path, `/api/companies/${COMPANY}/revenue/contacts`);
  });

  test("a JSON body is sent as JSON; a required one left out is sent empty for the route to judge", () => {
    const request = built("createTag", { body: { name: "Hot", color: "red" } });
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body!.toString()), { name: "Hot", color: "red" });
    const empty = built("createTag");
    assert.deepEqual(JSON.parse(empty.body!.toString()), {});
    const array = built("bulkDecisions", { body: { action: "dismiss", ids: [] } });
    assert.ok(array.body);
  });

  test("a form carries its fields and the file, under the form's own field name", () => {
    const request = built("createRecruitingOpeningApplication", {
      path: { openingId: "6f1c2b9e-5d4a-4b8c-9e7f-0a1b2c3d4e5f" },
      body: { name: "Ada", email: "ada@example.com", answers: { why: "Engines" } },
      file: { name: "ada.pdf", base64: Buffer.from("%PDF").toString("base64") },
    });
    const type = request.headers["content-type"];
    assert.match(type, /^multipart\/form-data; boundary=----GenosynMcp[0-9a-f]{32}$/);
    const text = request.body!.toString("latin1");
    assert.match(text, /name="name"\r\n\r\nAda\r\n/);
    assert.match(
      text,
      /name="answers"\r\n\r\n\{"why":"Engines"\}\r\n/,
      "objects travel as JSON text",
    );
    assert.match(
      text,
      /name="resume"; filename="ada.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF\r\n/,
    );
    assert.ok(text.trimEnd().endsWith("--"), "the form is closed");
  });
});

describe("structural mistakes, refused before anything is sent", () => {
  test("path parameters: missing, unknown, empty, or a dot segment", () => {
    assert.match(refused("updateTag", { body: {} }), /needs the path parameter "tagId"/);
    assert.match(
      refused("updateTag", { path: { tagId: "  " }, body: {} }),
      /needs the path parameter "tagId"/,
    );
    assert.match(
      refused("updateTag", { path: { tagId: "x", id: "y" }, body: {} }),
      /no path parameter "id"\. Its path parameters are "tagId"/,
    );
    assert.match(
      refused("listTags", { path: { id: "y" } }),
      /takes no path parameters; "id" is not one\. Query-string values go in query/,
    );
    assert.match(refused("updateTag", { path: { tagId: "." }, body: {} }), /cannot be "\."/);
    assert.match(refused("updateTag", { path: { tagId: ".." }, body: {} }), /cannot be "\.\."/);
  });

  test("another company is never reachable", () => {
    assert.match(
      refused("listTags", { path: { cid: "00000000-0000-4000-8000-000000000000" } }),
      /acts for Acme \(3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f\) only/,
    );
  });

  test("bodies and files where the operation takes none", () => {
    assert.match(refused("listTags", { body: { x: 1 } }), /takes no request body/);
    assert.match(
      refused("getRevenueContact", { path: { id: "x" }, body: { x: 1 } }),
      /Its inputs go in path and query/,
    );
    assert.match(refused("listTags", { file: { name: "a.txt", text: "x" } }), /takes no file/);
    assert.match(
      refused("createTag", { body: { name: "x" }, file: { name: "a.txt", text: "x" } }),
      /takes a JSON body, not a file/,
    );
    // An empty object is no body at all.
    assert.ok(
      buildRequest(operation("listTags"), { operationId: "listTags", body: {} }, context).ok,
    );
  });

  test("a form needs its file, an object of fields, and a file it can read", () => {
    assert.match(
      refused("createContract", {}),
      /createContract needs a file: The signed agreement\./,
    );
    assert.match(
      refused("createContract", {
        body: ["x"] as unknown as Record<string, unknown>,
        file: { name: "a.txt", text: "x" },
      }),
      /body must be an object/,
    );
    assert.match(refused("createContract", { file: { name: "a.txt" } }), /exactly one of base64/);
    assert.match(
      refused("createContract", { file: { name: "a.txt", base64: "%%%" } }),
      /not valid base64/,
    );
    assert.match(
      refused("createContract", { file: { name: "a.txt", text: "x", contentType: "not a type" } }),
      /is not a MIME type/,
    );
    // A form whose file is optional goes without one.
    const optional = built("createRecruitingOpeningApplication", {
      path: { openingId: "6f1c2b9e-5d4a-4b8c-9e7f-0a1b2c3d4e5f" },
      body: { name: "Ada" },
    });
    assert.doesNotMatch(optional.body!.toString(), /filename=/);
  });

  test("a required query parameter left out", () => {
    const synthetic = buildOperationCatalogue({
      paths: {
        "/api/companies/{cid}/search": {
          get: {
            operationId: "searchThings",
            summary: "Search things",
            tags: ["Things"],
            parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
            "x-genosyn-access": { apiKey: true, browserSession: true },
          },
        },
      },
    }).byName.get("searchThings")!;
    const result = buildRequest(synthetic, { operationId: "searchThings" }, context);
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /needs the query parameter "q"/);
    assert.ok(
      buildRequest(synthetic, { operationId: "searchThings", query: { q: "x" } }, context).ok,
    );
  });

  test("a body the server cannot send is explained", () => {
    const raw = buildOperationCatalogue({
      paths: {
        "/api/companies/{cid}/raw": {
          post: {
            operationId: "uploadRaw",
            summary: "Upload raw",
            tags: ["Things"],
            requestBody: { content: { "application/zip": { schema: {} } } },
            "x-genosyn-access": { apiKey: true, browserSession: true },
          },
        },
      },
    }).byName.get("uploadRaw")!;
    const result = buildRequest(raw, { operationId: "uploadRaw" }, context);
    assert.match(
      (result as { message: string }).message,
      /application\/zip body, which this server cannot send/,
    );
  });
});

describe("a body sent as JSON text", () => {
  test("is unwrapped when it is a JSON object or array, and left alone otherwise", () => {
    assert.deepEqual(unwrapJsonText('{"name":"Hot"}'), { name: "Hot" });
    assert.deepEqual(unwrapJsonText("  [1, 2] "), [1, 2]);
    assert.equal(unwrapJsonText("Hot"), "Hot");
    assert.equal(unwrapJsonText('"quoted"'), '"quoted"');
    assert.equal(unwrapJsonText("{not json"), "{not json");
    assert.equal(unwrapJsonText("null"), "null");
    const object = { name: "x" };
    assert.equal(unwrapJsonText(object), object);
    assert.equal(unwrapJsonText(undefined), undefined);
    // Past the App's 1 MB body limit the text is left for the route to refuse.
    const huge = `[${"0,".repeat(600_000)}0]`;
    assert.equal(unwrapJsonText(huge), huge);
  });

  test("reaches the route as the JSON it spells", () => {
    const request = built("createTag", { body: '{"name":"From text"}' });
    assert.deepEqual(JSON.parse(request.body!.toString()), { name: "From text" });
    const form = built("createContract", {
      body: '{"title":"MSA"}',
      file: { name: "a.txt", text: "x" },
    });
    assert.match(form.body!.toString(), /name="title"\r\n\r\nMSA\r\n/);
  });
});

describe("files", () => {
  test("a stated type may carry parameters, but nothing that could end its header", () => {
    for (const contentType of [
      "text/csv; charset=utf-8",
      'text/plain;charset="utf-8"',
      "application/pdf",
    ]) {
      const decoded = decodeFile({ name: "a.csv", text: "x", contentType });
      assert.ok(decoded.ok, contentType);
      assert.equal(decoded.contentType, contentType);
    }
    for (const contentType of [
      "text/csv\r\nX-Evil: 1",
      "text/csv; charset",
      "pdf",
      'text/plain; a="b\r\nc"',
    ]) {
      assert.equal(decodeFile({ name: "a.csv", text: "x", contentType }).ok, false, contentType);
    }
  });

  test("URL-safe base64 decodes too", () => {
    const bytes = Buffer.from([251, 255, 254, 62, 63]);
    const decoded = decodeFile({ name: "a.bin", base64: bytes.toString("base64url") });
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.data, bytes);
  });

  test("base64 and text decode to their bytes; whitespace in base64 is fine", () => {
    const bytes = Buffer.from([0, 255, 1, 254]);
    const encoded = bytes.toString("base64").replace(/(.{2})/g, "$1\n");
    const fromBase64 = decodeFile({ name: "a.bin", base64: encoded });
    assert.ok(fromBase64.ok);
    assert.deepEqual(fromBase64.data, bytes);
    assert.equal(fromBase64.contentType, "application/octet-stream");
    const fromText = decodeFile({ name: "notes.md", text: "# Héllo" });
    assert.ok(fromText.ok);
    assert.equal(fromText.data.toString("utf8"), "# Héllo");
    assert.equal(fromText.contentType, "text/markdown");
  });

  test("a stated type wins over the guess; a file name cannot break its header", () => {
    const decoded = decodeFile({
      name: 'evil"\r\nX-Injected: 1.pdf',
      text: "x",
      contentType: "application/pdf",
    });
    assert.ok(decoded.ok);
    assert.equal(decoded.contentType, "application/pdf");
    assert.doesNotMatch(decoded.name, /["\r\n]/);
    const form = multipartBody({}, { field: "file", ...decoded });
    assert.doesNotMatch(form.body.toString(), /\r\nX-Injected: 1/);
  });

  test("files over the limit are refused with what to do instead", () => {
    const decoded = decodeFile({ name: "big.bin", text: "x".repeat(MAX_FILE_BYTES + 1) });
    assert.equal(decoded.ok, false);
    assert.match((decoded as { message: string }).message, /Upload larger files in the app/);
  });

  test("types are guessed from common extensions", () => {
    assert.equal(contentTypeFor("Report.PDF"), "application/pdf");
    assert.equal(contentTypeFor("leads.csv"), "text/csv");
    assert.equal(contentTypeFor("photo.jpeg"), "image/jpeg");
    assert.equal(
      contentTypeFor("deck.pptx"),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
    assert.equal(contentTypeFor("weird.xyz"), "application/octet-stream");
  });

  test("a built form parses back exactly, field for field and byte for byte", async () => {
    const app = express();
    app.post("/f", multer({ storage: multer.memoryStorage() }).single("doc"), (req, res) => {
      res.json({
        body: req.body,
        file: req.file?.buffer.toString("base64"),
        name: req.file?.originalname,
      });
    });
    const bytes = Buffer.from([1, 2, 3, 0, 13, 10, 45, 45]);
    const form = multipartBody(
      { title: "Q3", count: 3, flag: false, tags: ["a", "b"], skipped: null },
      { field: "doc", name: "q3.bin", contentType: "application/octet-stream", data: bytes },
    );
    const sent = await sendRequest(
      { app: app as unknown as RequestListener, remote: {} },
      {
        method: "POST",
        target: "/f",
        path: "/f",
        headers: { host: "x", "content-type": form.contentType },
        body: form.body,
      },
    );
    assert.ok(sent.ok);
    assert.deepEqual(JSON.parse(sent.response.body.toString()), {
      body: { title: "Q3", count: "3", flag: "false", tags: '["a","b"]' },
      file: bytes.toString("base64"),
      name: "q3.bin",
    });
  });
});

describe("the arguments schema", () => {
  test("takes an operation id and the four parts, and nothing else", () => {
    assert.ok(callArguments.safeParse({ operationId: "listTags" }).success);
    assert.ok(
      callArguments.safeParse({
        operationId: "x",
        path: { id: "1", n: 2, b: true },
        query: { anything: { nested: [1] } },
        body: [1, 2],
        file: { name: "a.txt", text: "x" },
      }).success,
    );
    assert.equal(callArguments.safeParse({}).success, false);
    assert.equal(callArguments.safeParse({ operationId: "" }).success, false);
    assert.equal(
      callArguments.safeParse({ operationId: "x", path: { id: { nested: 1 } } }).success,
      false,
    );
    assert.equal(callArguments.safeParse({ operationId: "x", other: 1 }).success, false);
    assert.equal(
      callArguments.safeParse({ operationId: "x", file: { name: "a", bytes: "x" } }).success,
      false,
    );
  });
});

describe("sending", () => {
  test("a failure before any answer comes back as an error, not a throw", async () => {
    const app = express();
    app.get("/never", () => undefined);
    const controller = new AbortController();
    controller.abort();
    const sent = await sendRequest(
      { app: app as unknown as RequestListener, remote: {} },
      { method: "GET", target: "/never", path: "/never", headers: { host: "x" } },
      controller.signal,
    );
    assert.equal(sent.ok, false);
    assert.equal((sent as { error: { code: string } }).error.code, "aborted");
  });
});
