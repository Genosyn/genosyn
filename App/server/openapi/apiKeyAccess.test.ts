import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";
import { openApiCoverage } from "./spec.js";

/**
 * API keys against the real App, handlers and all.
 *
 * `apiKeySweep.test.ts` proves the reference's access claims for every route
 * with stubbed handlers. This file runs real handlers on a representative
 * operation from every area, and pins the rules a key lives by: it acts as its
 * Member and no more, only for its own company, only while it is live, and
 * never where the App needs a person at a browser.
 */

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
const app = createApp();
app.use(errorHandler);

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await setPublicUrl("http://genosyn.example.test");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

type Call = { status: number; body: unknown; text: string; headers: Headers };

async function call(
  method: string,
  path: string,
  options: {
    token?: string;
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function ownerWithKey(values: Partial<User> = {}) {
  const member = await createMemberOfNewCompany("owner", values);
  const { key, token } = await mintTestApiKey(member.user.id, member.company.id);
  return { ...member, key, token };
}

/**
 * One everyday read per product area, each answerable on an empty company
 * from the database alone. Every area where an API key can do anything must
 * appear here or in SKIPPED, so a new area gets a real end-to-end check.
 */
const REPRESENTATIVES: Record<string, string> = {
  Companies: "/api/companies/{cid}",
  Home: "/api/companies/{cid}/home",
  Employees: "/api/companies/{cid}/employees",
  Skills: "/api/companies/{cid}/skills",
  "Tool catalogue": "/api/companies/{cid}/tool-catalogue",
  Routines: "/api/companies/{cid}/routines",
  Goals: "/api/companies/{cid}/goals",
  Improvement: "/api/companies/{cid}/revision-proposals",
  "Proactive work": "/api/companies/{cid}/workstreams",
  Standdowns: "/api/companies/{cid}/standdowns",
  Policies: "/api/companies/{cid}/company-policies",
  Budgets: "/api/companies/{cid}/budgets",
  Decisions: "/api/companies/{cid}/decisions",
  Handoffs: "/api/companies/{cid}/handoffs",
  Teams: "/api/companies/{cid}/teams",
  TLDRs: "/api/companies/{cid}/tldrs",
  "Letters to the board": "/api/companies/{cid}/board-letters",
  "Ask AI": "/api/companies/{cid}/ask-ai",
  "Workspace chat": "/api/companies/{cid}/workspace/channels",
  Tasks: "/api/companies/{cid}/projects",
  Notes: "/api/companies/{cid}/notebooks",
  Resources: "/api/companies/{cid}/resources",
  Bases: "/api/companies/{cid}/bases",
  Pipelines: "/api/companies/{cid}/pipelines",
  Explore: "/api/companies/{cid}/explore/charts",
  Email: "/api/companies/{cid}/mail/accounts",
  Revenue: "/api/companies/{cid}/revenue/contacts",
  Meetings: "/api/companies/{cid}/meetings",
  Marketing: "/api/companies/{cid}/marketing/campaigns",
  Recruiting: "/api/companies/{cid}/recruiting/openings",
  Customers: "/api/companies/{cid}/customers",
  Finance: "/api/companies/{cid}/invoices",
  Banking: "/api/companies/{cid}/bank-transactions",
  "Document signing": "/api/companies/{cid}/signature-envelopes",
  "Data rooms": "/api/companies/{cid}/data-rooms",
  Tags: "/api/companies/{cid}/tags",
  Notifications: "/api/companies/{cid}/notifications",
  "Audit log": "/api/companies/{cid}/audit",
  Usage: "/api/companies/{cid}/usage",
  "Company SSO": "/api/companies/{cid}/sso",
};

/** Areas where every key-friendly operation needs a record the empty company lacks. */
const SKIPPED: Record<string, string> = {
  Autonomy: "Its reads are per AI Employee; covered by the journal test's employee instead.",
  Forms: "Every form lives inside a Base table.",
  MCP: "JSON-RPC to the Genosyn MCP server or an AI Employee; covered by their own route tests (routes/companyMcp*.test.ts).",
  "Chat surfaces": "Its key-friendly operations act on an existing identity.",
};

describe("an API key does the everyday work of every area", () => {
  test("every area an API key can reach has a representative here", () => {
    const keyAreas = new Set(
      openApiCoverage(app)
        .documented.filter((operation) => operation.access.apiKey)
        .map((operation) => operation.area),
    );
    const unrepresented = [...keyAreas].filter((area) => !REPRESENTATIVES[area] && !SKIPPED[area]);
    assert.deepEqual(unrepresented, [], "Add a representative read for each new area");
    for (const area of Object.keys(REPRESENTATIVES)) {
      assert.ok(keyAreas.has(area), `${area} has no API-key operation any more`);
    }
  });

  test("a representative read in each area answers a key and a session alike", async () => {
    const { user, company, token } = await ownerWithKey();
    const cookie = await sessionCookieFor(user);
    const documented = new Set(
      openApiCoverage(app).documented.map((operation) => `${operation.method} ${operation.path}`),
    );
    for (const [area, template] of Object.entries(REPRESENTATIVES)) {
      assert.ok(documented.has(`get ${template}`), `${area}: GET ${template} is not documented`);
      const path = template.replace("{cid}", company.id);
      const withKey = await call("GET", path, { token });
      assert.equal(
        withKey.status,
        200,
        `${area}: GET ${template} with a key → ${withKey.status} ${withKey.text}`,
      );
      assert.equal(typeof withKey.body, "object", `${area}: answered ${withKey.text}`);
      const withSession = await call("GET", path, { cookie });
      assert.equal(
        withSession.status,
        200,
        `${area}: GET ${template} with a session → ${withSession.status}`,
      );
    }
  });

  test("a key writes too: create, read back, update and delete a tag", async () => {
    const { company, token } = await ownerWithKey();
    const created = await call("POST", `/api/companies/${company.id}/tags`, {
      token,
      body: { name: "From the API" },
    });
    assert.equal(created.status, 201, created.text);
    const tag = created.body as { id: string; name: string };
    assert.equal(tag.name, "From the API");
    const listed = await call("GET", `/api/companies/${company.id}/tags`, { token });
    assert.ok((listed.body as Array<{ id: string }>).some((row) => row.id === tag.id));
    const renamed = await call("PATCH", `/api/companies/${company.id}/tags/${tag.id}`, {
      token,
      body: { name: "Renamed" },
    });
    assert.equal(renamed.status, 200, renamed.text);
    const removed = await call("DELETE", `/api/companies/${company.id}/tags/${tag.id}`, { token });
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);
  });
});

describe("a key acts as its Member, and only in its company", () => {
  test("a key for one company is refused on another, even one its Member belongs to", async () => {
    const { user, company, token } = await ownerWithKey();
    const other = await createMemberOfNewCompany("owner");
    await insert(Membership, { companyId: other.company.id, userId: user.id, role: "owner" });

    assert.equal(
      (await call("GET", `/api/companies/${company.id}/employees`, { token })).status,
      200,
    );
    const elsewhere = await call("GET", `/api/companies/${other.company.id}/employees`, { token });
    assert.equal(
      elsewhere.status,
      401,
      "the key is not even recognized outside its company's paths",
    );
    // The cookie of the same Member still opens the other company.
    const cookie = await sessionCookieFor(user);
    assert.equal(
      (await call("GET", `/api/companies/${other.company.id}/employees`, { cookie })).status,
      200,
    );
  });

  test("a key whose Member has left the company is refused", async () => {
    const { user, company, token } = await ownerWithKey();
    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: user.id,
    });
    const response = await call("GET", `/api/companies/${company.id}/employees`, { token });
    assert.equal(response.status, 403);
  });

  test("a Member's key cannot do what the Member cannot", async () => {
    const owner = await createMemberOfNewCompany("owner");
    const member = await insert(User, {
      email: `member-${Date.now()}@example.test`,
      name: "Member",
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: owner.company.id,
      userId: member.id,
      role: "member",
      financeAccess: "none",
    });
    const { token } = await mintTestApiKey(member.id, owner.company.id);
    const cid = owner.company.id;

    // Goals are admin-gated for changes: a Member's key reads them but cannot write.
    assert.equal((await call("GET", `/api/companies/${cid}/goals`, { token })).status, 200);
    const create = await call("POST", `/api/companies/${cid}/goals`, {
      token,
      body: { title: "Grow", metric: "MRR", target: 10 },
    });
    assert.equal(create.status, 403, create.text);
    // No Finance access, no Finance — whatever the credential.
    assert.equal((await call("GET", `/api/companies/${cid}/invoices`, { token })).status, 403);
    // The audit log is admin-only.
    assert.equal((await call("GET", `/api/companies/${cid}/audit`, { token })).status, 403);
  });
});

