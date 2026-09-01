import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * The front door of the Email section, now that it starts from an address.
 *
 * Connecting a mailbox used to require a Google Connection to already exist,
 * so the only thing these endpoints could get wrong was a lookup. They now
 * take an email address typed by a person and turn it into DNS lookups, an
 * outbound fetch, and eventually an IMAP socket — which makes the boundary
 * itself the thing worth pinning: what a recognised domain is promised, what
 * a typo gets instead of a stack trace, and what the schema refuses before
 * any of it is attempted.
 *
 * Nothing here reaches the network, and that constrains which cases live in
 * this file. Every address discovered below either resolves from the built-in
 * provider table or fails to parse, so no DNS query and no autoconfig fetch is
 * ever issued; the MX/SRV/autoconfig rungs are exercised against injected
 * lookups in `services/mail/discovery.test.ts`. The successful IMAP connect is
 * absent for the same reason — `connectImapMailbox` proves the credential by
 * opening a real IMAP session against a real host, so everything up to that
 * socket is covered here and the socket itself belongs to the imapClient
 * tests.
 */

type MailboxServerShape = { host: string; port: number; secure: boolean };

type ConnectOption =
  | {
      kind: "oauth";
      provider: string;
      label: string;
      scopeGroups: string[];
      instanceApp?: boolean;
      ready: boolean;
      blockedReason?: string;
    }
  | {
      kind: "imap";
      imap: MailboxServerShape;
      smtp: MailboxServerShape;
      password: { summary: string; url?: string } | null;
      ready: boolean;
      blockedReason?: string;
    };

type ConnectPlan = {
  email: string;
  domain: string;
  providerKey: string;
  displayName: string;
  source: string;
  options: ConnectOption[];
  unsupportedReason?: string;
};

type Candidate = {
  connectionId: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
  hasGmailScope: boolean;
  linkedAccountId: string | null;
};

type ApiError = {
  error?: string;
  issues?: Array<{ code?: string; path?: Array<string | number> }>;
};

