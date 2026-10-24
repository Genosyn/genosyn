import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { Router } from "express";
import { QueryFailedError, type Logger } from "typeorm";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { TotpCredential } from "../db/entities/TotpCredential.js";
import type { User } from "../db/entities/User.js";
import { discoverRoutes } from "../openapi/routeDiscovery.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";
import { requireAuth, requireCompanyMember } from "./auth.js";
import { errorHandler } from "./error.js";

/**
 * One request, one look at who is asking.
 *
 * About sixty routers are mounted under `/api/companies/:cid`, and each opens
 * with `requireAuth` and `requireCompanyMember`, so a request meets both
 * guards once for every router it passes on the way to the one that answers
 * it. Each run used to read the database again — the sign-in or the API key,
 * its User, the Membership and, for a browser session, the Company — so a
 * request to the last router read the same rows some sixty times over. Every
 * guard still runs and still decides; this file pins that the reads behind
 * them happen once per request, that nothing is kept past it, and that a
 * failed read answers the request instead of leaving it open.
 *
 * The requests go to a probe mounted after every router `createApp()` mounts
 * and guarded exactly as each of them is, so they travel the whole company
 * stack, and the probe's own handler reads nothing.
 */

const PROBE = "/auth-lookups-probe";

const app = createApp();
const probe = Router({ mergeParams: true });
probe.use(requireAuth);
probe.use(requireCompanyMember);
probe.get(PROBE, (req, res) => {
  res.json({ userId: req.userId, role: req.companyRole, viaApiKey: Boolean(req.apiKey) });
});
app.use("/api/companies/:cid", probe);
app.use(errorHandler);

/** The tables a guard reads to decide who is asking and what they may do there. */
const AUTH_TABLES = [
  "user_sessions",
  "api_keys",
  "users",
  "memberships",
  "companies",
  "totp_credentials",
  "webauthn_credentials",
];

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
let user: User;
let companyId = "";
let cookie = "";
let token = "";

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await setPublicUrl("http://genosyn.example.test");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const member = await createMemberOfNewCompany("admin");
  user = member.user;
  companyId = member.company.id;
  cookie = await sessionCookieFor(user);
  // Used a moment ago, so the request does not also record the use: that
  // write reads the key again on its own, after the response.
  token = (await mintTestApiKey(user.id, companyId, { lastUsedAt: new Date() })).token;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

type Lookups = Record<string, number>;

/**
 * Send one request to the probe and count the SELECTs it sent to each auth
 * table. With `failOn`, the first read of that table fails the way a locked
 * database fails a statement.
 */
