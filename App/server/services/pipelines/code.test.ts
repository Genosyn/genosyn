import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { Base } from "../../db/entities/Base.js";
import { BaseField } from "../../db/entities/BaseField.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseRecordComment } from "../../db/entities/BaseRecordComment.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun } from "../../db/entities/PipelineRun.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import { fireManually } from "./index.js";
import { HANDLERS } from "./handlers.js";
import { NodeOutputs, PipelineNode } from "./types.js";

/**
 * Covers the `logic.code` node: the vm runtime (outputs, timeouts, sandbox
 * hardening), the `genosyn.base` record SDK, and the axios-style HTTP client.
 */

let cid: string;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  cid = testCompanyId();
});
after(closeTestDb);

async function runCode(
  code: string,
  opts: {
    payload?: unknown;
    steps?: Record<string, NodeOutputs>;
    timeoutSeconds?: number;
  } = {},
): Promise<{ outputs: NodeOutputs; lines: string[] }> {
  const handler = HANDLERS["logic.code"];
  assert.ok(handler, "logic.code handler is registered");
  const lines: string[] = [];
  const node: PipelineNode = {
    id: "n_code",
    type: "logic.code",
    x: 0,
    y: 0,
    config: { code, timeoutSeconds: opts.timeoutSeconds ?? 5 },
  };
  const result = await handler({
    companyId: cid,
    pipelineId: testId("pl"),
    pipelineName: "Test pipeline",
    runId: testId("run"),
    env: {
      trigger: { kind: "manual", payload: opts.payload ?? {} },
      nodeOutputs: opts.steps ?? {},
    },
    log: (line) => lines.push(line),
    config: { timeoutSeconds: opts.timeoutSeconds ?? 5 },
    node,
  });
  return { outputs: result.outputs, lines };
}

describe("logic.code runtime", () => {
  test("an object return becomes the step outputs", async () => {
    const { outputs } = await runCode('return { greeting: "hi", n: 2 };');
    assert.deepEqual(outputs, { greeting: "hi", n: 2 });
  });

  test("a scalar return is wrapped as result", async () => {
    const { outputs } = await runCode("return 21 * 2;");
    assert.deepEqual(outputs, { result: 42 });
  });

  test("no return produces empty outputs", async () => {
    const { outputs } = await runCode("const unused = 1;");
    assert.deepEqual(outputs, {});
  });

  test("input, trigger, and steps are visible to the code", async () => {
    const { outputs } = await runCode(
      "return { name: input.name, kind: trigger.kind, upstream: steps.n_prev.value };",
      {
        payload: { name: "Ada" },
        steps: { n_prev: { value: 7 } },
      },
    );
    assert.deepEqual(outputs, { name: "Ada", kind: "manual", upstream: 7 });
  });

  test("console output lands in the run log", async () => {
    const { lines } = await runCode('console.log("hello", { a: 1 }); console.warn("careful");');
    assert.ok(lines.some((line) => line.includes("hello") && line.includes('{"a":1}')));
    assert.ok(lines.some((line) => line.includes("[warn] careful")));
  });

  test("a synchronous busy loop hits the timeout", async () => {
    await assert.rejects(
      () => runCode("for (;;) {}", { timeoutSeconds: 1 }),
      /timed out after 1s/,
    );
  });

  test("sleeping past the deadline hits the timeout", async () => {
    await assert.rejects(
      () => runCode("await sleep(5000); return 1;", { timeoutSeconds: 1 }),
      /timed out after 1s/,
    );
  });

  test("a busy loop after an await is terminated, not left hanging", async () => {
    // No in-process timer can preempt this — only the worker terminate() can.
    await assert.rejects(
      () => runCode("await sleep(10); for (;;) {}", { timeoutSeconds: 1 }),
      /timed out after 1s/,
    );
  });

  test("a sleep within budget works", async () => {
    const { outputs } = await runCode('await sleep(25); return "rested";');
    assert.deepEqual(outputs, { result: "rested" });
  });

  test("eval is disabled inside the sandbox", async () => {
    await assert.rejects(() => runCode('return eval("1 + 1");'), /Code generation/i);
  });

  test("syntax errors are reported as such", async () => {
    await assert.rejects(() => runCode("return {"), /Syntax error/);
  });

  test("an oversized return value is rejected", async () => {
    await assert.rejects(
      () => runCode('return "x".repeat(300 * 1024);'),
      /too large/,
    );
  });

  test("a cyclic return value is rejected", async () => {
    await assert.rejects(
      () => runCode("const a = {}; a.self = a; return a;"),
      /JSON-serializable/,
    );
  });
});