type ApiResponse<T> = { status: number; body: T };

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  // The product mount, so the router's own authentication and company
  // membership middleware run in front of every case below.
  app.use("/api/companies/:cid", mailRouter);
  app.use(errorHandler);
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
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: `mail-connect-owner-${randomUUID()}@example.com`,
    name: "Mailbox Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Mail Connect Company",
    slug: `mail-connect-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
});

function url(path: string): string {
  return `${baseUrl}/api/companies/${company.id}${path}`;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(url(path), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function discover(email: unknown): Promise<ApiResponse<{ plan: ConnectPlan } & ApiError>> {
  return call<{ plan: ConnectPlan } & ApiError>("POST", "/mail/connect/discover", { email });
}

function imapOption(plan: ConnectPlan): Extract<ConnectOption, { kind: "imap" }> {
  const option = plan.options.find(
    (o): o is Extract<ConnectOption, { kind: "imap" }> => o.kind === "imap",
  );
  assert.ok(option, `no IMAP option in ${JSON.stringify(plan.options)}`);
  return option;
}

async function connection(args: {
  provider: string;
  label: string;
  config?: Record<string, unknown>;
  encryptedConfig?: string;
}): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId: company.id,
    provider: args.provider,
    label: args.label,
    authMode: args.provider === "google" ? "oauth2" : "apikey",
    encryptedConfig:
      args.encryptedConfig ??
      encryptConnectionConfig((args.config ?? {}) as IntegrationConfig, company.id),
    accountHint: args.label,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
}

async function candidates(): Promise<Map<string, Candidate>> {
  const response = await call<{ candidates: Candidate[] }>("GET", "/mail/connect-candidates");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return new Map(response.body.candidates.map((c) => [c.connectionId, c]));
}

// ─────────────────────── POST /mail/connect/discover ───────────────────────

describe("working out how to connect one address", () => {
  test("a gmail.com address is named Gmail and offered imap.gmail.com with app-password help", async () => {
    const response = await discover("Someone@Gmail.com");
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const plan = response.body.plan;
    assert.equal(plan.displayName, "Gmail");
    assert.equal(plan.providerKey, "google");
    assert.equal(plan.domain, "gmail.com");
    // The address comes back lowercased, because everything downstream — the
    // duplicate-mailbox check, the Connection label — compares against it.
    assert.equal(plan.email, "someone@gmail.com");
    // "builtin" is what lets the dialog say it knows these settings rather
    // than admitting it guessed them.
    assert.equal(plan.source, "builtin");
    assert.equal(plan.unsupportedReason, undefined);

    const imap = imapOption(plan);
    assert.deepEqual(imap.imap, { host: "imap.gmail.com", port: 993, secure: true });
    assert.deepEqual(imap.smtp, { host: "smtp.gmail.com", port: 465, secure: true });
    assert.equal(imap.ready, true);
    // Gmail rejects an ordinary password on IMAP outright, so the plan has to
    // carry the app-password page or the person fails at the password box
    // with no idea why.
    assert.match(imap.password?.summary ?? "", /App password/i);
    assert.equal(imap.password?.url, "https://myaccount.google.com/apppasswords");
  });

  test("the Google button is offered but marked unusable when no OAuth app is registered here", async () => {
    // This install has no `oauth.apps` setting, which is the state every fresh
    // self-hosted deployment is in. A dialog that led with a Google button
    // here would send the person into a token exchange that cannot succeed.
    const plan = (await discover("someone@gmail.com")).body.plan;
    const oauth = plan.options.find(
      (o): o is Extract<ConnectOption, { kind: "oauth" }> => o.kind === "oauth",
    );
    assert.ok(oauth, `no OAuth option in ${JSON.stringify(plan.options)}`);
    assert.equal(oauth.provider, "google");
    assert.equal(oauth.ready, false);
    assert.equal(oauth.instanceApp, false);
    assert.match(oauth.blockedReason ?? "", /no google oauth app is registered/i);
    assert.match(oauth.blockedReason ?? "", /app password/i);

    assert.equal(
      plan.options[0]?.kind,
      "imap",
      "a blocked OAuth route must not sit above the route that actually works",
    );
  });

  test("a malformed address is a readable 400, and the endpoint keeps answering after it", async () => {
    // Every one of these reaches `discoverMailbox`, which turns an address
    // into DNS queries and an outbound fetch. Garbage has to stop at the
    // boundary with words a person can act on rather than as a 500 — and,
    // because the handler is the only try/catch on the path, an unhandled
    // rejection here would take the request down with no response at all.
    for (const malformed of [
      "not-an-email",
      "no-dot@localhost",
      "two@@example.com",
      "user name@example.com",
      "@example.com",
    ]) {
      const response = await discover(malformed);
      assert.equal(response.status, 400, `${malformed}: ${JSON.stringify(response.body)}`);
      assert.match(response.body.error ?? "", /full email address/i, malformed);
      assert.equal(response.body.plan, undefined, malformed);
    }

    const stillAlive = await discover("someone@gmail.com");
    assert.equal(stillAlive.status, 200, "a rejected address must not poison the process");
    assert.equal(stillAlive.body.plan.displayName, "Gmail");
  });

  test("an address that is not a string at all is refused by the schema, not by discovery", async () => {
    for (const body of [{}, { email: 42 }, { email: "a" }, { email: "x".repeat(321) }]) {
      const response = await call<ApiError>("POST", "/mail/connect/discover", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError", JSON.stringify(body));
    }
  });

  test("the address travels in a body: there is no GET form of this route to log it", async () => {
    // Query strings land in access logs, proxy logs and browser history, and
    // an email address is personal data. The endpoint being POST-only is the
    // enforcement, so a GET with the address in the query must find nothing.
    const asQuery = await fetch(
      `${url("/mail/connect/discover")}?email=${encodeURIComponent("someone@gmail.com")}`,
    );
    await asQuery.text();
    assert.equal(asQuery.status, 404);

    const asPost = await discover("someone@gmail.com");
    assert.equal(asPost.status, 200, "the same path must work as a POST");
  });
});

// ───────────────────────── POST /mail/connect/imap ─────────────────────────

describe("refusing an IMAP connect before it opens a socket", () => {
  const address = "ops@example.com";

  async function connectImap(body: Record<string, unknown>): Promise<ApiResponse<ApiError>> {
    return call<ApiError>("POST", "/mail/connect/imap", body);
  }

  function assertRejectedField(response: ApiResponse<ApiError>, field: string): void {
    assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, "ValidationError", field);
    assert.ok(
      response.body.issues?.some((issue) => issue.path?.[0] === field),
      `${field}: expected an issue on that field, got ${JSON.stringify(response.body.issues)}`,
    );
  }

  test("a mailbox with no password is refused rather than dialled with an empty credential", async () => {
    assertRejectedField(await connectImap({ address }), "password");
    assertRejectedField(await connectImap({ address, password: "" }), "password");
  });

  test("a port outside the TCP range is refused instead of reaching the connection pool", async () => {
    assertRejectedField(
      await connectImap({ address, password: "app-password", imapPort: 70000 }),
      "imapPort",
    );
    assertRejectedField(
      await connectImap({ address, password: "app-password", imapPort: 0 }),
      "imapPort",
    );
    assertRejectedField(
      await connectImap({ address, password: "app-password", smtpPort: 993.5 }),
      "smtpPort",
    );
  });

  test("an address longer than an address can be is refused at the boundary", async () => {
    assertRejectedField(
      await connectImap({ address: `${"a".repeat(310)}@example.com`, password: "app-password" }),
      "address",
    );
  });

  test("nothing rejected by the schema leaves a Connection or a mailbox behind", async () => {
    // The connect creates a Connection first and a MailAccount second, and
    // deletes the Connection again if the second half fails. A request that
    // never got past the schema must not have created either — an orphan
    // credential row is the thing nobody can explain later.
    await connectImap({ address, password: "app-password", imapPort: 70000 });
    await connectImap({ address });
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
  });
});

// ──────────────────────── GET /mail/connect-candidates ────────────────────

describe("which existing Connections can back a mailbox", () => {
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

  test("an imap Connection always qualifies — holding the credential is all it is for", async () => {
    const imap = await connection({
      provider: "imap",
      label: "ops@example.com",
      config: { address: "ops@example.com", password: "app-password" },
    });

    const listed = (await candidates()).get(imap.id);
    assert.ok(listed, "the imap Connection was not offered as a candidate");
    assert.equal(listed.provider, "imap");
    assert.equal(listed.label, "ops@example.com");
    assert.equal(listed.status, "connected");
    // No scope is ever consulted for IMAP; an install with no Google app
    // registered at all still has to be able to connect a mailbox.
    assert.equal(listed.hasGmailScope, true);
    assert.equal(listed.linkedAccountId, null);
  });

  test("a google Connection qualifies only when its consent actually covered the mailbox", async () => {
    const withMailbox = await connection({
      provider: "google",
      label: "Workspace (mail)",
      config: { accessToken: "ya29.mail", scope: `openid email ${GMAIL_SCOPE}` },
    });
    const asArray = await connection({
      provider: "google",
      label: "Workspace (mail, array form)",
      config: { accessToken: "ya29.array", scopes: ["openid", "https://mail.google.com/"] },
    });
    const analyticsOnly = await connection({
      provider: "google",
      label: "Analytics only",
      config: {
        accessToken: "ya29.analytics",
        scope: "openid https://www.googleapis.com/auth/analytics.readonly",
      },
    });
    const readonly = await connection({
      provider: "google",
      label: "Read-only mail",
      config: {
        accessToken: "ya29.readonly",
        // Mirroring labels, drafts and sends needs `gmail.modify`; a readonly
        // grant would fail at the first label write, so it must not be
        // offered as connectable.
        scope: `openid https://www.googleapis.com/auth/gmail.readonly`,
      },
    });

    const listed = await candidates();
    assert.equal(listed.get(withMailbox.id)?.hasGmailScope, true);
    assert.equal(listed.get(asArray.id)?.hasGmailScope, true);
    assert.equal(listed.get(analyticsOnly.id)?.hasGmailScope, false);
    assert.equal(listed.get(readonly.id)?.hasGmailScope, false);

    // A Connection that cannot back a mailbox is still listed, so the UI can
    // say *why* it is not clickable instead of silently omitting the account
    // the person came looking for.
    assert.equal(listed.get(analyticsOnly.id)?.label, "Analytics only");
  });

  test("a Connection already backing a mailbox names it instead of disappearing", async () => {
    const linked = await connection({
      provider: "imap",
      label: "already@example.com",
      config: { address: "already@example.com", password: "app-password" },
    });
    const free = await connection({
      provider: "imap",
      label: "spare@example.com",
      config: { address: "spare@example.com", password: "app-password" },
    });
    const account = await insert(MailAccount, {
      companyId: company.id,
      connectionId: linked.id,
      provider: "imap",
      address: "already@example.com",
      status: "active",
      createdByUserId: owner.id,
    });

    const listed = await candidates();
    assert.equal(listed.get(linked.id)?.linkedAccountId, account.id);
    assert.equal(listed.get(free.id)?.linkedAccountId, null);
  });

  test("a google Connection whose config will not decrypt is listed as unusable, not thrown on", async () => {
    // A database restored without its encryption key. One unreadable row must
    // not take the whole connect dialog down with a 500.
    const unreadable = await connection({
      provider: "google",
      label: "Restored without its key",
      encryptedConfig: "not-ciphertext-this-install-can-read",
    });
    const healthy = await connection({
      provider: "google",
      label: "Workspace",
      config: { accessToken: "ya29.mail", scope: GMAIL_SCOPE },
    });

    const listed = await candidates();
    assert.equal(listed.get(unreadable.id)?.hasGmailScope, false);
    assert.equal(listed.get(healthy.id)?.hasGmailScope, true);
  });

  test("Connections that cannot carry mail, or belong to another company, are not offered", async () => {
    await connection({ provider: "stripe", label: "Billing", config: { apiKey: "rk_test" } });
    const otherCompany = await insert(Company, {
      name: "Other Company",
      slug: `other-mail-connect-${randomUUID()}`,
      ownerId: owner.id,
    });
    const foreign = await insert(IntegrationConnection, {
      companyId: otherCompany.id,
      provider: "imap",
      label: "outsider@example.com",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig(
        { address: "outsider@example.com" } as IntegrationConfig,
        otherCompany.id,
      ),
      accountHint: "outsider@example.com",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    const mine = await connection({
      provider: "imap",
      label: "ops@example.com",
      config: { address: "ops@example.com" },
    });

    const listed = await candidates();
    assert.deepEqual([...listed.keys()], [mine.id]);
    assert.equal(listed.has(foreign.id), false, "another tenant's mailbox credential leaked");
  });

  test("the candidate list is behind the same authentication as the rest of the section", async () => {
    actingUserId = null;
    const unauthenticated = await call<ApiError>("GET", "/mail/connect-candidates");
    assert.equal(unauthenticated.status, 401);

    const outsider = await insert(User, {
      email: `mail-connect-outsider-${randomUUID()}@example.com`,
      name: "Outsider",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    const forbidden = await call<ApiError>("GET", "/mail/connect-candidates");
    assert.equal(forbidden.status, 403);

    // The address-shaped endpoints are behind the same gate, so a stranger
    // cannot use discovery as an open DNS/HTTP probe from the server.
    assert.equal((await discover("someone@gmail.com")).status, 403);
    assert.equal(
      (await call("POST", "/mail/connect/imap", { address: "a@b.com", password: "p" })).status,
      403,
    );
  });
});
