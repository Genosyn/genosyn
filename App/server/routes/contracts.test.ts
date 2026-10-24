import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express, { Router } from "express";

import type { Company } from "../db/entities/Company.js";
import { errorHandler } from "../middleware/error.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb } from "../test/dbHarness.js";
import { failNextRead } from "../test/failedReads.js";
import { contractsRouter } from "./contracts.js";

/**
 * The contracts router loads the company in the URL before its own routes run:
 * an upload needs the company's slug to know where the bytes go. It shares the
 * `/api/companies/:cid` mount with every router after it, so the load is kept
 * to its own paths (unscoped, it cost every request to those routers a Company
 * read), and a read that fails answers the request instead of leaving it open.
 */

const LATER = "/after-contracts";

const app = express();
app.use(express.json());
app.use("/api/companies/:cid", contractsRouter);
// Mounted after contracts at the same place, the way the real routers are.
const later = Router({ mergeParams: true });
later.get(LATER, (req, res) => {
  res.json({ company: (req as { company?: Company }).company?.id ?? null });
});
app.use("/api/companies/:cid", later);
app.use(errorHandler);

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
let companyId = "";
let authorization = "";

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { user, company } = await createMemberOfNewCompany("member");
  companyId = company.id;
  // Used a moment ago, so a request does not also record the use.
  const { token } = await mintTestApiKey(user.id, companyId, { lastUsedAt: new Date() });
  authorization = `Bearer ${token}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

function send(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | FormData } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method: init.method,
    headers: { authorization, ...init.headers },
    body: init.body,
    // A request the server leaves open fails here, not at the suite's timeout.
    signal: AbortSignal.timeout(5_000),
  });
}

type ContractBody = { id: string; title: string; filename: string; sizeBytes: number };

describe("contract routes", () => {
  test("a contract goes up, is listed, downloads, changes and goes away", async () => {
    const bytes = "%PDF-1.4\n% a tiny agreement\n";
    const form = new FormData();
    form.append("title", "Master services agreement");
    form.append("file", new Blob([bytes], { type: "application/pdf" }), "msa.pdf");
    const created = await send("/contracts", { method: "POST", body: form });
    assert.equal(created.status, 201);
    const contract = (await created.json()) as ContractBody;
    assert.equal(contract.title, "Master services agreement");
    assert.equal(contract.filename, "msa.pdf");
    assert.equal(contract.sizeBytes, bytes.length);

    const listed = await send("/contracts");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      ((await listed.json()) as ContractBody[]).map((row) => row.id),
      [contract.id],
    );

    const file = await send(`/contracts/${contract.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.equal(await file.text(), bytes);

    const changed = await send(`/contracts/${contract.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "MSA" }),
    });
    assert.equal(changed.status, 200);
    assert.equal(((await changed.json()) as ContractBody).title, "MSA");

    const removed = await send(`/contracts/${contract.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await send(`/contracts/${contract.id}/file`)).status, 404);
  });
});

describe("the company it loads", () => {
  test("is loaded for contract routes only, not for routers mounted after it", async () => {
    const response = await send(LATER);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { company: null });
  });

  test("a failed read answers 500 instead of leaving the request open", async (t) => {
    // An API key never reads the Company to authorize, so the first Company
    // read is the router's own.
    failNextRead(t, "companies");
    const response = await send("/contracts");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  });
});