describe("logic.code through the executor", () => {
  test("runs verbatim source — template tokens are not rewritten", async () => {
    const pipeline = await insert(Pipeline, {
      companyId: cid,
      name: "Code pipeline",
      slug: "code-pipeline",
      description: "",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          { id: "t1", type: "trigger.manual", x: 0, y: 0, config: {} },
          {
            id: "c1",
            type: "logic.code",
            x: 0,
            y: 0,
            config: {
              // The literal braces must reach the vm untouched even though the
              // executor template-resolves every other config field.
              code: 'return { literal: "{{trigger.payload.name}}", fromInput: input.name };',
              timeoutSeconds: 5,
            },
          },
        ],
        edges: [{ id: "e1", fromNodeId: "t1", toNodeId: "c1" }],
      }),
      cronExpr: null,
      nextRunAt: null,
      lastRunAt: null,
      createdById: null,
    });

    const run = await fireManually(pipeline, { name: "Ada" });
    assert.equal(run.status, "completed", run.errorMessage ?? "");
    const outputs = JSON.parse(run.outputJson) as Record<string, NodeOutputs>;
    assert.deepEqual(outputs.c1, {
      literal: "{{trigger.payload.name}}",
      fromInput: "Ada",
    });
    const stored = await AppDataSource.getRepository(PipelineRun).findOneBy({ id: run.id });
    assert.equal(stored?.status, "completed");
  });
});

describe("genosyn.base SDK", () => {
  let nameFieldId: string;
  let emailFieldId: string;

  beforeEach(async () => {
    const base = await insert(Base, {
      companyId: cid,
      name: "CRM",
      slug: "crm",
      description: "",
      icon: "Database",
      color: "indigo",
      createdById: null,
    });
    const table = await insert(BaseTable, {
      baseId: base.id,
      name: "Leads",
      slug: "leads",
      sortOrder: 0,
      archivedAt: null,
    });
    const nameField = await insert(BaseField, {
      tableId: table.id,
      name: "Name",
      type: "text",
      configJson: "{}",
      isPrimary: true,
      sortOrder: 1,
    });
    const emailField = await insert(BaseField, {
      tableId: table.id,
      name: "Email",
      type: "email",
      configJson: "{}",
      isPrimary: false,
      sortOrder: 2,
    });
    await insert(BaseField, {
      tableId: table.id,
      name: "Score",
      type: "number",
      configJson: "{}",
      isPrimary: false,
      sortOrder: 3,
    });
    nameFieldId = nameField.id;
    emailFieldId = emailField.id;
  });

  test("createRecord accepts field names and stores id-keyed cells", async () => {
    const { outputs } = await runCode(
      'return genosyn.base.createRecord("crm", "leads", { Name: "Ada", Email: "ada@example.com" });',
    );
    assert.equal(outputs.values && (outputs.values as Record<string, unknown>).Name, "Ada");
    const rows = await AppDataSource.getRepository(BaseRecord).find();
    assert.equal(rows.length, 1);
    const data = JSON.parse(rows[0].dataJson) as Record<string, unknown>;
    assert.equal(data[nameFieldId], "Ada");
    assert.equal(data[emailFieldId], "ada@example.com");
  });

  test("queryRecords filters by field name and respects limit", async () => {
    await runCode(
      'for (const name of ["Ada", "Grace", "Ada"]) {\n' +
        '  await genosyn.base.createRecord("crm", "leads", { Name: name });\n' +
        "}\n" +
        "return {};",
    );
    const { outputs } = await runCode(
      'const both = await genosyn.base.queryRecords("crm", "leads", { where: { Name: "Ada" } });\n' +
        'const one = await genosyn.base.queryRecords("crm", "leads", { where: { Name: "Ada" }, limit: 1 });\n' +
        'const total = await genosyn.base.countRecords("crm", "leads");\n' +
        "return { both: both.length, one: one.length, total };",
    );
    assert.deepEqual(outputs, { both: 2, one: 1, total: 3 });
  });

  test("updateRecord merges and null clears a cell", async () => {
    const { outputs } = await runCode(
      'const created = await genosyn.base.createRecord("crm", "leads", { Name: "Ada", Email: "ada@example.com" });\n' +
        'const updated = await genosyn.base.updateRecord("crm", "leads", created.id, { Score: 5, Email: null });\n' +
        "return updated;",
    );
    const values = outputs.values as Record<string, unknown>;
    assert.equal(values.Name, "Ada");
    assert.equal(values.Score, 5);
    assert.ok(!("Email" in values));
    const rows = await AppDataSource.getRepository(BaseRecord).find();
    const data = JSON.parse(rows[0].dataJson) as Record<string, unknown>;
    assert.ok(!(emailFieldId in data));
  });

  test("deleteRecord removes the row and its comments", async () => {
    const { outputs } = await runCode(
      'const created = await genosyn.base.createRecord("crm", "leads", { Name: "Ada" });\n' +
        "return { id: created.id };",
    );
    const recordId = String(outputs.id);
    await insert(BaseRecordComment, {
      recordId,
      authorUserId: null,
      authorEmployeeId: null,
      body: "hello",
    });
    const { outputs: deleted } = await runCode(
      `return genosyn.base.deleteRecord("crm", "leads", ${JSON.stringify(recordId)});`,
    );
    assert.deepEqual(deleted, { result: true });
    assert.equal(await AppDataSource.getRepository(BaseRecord).count(), 0);
    assert.equal(await AppDataSource.getRepository(BaseRecordComment).count(), 0);
  });

  test("a fire-and-forget write is drained before the step settles", async () => {
    const { outputs } = await runCode(
      // No await — the worker reports done while the main-thread insert may
      // still be in flight; the runtime must drain it before returning.
      'genosyn.base.createRecord("crm", "leads", { Name: "Ghost" });\n' + "return { ok: true };",
    );
    assert.deepEqual(outputs, { ok: true });
    assert.equal(await AppDataSource.getRepository(BaseRecord).count(), 1);
  });

  test("getRecord with a non-uuid id returns null instead of erroring", async () => {
    const { outputs } = await runCode(
      'const record = await genosyn.base.getRecord("crm", "leads", "external-ref-42");\n' +
        "return { found: record !== null };",
    );
    assert.deepEqual(outputs, { found: false });
  });

  test("an unknown field name lists the available fields", async () => {
    await assert.rejects(
      () => runCode('return genosyn.base.createRecord("crm", "leads", { Nome: "Ada" });'),
      /Unknown field "Nome".*Name.*Email.*Score/s,
    );
  });

  test("an unknown base is a clear error", async () => {
    await assert.rejects(
      () => runCode('return genosyn.base.queryRecords("nope", "leads");'),
      /Base "nope" not found/,
    );
  });

  test("another company's base is not reachable", async () => {
    const otherCompany = testCompanyId();
    await insert(Base, {
      companyId: otherCompany,
      name: "Secret",
      slug: "secret",
      description: "",
      icon: "Database",
      color: "indigo",
      createdById: null,
    });
    await assert.rejects(
      () => runCode('return genosyn.base.listTables("secret");'),
      /Base "secret" not found/,
    );
  });

  test("listBases and getTable expose the schema", async () => {
    const { outputs } = await runCode(
      "const bases = await genosyn.base.listBases();\n" +
        'const table = await genosyn.base.getTable("crm", "leads");\n' +
        "return { baseSlug: bases[0].slug, fieldNames: table.fields.map((f) => f.name) };",
    );
    assert.deepEqual(outputs, { baseSlug: "crm", fieldNames: ["Name", "Email", "Score"] });
  });
});