async function probeRequest(
  headers: Record<string, string>,
  options: { company?: string; failOn?: string } = {},
): Promise<{ status: number; body: unknown; lookups: Lookups }> {
  const lookups: Lookups = {};
  let failed = false;
  const capture: Logger = {
    logQuery: (sql, parameters) => {
      const table = /^\s*SELECT\b[\s\S]*?\bFROM "([a-z_]+)"/i.exec(sql)?.[1];
      if (!table || !AUTH_TABLES.includes(table)) return;
      lookups[table] = (lookups[table] ?? 0) + 1;
      if (table === options.failOn && !failed) {
        failed = true;
        throw new QueryFailedError(sql, parameters, new Error("SQLITE_BUSY: database is locked"));
      }
    },
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
  const original = AppDataSource.logger;
  Object.assign(AppDataSource, { logger: capture });
  try {
    const response = await fetch(
      `${baseUrl}/api/companies/${options.company ?? companyId}${PROBE}`,
      {
        headers,
        // A request the server leaves open fails here, not at the suite's timeout.
        signal: AbortSignal.timeout(5_000),
      },
    );
    return { status: response.status, body: await response.json(), lookups };
  } finally {
    Object.assign(AppDataSource, { logger: original });
  }
}

describe("a request through every company router", () => {
  const route = discoverRoutes(app).routes.find(
    (candidate) => candidate.expressPath === `/api/companies/:cid${PROBE}`,
  );
  const runsOf = (guard: unknown) => route?.chain.filter((link) => link.handle === guard).length;

  test("meets both guards once per router it passes", () => {
    assert.ok(route, "the probe is routed");
    // One pair per company router, plus `requireAuth` on the `/api` and
    // `/api/companies` routers mounted ahead of them.
    assert.ok(runsOf(requireCompanyMember)! >= 50, `${runsOf(requireCompanyMember)} routers`);
    assert.ok(runsOf(requireAuth)! > runsOf(requireCompanyMember)!);
  });

  test("reads a browser session's sign-in, User, Membership and Company once", async () => {
    const { status, body, lookups } = await probeRequest({ cookie });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, { userId: user.id, role: "admin", viaApiKey: false });
    assert.deepEqual(
      lookups,
      { user_sessions: 1, users: 1, memberships: 1, companies: 1 },
      `${runsOf(requireCompanyMember)} company routers`,
    );
  });

  test("reads an API key, its User and the Membership once", async () => {
    const { status, body, lookups } = await probeRequest({ authorization: `Bearer ${token}` });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, { userId: user.id, role: "admin", viaApiKey: true });
    // A key skips the company's two-factor rule, so nothing reads the Company.
    assert.deepEqual(
      lookups,
      { api_keys: 1, users: 1, memberships: 1 },
      `${runsOf(requireCompanyMember)} company routers`,
    );
  });

  test("checks a company's two-factor rule once", async () => {
    const strict = await insert(Company, {
      name: "Strict",
      slug: `strict-${companyId}`,
      ownerId: user.id,
      requireTwoFactor: true,
    });
    await insert(Membership, { companyId: strict.id, userId: user.id, role: "member" });
    const refused = await probeRequest({ cookie }, { company: strict.id });
    assert.equal(refused.status, 403);
    assert.match(JSON.stringify(refused.body), /requires two-factor authentication/);

    await insert(TotpCredential, {
      userId: user.id,
      name: "Phone",
      secret: "not-a-real-secret",
      verifiedAt: new Date(),
    });
    const { status, lookups } = await probeRequest({ cookie }, { company: strict.id });
    assert.equal(status, 200);
    assert.deepEqual(lookups, {
      user_sessions: 1,
      users: 1,
      memberships: 1,
      companies: 1,
      totp_credentials: 1,
      webauthn_credentials: 1,
    });
  });
});

describe("nothing outlives the request", () => {
  test("a key revoked after one request is refused on the next", async () => {
    const minted = await mintTestApiKey(user.id, companyId, { lastUsedAt: new Date() });
    const headers = { authorization: `Bearer ${minted.token}` };
    assert.equal((await probeRequest(headers)).status, 200);
    await AppDataSource.getRepository(ApiKey).update(minted.key.id, { revokedAt: new Date() });
    const refused = await probeRequest(headers);
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.lookups, { api_keys: 1 });
  });

  test("a Member removed after one request is refused on the next", async () => {
    const leaving = await createMemberOfNewCompany("member");
    const session = await sessionCookieFor(leaving.user);
    const minted = await mintTestApiKey(leaving.user.id, leaving.company.id, {
      lastUsedAt: new Date(),
    });
    const key = { authorization: `Bearer ${minted.token}` };
    const options = { company: leaving.company.id };
    assert.equal((await probeRequest({ cookie: session }, options)).status, 200);
    assert.equal((await probeRequest(key, options)).status, 200);
    await AppDataSource.getRepository(Membership).delete(leaving.membership.id);
    assert.equal((await probeRequest({ cookie: session }, options)).status, 403);
    assert.equal((await probeRequest(key, options)).status, 403);
  });
});

describe("a failed read answers the request", () => {
  const cases: Array<{ name: string; credential: () => Record<string, string>; table: string }> = [
    { name: "the sign-in", credential: () => ({ cookie }), table: "user_sessions" },
    {
      name: "the API key",
      credential: () => ({ authorization: `Bearer ${token}` }),
      table: "api_keys",
    },
    { name: "a session's Membership", credential: () => ({ cookie }), table: "memberships" },
    {
      name: "a key's Membership",
      credential: () => ({ authorization: `Bearer ${token}` }),
      table: "memberships",
    },
    { name: "the Company's two-factor rule", credential: () => ({ cookie }), table: "companies" },
  ];
  for (const { name, credential, table } of cases) {
    test(`reading ${name} fails with 500 instead of hanging`, async () => {
      const { status, body } = await probeRequest(credential(), { failOn: table });
      assert.equal(status, 500);
      assert.deepEqual(body, { error: "Internal server error" });
    });
  }

  test("and the next request reads afresh", async () => {
    assert.equal((await probeRequest({ cookie })).status, 200);
  });
});
