import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { createMailAccount } from "../services/mail/accounts.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * The sender name of an IMAP mailbox, at the HTTP boundary.
 *
 * The name is what every recipient sees beside the address, so the rules
 * pinned here are the ones a person setting it would trip over: what gets
 * stored for what they typed, which mistakes are refused and in what words,
 * that a refusal changes nothing, that Gmail — which keeps its own name — is
 * told where to look instead of being given a field that would never be sent,
 * and that every change is on the record. What the name does to the bytes on
 * the wire is covered by `services/mail/mailbox/imap.test.ts`.
 *
 * Nothing here reaches the network. The connect cases stop before the
 * credential check by construction, which is itself the behaviour under test.
 */

type AccountBody = { account: { id: string; senderName: string; status: string } };
type ApiError = { error?: string; issues?: Array<{ path?: Array<string | number> }> };
type ApiResponse<T> = { status: number; body: T };

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let imapAccount: MailAccount;
let gmailAccount: MailAccount;

const originalFetch = globalThis.fetch;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function user(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function connection(
  companyId: string,
  provider: "imap" | "google",
): Promise<IntegrationConnection> {
  const config: IntegrationConfig =
    provider === "imap"
      ? {
          address: "avery@example.com",
          password: "app-password",
          imapHost: "imap.example.com",
          imapPort: "993",
          smtpHost: "smtp.example.com",
          smtpPort: "465",
        }
      : {
          accessToken: "token",
          expiresAt: Date.now() + 3_600_000,
          email: "ops@gmail.com",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        };
  return insert(IntegrationConnection, {
    companyId,
    provider,
    label: provider,
    authMode: provider === "google" ? "oauth2" : "apikey",
    encryptedConfig: encryptConnectionConfig(config, companyId),
    accountHint: provider,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
}

async function account(
  companyId: string,
  provider: "imap" | "gmail",
  address: string,
): Promise<MailAccount> {
  const conn = await connection(companyId, provider === "imap" ? "imap" : "google");
  return insert(MailAccount, {
    companyId,
    connectionId: conn.id,
    provider,
    address,
    status: "active",
    createdByUserId: null,
  });
}

beforeEach(async () => {
  await resetTestDb();
  owner = await user("owner");
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Sender Name Company",
    slug: `sender-name-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  imapAccount = await account(company.id, "imap", "avery@example.com");
  gmailAccount = await account(company.id, "gmail", "ops@gmail.com");
});

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  // The test's own requests, unaffected by a case that stubs the app's `fetch`.
  const response = await originalFetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function rename(target: MailAccount, senderName: unknown) {
  return call<AccountBody & ApiError>("PATCH", `/mail/accounts/${target.id}`, { senderName });
}

async function stored(target: MailAccount): Promise<MailAccount> {
  return AppDataSource.getRepository(MailAccount).findOneByOrFail({ id: target.id });
}

async function renameAudits() {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id, action: "mail.account.sender_name" },
    order: { createdAt: "ASC" },
  });
}

// ─────────────────────── PATCH /mail/accounts/:aid ───────────────────────

describe("setting an IMAP mailbox's sender name", () => {
  test("a mailbox starts without one, and the account list says so", async () => {
    const response = await call<{ accounts: Array<{ id: string; senderName: string }> }>(
      "GET",
      "/mail/accounts",
    );
    assert.equal(response.status, 200);
    const listed = response.body.accounts.find((a) => a.id === imapAccount.id);
    assert.equal(listed?.senderName, "");
  });

  test("stores the name as one tidy line and hands it back", async () => {
    const response = await rename(imapAccount, "  Avery \n  Monroe  ");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.account.senderName, "Avery Monroe");
    assert.equal((await stored(imapAccount)).senderName, "Avery Monroe");

    const single = await call<AccountBody>("GET", `/mail/accounts/${imapAccount.id}`);
    assert.equal(single.body.account.senderName, "Avery Monroe");
  });

  test("keeps a name full of punctuation, quotes and other scripts exactly as typed", async () => {
    // The header grammar is the composer's problem, not the person's.
    const name = 'Monroe, Avery "AJ" (Ops) · 李雷';
    const response = await rename(imapAccount, name);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await stored(imapAccount)).senderName, name);
  });

  test("records who renamed the mailbox, from what, to what", async () => {
    await rename(imapAccount, "Avery Monroe");
    await rename(imapAccount, "Avery at Acme");
    const audits = await renameAudits();
    assert.equal(audits.length, 2);
    assert.equal(audits[0].actorUserId, owner.id);
    assert.equal(audits[0].targetId, imapAccount.id);
    assert.equal(audits[0].targetLabel, "avery@example.com");
    assert.deepEqual(JSON.parse(audits[0].metadataJson), {
      previous: "",
      senderName: "Avery Monroe",
    });
    assert.deepEqual(JSON.parse(audits[1].metadataJson), {
      previous: "Avery Monroe",
      senderName: "Avery at Acme",
    });
  });

  test("saving the name it already has changes nothing and records nothing", async () => {
    await rename(imapAccount, "Avery Monroe");
    const again = await rename(imapAccount, " Avery  Monroe ");
    assert.equal(again.status, 200);
    assert.equal((await renameAudits()).length, 1);
  });

  test("an empty name clears it, back to the bare address", async () => {
    await rename(imapAccount, "Avery Monroe");
    const cleared = await rename(imapAccount, "   ");
    assert.equal(cleared.status, 200);
    assert.equal((await stored(imapAccount)).senderName, "");
  });

  test("accepts a name at the limit and refuses one past it, in words", async () => {
    assert.equal((await rename(imapAccount, "a".repeat(100))).status, 200);
    const tooLong = await rename(imapAccount, "b".repeat(101));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, "A sender name can be at most 100 characters.");
    assert.equal((await stored(imapAccount)).senderName, "a".repeat(100));
  });

  test("refuses control characters instead of storing them", async () => {
    for (const name of [
      "Avery\u0000Monroe",
      "Avery\u0007",
      "Avery\u007fMonroe",
      "Avery\u0085Monroe",
    ]) {
      const response = await rename(imapAccount, name);
      assert.equal(response.status, 400, JSON.stringify(name));
      assert.match(response.body.error ?? "", /printable/);
    }
    assert.equal((await stored(imapAccount)).senderName, "");
    assert.equal((await renameAudits()).length, 0);
  });

  test("refuses something that is not a name before the service sees it", async () => {
    for (const value of [42, null, ["Avery"], "x".repeat(1001)]) {
      const response = await rename(imapAccount, value);
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.equal(response.body.error, "ValidationError");
    }
  });

  test("a Gmail mailbox is told where Gmail keeps its name, and nothing is stored", async () => {
    const response = await rename(gmailAccount, "Ops Team");
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /Settings → Accounts → Send mail as/);
    assert.equal((await stored(gmailAccount)).senderName, "");
    // Clearing a name that is not there is harmless, so it is not an error.
    assert.equal((await rename(gmailAccount, "")).status, 200);
  });

  test("a refused name leaves a status change in the same request unapplied", async () => {
    const response = await call<ApiError>("PATCH", `/mail/accounts/${imapAccount.id}`, {
      status: "paused",
      senderName: "x".repeat(101),
    });
    assert.equal(response.status, 400);
    assert.equal((await stored(imapAccount)).status, "active");
  });

  test("the name and the status can change together", async () => {
    const response = await call<AccountBody>("PATCH", `/mail/accounts/${imapAccount.id}`, {
      status: "paused",
      senderName: "Ops",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.account.status, "paused");
    assert.equal(response.body.account.senderName, "Ops");
  });

  test("pausing sync on its own leaves the name alone", async () => {
    await rename(imapAccount, "Avery Monroe");
    const paused = await call<AccountBody>("PATCH", `/mail/accounts/${imapAccount.id}`, {
      status: "paused",
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.account.senderName, "Avery Monroe");
    assert.equal((await renameAudits()).length, 1);
  });

  test("a request that changes nothing is refused", async () => {
    const response = await call<ApiError>("PATCH", `/mail/accounts/${imapAccount.id}`, {});
    assert.equal(response.status, 400);
  });

  test("another company's mailbox is not found, and stays as it was", async () => {
    const elsewhere = await account(`co_${randomUUID()}`, "imap", "someone@else.example");
    const response = await rename(elsewhere, "Hijacked");
    assert.equal(response.status, 404);
    assert.equal((await stored(elsewhere)).senderName, "");
  });

  test("any Member may set it, like the rest of the mailbox's settings", async () => {
    // Members already send from the mailbox and change its other settings;
    // only connecting one is admin-only, because that stores a credential.
    const member = await user("member");
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
    actingUserId = member.id;
    const response = await rename(imapAccount, "Avery Monroe");
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });
});

// ───────────────────────── POST /mail/connect/imap ─────────────────────────

describe("naming a mailbox as it is connected", () => {
  test("a name the mailbox would refuse is refused before any credential is checked", async () => {
    // A refusal at the last step would cost the person an IMAP login and a
    // rolled-back Connection; this one costs nothing.
    globalThis.fetch = (async () => {
      throw new Error("nothing should be fetched");
    }) as typeof fetch;
    const response = await call<ApiError>("POST", "/mail/connect/imap", {
      address: "ops@fastmail.com",
      password: "app-password",
      senderName: "x".repeat(101),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "A sender name can be at most 100 characters.");
    assert.equal(
      await AppDataSource.getRepository(IntegrationConnection).countBy({
        companyId: company.id,
        provider: "imap",
        label: "ops@fastmail.com",
      }),
      0,
    );
  });

  test("an oversized field is bounded by the schema", async () => {
    const response = await call<ApiError>("POST", "/mail/connect/imap", {
      address: "ops@fastmail.com",
      password: "app-password",
      senderName: "x".repeat(1001),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    assert.ok(response.body.issues?.some((issue) => issue.path?.[0] === "senderName"));
  });
});

// ───────────────────────────── createMailAccount ─────────────────────────────

describe("linking a mailbox with a sender name", () => {
  test("stores the name chosen at connect time, tidied", async () => {
    const conn = await connection(company.id, "imap");
    const linked = await createMailAccount({
      companyId: company.id,
      connectionId: conn.id,
      createdByUserId: owner.id,
      senderName: "  Avery   Monroe ",
    });
    assert.equal(linked.senderName, "Avery Monroe");
    assert.equal((await stored(linked)).senderName, "Avery Monroe");
  });

  test("without one, the mailbox sends from the bare address", async () => {
    const conn = await connection(company.id, "imap");
    const linked = await createMailAccount({
      companyId: company.id,
      connectionId: conn.id,
      createdByUserId: owner.id,
    });
    assert.equal(linked.senderName, "");
  });

  test("refuses a name for a Gmail Connection before asking Google anything", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("Google must not be asked");
    }) as typeof fetch;
    const conn = await connection(company.id, "google");
    await assert.rejects(
      createMailAccount({
        companyId: company.id,
        connectionId: conn.id,
        createdByUserId: owner.id,
        senderName: "Ops Team",
      }),
      /Send mail as/,
    );
    assert.equal(fetched, false);
  });
});
