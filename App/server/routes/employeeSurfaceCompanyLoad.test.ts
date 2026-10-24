import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express, { Router } from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import { errorHandler } from "../middleware/error.js";
import { createMemberOfNewCompany, withTestInstanceSecrets } from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";
import { failNextRead } from "../test/failedReads.js";
import { persistTestSession } from "../test/userSession.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

/**
 * A chat attachment upload loads the company in the URL before multer runs: the
 * bytes are filed under the company's slug. Nothing else needs it — the other
 * routes here load their employee and company together, and the models, MCP and
 * browser-session routers mounted after this one at
 * `/api/companies/:cid/employees` have no use for it — so the load is kept to
 * the upload (unscoped, it cost each of their requests a Company read), and a
 * read that fails answers the upload instead of leaving it open.
 */

const LATER = "/after-employee-surface";

let userId = "";
const app = express();
app.use(express.json());
// Uploads need a browser session, so every request here is a signed-in Member's.
app.use(async (req, _res, next) => {
  (req as unknown as { session: unknown }).session = { userId, sessionVersion: 0 };
  await persistTestSession(req);
  next();
});
app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
// Mounted after the employee surface at the same place, the way the models,
// MCP and browser-session routers are.
const later = Router({ mergeParams: true });
later.get(`/:eid${LATER}`, (req, res) => {
  res.json({ company: (req as { company?: Company }).company?.id ?? null });
});
app.use("/api/companies/:cid/employees", later);
app.use(errorHandler);

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  const { user, company } = await createMemberOfNewCompany("member");
  userId = user.id;
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Analyst",
    slug: "analyst",
    role: "Analyst",
    soulBody: "",
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/companies/${company.id}/employees/${employee.id}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

function send(path: string, init: { method?: string; body?: FormData } = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: init.method,
    body: init.body,
    // A request the server leaves open fails here, not at the suite's timeout.
    signal: AbortSignal.timeout(5_000),
  });
}

const BYTES = "Quarterly numbers\n";

function upload(): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([BYTES], { type: "text/plain" }), "numbers.txt");
  return send("/chat-attachments", { method: "POST", body: form });
}

describe("the company it loads", () => {
  test("files an upload under the company, and the file comes back", async () => {
    const uploaded = await upload();
    assert.equal(uploaded.status, 201);
    const { id } = (await uploaded.json()) as { id: string };

    const file = await send(`/chat-attachments/${id}`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), BYTES);
  });

  test("is loaded for the upload only, not for routers mounted after it", async () => {
    const response = await send(LATER);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { company: null });
  });

  test("a failed read answers 500 instead of leaving the upload open", async (t) => {
    t.mock.method(console, "error", () => undefined);
    // A signed-in Member's company guard reads the Company first, for its
    // two-factor rule, so the router's own read is the second.
    failNextRead(t, "companies", { skip: 1 });
    const response = await upload();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  });
});