describe("only a live key authenticates", () => {
  test("revoked, expired, malformed and unknown keys are all refused", async () => {
    const { user, company } = await ownerWithKey();
    const path = `/api/companies/${company.id}/employees`;
    const revoked = await mintTestApiKey(user.id, company.id, { revokedAt: new Date() });
    const expired = await mintTestApiKey(user.id, company.id, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const future = await mintTestApiKey(user.id, company.id, {
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    assert.equal((await call("GET", path, { token: revoked.token })).status, 401);
    assert.equal((await call("GET", path, { token: expired.token })).status, 401);
    assert.equal((await call("GET", path, { token: future.token })).status, 200);

    for (const garbage of [
      "gen_short",
      `xyz_${"A".repeat(43)}`,
      `gen_${"*".repeat(43)}`,
      `gen_${"B".repeat(43)}`,
    ]) {
      assert.equal((await call("GET", path, { token: garbage })).status, 401, garbage);
    }
    assert.equal(
      (await call("GET", path, { headers: { authorization: `Basic ${future.token}` } })).status,
      401,
    );
  });

  test("a key revoked through the App stops working on the next request", async () => {
    const { user, company, key, token } = await ownerWithKey();
    const path = `/api/companies/${company.id}/employees`;
    assert.equal((await call("GET", path, { token })).status, 200);
    const cookie = await sessionCookieFor(user);
    const revoke = await call("DELETE", `/api/companies/${company.id}/api-keys/${key.id}`, {
      cookie,
    });
    assert.equal(revoke.status, 200, revoke.text);
    assert.equal((await call("GET", path, { token })).status, 401);
  });

  test("using a key records when it was last used", async () => {
    const { company, key, token } = await ownerWithKey();
    assert.equal(key.lastUsedAt, null);
    await call("GET", `/api/companies/${company.id}/employees`, { token });
    // The write is fire-and-forget; give it a moment to land.
    let stored: ApiKey | null = null;
    for (let attempt = 0; attempt < 20 && !stored?.lastUsedAt; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await AppDataSource.getRepository(ApiKey).findOneBy({ id: key.id });
    }
    assert.ok(stored?.lastUsedAt, "lastUsedAt was not recorded");
  });
});

describe("browser-only operations refuse keys and take sessions", () => {
  test("credential custody and keys themselves need a browser", async () => {
    const { user, company, token } = await ownerWithKey();
    const cookie = await sessionCookieFor(user);
    for (const path of [
      `/api/companies/${company.id}/api-keys`,
      `/api/companies/${company.id}/integrations/catalog`,
      `/api/companies/${company.id}/vault/items`,
      `/api/companies/${company.id}/secrets`,
      `/api/companies/${company.id}/email/providers`,
    ]) {
      const withKey = await call("GET", path, { token });
      assert.equal(withKey.status, 403, `${path} with a key`);
      assert.match(withKey.text, /browser session|logged-in Member/i, path);
      const withSession = await call("GET", path, { cookie });
      assert.equal(withSession.status, 200, `${path} with a session → ${withSession.text}`);
    }
  });

  test("a key cannot mint another key; a session can", async () => {
    const { user, company, token } = await ownerWithKey();
    const minted = await call("POST", `/api/companies/${company.id}/api-keys`, {
      token,
      body: { name: "Chained" },
    });
    assert.equal(minted.status, 403);
    const cookie = await sessionCookieFor(user);
    const fromBrowser = await call("POST", `/api/companies/${company.id}/api-keys`, {
      cookie,
      body: { name: "From the browser" },
    });
    assert.equal(fromBrowser.status, 200, fromBrowser.text);
    assert.match((fromBrowser.body as { token: string }).token, /^gen_[A-Za-z0-9_-]{43}$/);
  });

  test("account and instance operations do not recognize a key at all", async () => {
    const { user, token } = await ownerWithKey({ isMasterAdmin: true });
    const cookie = await sessionCookieFor(user);
    for (const path of [
      "/api/auth/me",
      "/api/companies",
      "/api/admin/users",
      "/api/employee-templates",
    ]) {
      assert.equal((await call("GET", path, { token })).status, 401, `${path} with a key`);
      const withSession = await call("GET", path, { cookie });
      assert.equal(withSession.status, 200, `${path} with a session → ${withSession.text}`);
    }
  });
});

describe("what an API client needs to orient itself", () => {
  test("GET /me names the key's Member, role, Finance access and the key", async () => {
    const { user, company, key, token } = await ownerWithKey();
    const me = await call("GET", `/api/companies/${company.id}/me`, { token });
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body, {
      user: { id: user.id, email: user.email, name: user.name, handle: null },
      company: { id: company.id, name: company.name, slug: company.slug },
      role: "owner",
      financeAccess: "full",
      authentication: "api_key",
      apiKey: { id: key.id, name: key.name, prefix: `gen_${key.prefix}`, expiresAt: null },
      connectedApp: null,
    });

    const cookie = await sessionCookieFor(user);
    const fromBrowser = await call("GET", `/api/companies/${company.id}/me`, { cookie });
    assert.equal((fromBrowser.body as { authentication: string }).authentication, "session");
    assert.equal((fromBrowser.body as { apiKey: unknown }).apiKey, null);
  });

  test("GET /me reports a Member's own role and Finance access", async () => {
    const owner = await createMemberOfNewCompany("owner");
    const member = await insert(User, {
      email: `reader-${Date.now()}@example.test`,
      name: "Reader",
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: owner.company.id,
      userId: member.id,
      role: "member",
      financeAccess: "read",
    });
    const { token } = await mintTestApiKey(member.id, owner.company.id);
    const me = await call("GET", `/api/companies/${owner.company.id}/me`, { token });
    assert.equal((me.body as { role: string }).role, "member");
    assert.equal((me.body as { financeAccess: string }).financeAccess, "read");
  });

  test("the employee template catalogue is reachable below the company", async () => {
    const { user, company, token } = await ownerWithKey();
    const withKey = await call("GET", `/api/companies/${company.id}/employee-templates`, { token });
    assert.equal(withKey.status, 200, withKey.text);
    const cookie = await sessionCookieFor(user);
    const global = await call("GET", "/api/employee-templates", { cookie });
    assert.deepEqual(withKey.body, global.body);
    assert.ok((withKey.body as unknown[]).length > 0);
    // A stranger to the company gets nothing.
    const stranger = await ownerWithKey();
    const refused = await call("GET", `/api/companies/${company.id}/employee-templates`, {
      cookie: await sessionCookieFor(stranger.user),
    });
    assert.equal(refused.status, 403);
  });
});

describe("regressions the audit found", () => {
  test("a journal note written with a key is attributed to the key's Member", async () => {
    const { user, company, token } = await ownerWithKey();
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Ada",
      slug: "ada",
      role: "Analyst",
    });
    const response = await call(
      "POST",
      `/api/companies/${company.id}/employees/${employee.id}/journal`,
      {
        token,
        body: { title: "Noted from a script", body: "Hello" },
      },
    );
    assert.equal(response.status, 200, response.text);
    const entry = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
      id: (response.body as { id: string }).id,
    });
    assert.equal(entry.authorUserId, user.id);
  });

  test("the cross-origin gate lets a key through and still stops a cookie", async () => {
    const { user, company, token } = await ownerWithKey();
    const crossSite = { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" };
    const withKey = await call("POST", `/api/companies/${company.id}/tags`, {
      token,
      headers: crossSite,
      body: { name: "Scripted" },
    });
    assert.equal(withKey.status, 201, withKey.text);
    const withCookie = await call("POST", `/api/companies/${company.id}/tags`, {
      cookie: await sessionCookieFor(user),
      headers: crossSite,
      body: { name: "Forged" },
    });
    assert.equal(withCookie.status, 403);
    assert.match(withCookie.text, /Cross-origin request rejected/);
  });
});

describe("the reference itself", () => {
  test("GET /api/openapi.json serves the full document for this instance", async () => {
    const response = await call("GET", "/api/openapi.json");
    assert.equal(response.status, 200);
    const document = response.body as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    assert.equal(document.openapi, "3.0.0");
    assert.equal(document.servers[0].url, "http://genosyn.example.test");
    assert.ok(Object.keys(document.paths).length > 700);
    assert.ok(document.paths["/api/companies/{cid}/revenue/deals"]);
    assert.equal(document.paths["/api/internal/mcp/manifest"], undefined);
  });

  test("/api/docs serves the viewer with Genosyn's search", async () => {
    const redirect = await call("GET", "/api/docs");
    assert.ok([200, 301, 302, 303].includes(redirect.status), `GET /api/docs → ${redirect.status}`);
    const page = await call("GET", "/api/docs/");
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Genosyn API<\/title>/);
    assert.match(page.text, /genosyn-docs\.js/);
    const script = await call("GET", "/api/docs/genosyn-docs.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(script.text, /GenosynSearch/);
    assert.match(script.text, /\/api\/openapi\.json/);
  });
});