describe("axios client", () => {
  let server: http.Server;
  let baseUrl: string;
  const savedAllowlist = [...config.security.outboundPrivateHostAllowlist];

  before(async () => {
    config.security.outboundPrivateHostAllowlist.push("127.0.0.1");
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, q: url.searchParams.get("q") }));
        return;
      }
      if (url.pathname === "/echo") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              method: req.method,
              contentType: req.headers["content-type"] ?? null,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    config.security.outboundPrivateHostAllowlist.length = 0;
    config.security.outboundPrivateHostAllowlist.push(...savedAllowlist);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  test("axios.get parses JSON and carries params", async () => {
    const { outputs } = await runCode(
      `const res = await axios.get(${JSON.stringify(baseUrl)} + "/json", { params: { q: "x" } });\n` +
        "return { status: res.status, ok: res.data.ok, q: res.data.q };",
    );
    assert.deepEqual(outputs, { status: 200, ok: true, q: "x" });
  });

  test("axios.post sends JSON bodies with a content-type", async () => {
    const { outputs } = await runCode(
      `const res = await axios.post(${JSON.stringify(baseUrl)} + "/echo", { a: 1 });\n` +
        "return res.data;",
    );
    assert.deepEqual(outputs, {
      method: "POST",
      contentType: "application/json",
      body: '{"a":1}',
    });
  });

  test("non-2xx statuses reject with error.response attached", async () => {
    const { outputs } = await runCode(
      "try {\n" +
        `  await axios.get(${JSON.stringify(baseUrl)} + "/missing");\n` +
        '  return { threw: false };\n' +
        "} catch (err) {\n" +
        "  return { threw: true, status: err.response.status, data: err.response.data };\n" +
        "}",
    );
    assert.deepEqual(outputs, { threw: true, status: 404, data: "nope" });
  });

  test("validateStatus lets non-2xx resolve", async () => {
    const { outputs } = await runCode(
      `const res = await axios.get(${JSON.stringify(baseUrl)} + "/missing", { validateStatus: () => true });\n` +
        "return { status: res.status };",
    );
    assert.deepEqual(outputs, { status: 404 });
  });

  test("private hosts stay blocked without the allowlist", async () => {
    await assert.rejects(
      () => runCode('return axios.get("http://10.0.0.1/internal");'),
      /non-public address|not allowed/i,
    );
  });
});
