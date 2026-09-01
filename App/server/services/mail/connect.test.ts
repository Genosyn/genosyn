import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { after, before, beforeEach, describe, mock, test, type TestContext } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { imapProvider } from "../../integrations/providers/imap.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { saveOauthApp } from "../oauthApps.js";
import {
  connectImapMailbox,
  describeMailboxConnect,
  type MailboxConnectOption,
  type MailboxConnectPlan,
} from "./connect.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/**
 * `describeMailboxConnect` calls `discoverMailbox` with no injectable deps, so
 * an address the built-in table does not know would send this file down a real
 * MX lookup, a real SRV lookup, and three real autoconfig fetches — slow, and
 * a different answer on every machine. Cutting the resolver's three network
 * edges at the source makes the fall-through to a guess deterministic and
 * keeps the suite offline.
 */
const offline = (): never => {
  throw new Error("the test suite must not touch the network");
};

before(() => {
  mock.method(dns, "resolveMx", offline);
  mock.method(dns, "resolveSrv", offline);
  // `assertSafeOutboundUrl` resolves an autoconfig host before fetching it, so
  // this is the edge that stops the HTTP rung as well as the DNS ones.
  mock.method(dns, "lookup", offline);
});

after(() => {
  mock.restoreAll();
});

type OauthOption = Extract<MailboxConnectOption, { kind: "oauth" }>;
type ImapOption = Extract<MailboxConnectOption, { kind: "imap" }>;

function oauthOption(plan: MailboxConnectPlan): OauthOption {
  const found = plan.options.find((option) => option.kind === "oauth");
  if (!found || found.kind !== "oauth") throw new Error("expected an oauth option");
  return found;
}

function imapOption(plan: MailboxConnectPlan): ImapOption {
  const found = plan.options.find((option) => option.kind === "imap");
  if (!found || found.kind !== "imap") throw new Error("expected an imap option");
  return found;
}

const GOOGLE_APP = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "top-secret",
};

// ─────────────────────── describeMailboxConnect ───────────────────────

describe("describeMailboxConnect", () => {
  test("puts the IMAP form ahead of Google when no Google app is registered here", async () => {
    const plan = await describeMailboxConnect("someone@gmail.com");

    assert.equal(plan.providerKey, "google");
    assert.equal(plan.source, "builtin");
    assert.equal(plan.options.length, 2);
    // The dialog renders the first option as its primary button. On a fresh
    // install — the one case where the person has the least patience — an
    // unregistered "Continue with Google" sitting there is a button that
    // cannot possibly work, so the app-password form has to overtake it.
    assert.equal(plan.options[0].kind, "imap");
    assert.equal(plan.options[0].ready, true);
    assert.equal(plan.options[1].kind, "oauth");

    const oauth = oauthOption(plan);
    assert.equal(oauth.ready, false);
    assert.equal(oauth.instanceApp, false);
    assert.match(oauth.blockedReason ?? "", /No Google OAuth app is registered on this install/);
    // The reason has to name the way out, not just the obstacle.
    assert.match(oauth.blockedReason ?? "", /app password/);
  });

  test("leads with Continue with Google once an admin has registered the app", async () => {
    await saveOauthApp("google", GOOGLE_APP);

    const plan = await describeMailboxConnect("someone@gmail.com");

    assert.equal(plan.options[0].kind, "oauth");
    const oauth = oauthOption(plan);
    assert.equal(oauth.ready, true);
    assert.equal(oauth.instanceApp, true);
    assert.equal(oauth.blockedReason, undefined);
    assert.equal(oauth.label, "Continue with Google");
    assert.deepEqual(oauth.scopeGroups, ["mail"]);
    // The password route stays on offer underneath: an account the shared app
    // is not allowed to cover still needs a way in.
    assert.equal(plan.options[1].kind, "imap");
    assert.equal(plan.options[1].ready, true);
  });

  test("a registered Google app does not make a Microsoft address connectable", async () => {
    // The readiness lookup is per-route-provider. Keying it on "some app is
    // registered" would light up a Microsoft button on an install that only
    // ever registered Google.
    await saveOauthApp("google", GOOGLE_APP);

    const plan = await describeMailboxConnect("someone@outlook.com");

    assert.equal(plan.providerKey, "microsoft");
    assert.equal(plan.options.length, 1);
    assert.equal(plan.options[0].kind, "imap");
  });

  test("still offers one pre-filled IMAP form for a domain nothing recognises", async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it can never resolve, so
    // discovery has no rung left but the named guess.
    const plan = await describeMailboxConnect("ops@northwind.invalid");

    assert.equal(plan.source, "guess");
    assert.equal(plan.providerKey, "custom");
    assert.equal(plan.options.length, 1);

    const imap = imapOption(plan);
    // Nothing on this route needs an admin to register anything, so it is
    // ready by construction — a guess the person can correct beats a dead end.
    assert.equal(imap.ready, true);
    assert.equal(imap.blockedReason, undefined);
    assert.deepEqual(imap.imap, { host: "imap.northwind.invalid", port: 993, secure: true });
    assert.deepEqual(imap.smtp, { host: "smtp.northwind.invalid", port: 587, secure: false });
  });

  test("offers nothing for Tuta and says why, rather than a form that must fail", async () => {
    const plan = await describeMailboxConnect("someone@tuta.com");

    assert.equal(plan.options.length, 0);
    assert.match(plan.unsupportedReason ?? "", /no IMAP or SMTP/);
  });

  test("marks every option it returns with readiness and hands on no raw routes", async () => {
    // Anything that reaches the dialog has been through the readiness pass;
    // an option without `ready` would render as an enabled button by default.
    for (const address of [
      "someone@gmail.com",
      "someone@outlook.com",
      "someone@fastmail.com",
      "ops@northwind.invalid",
    ]) {
      const plan = await describeMailboxConnect(address);
      assert.ok(plan.options.length > 0, `${address} was left with no way to connect`);
      for (const option of plan.options) {
        assert.equal(typeof option.ready, "boolean", `${address}: ${option.kind} has no readiness`);
      }
      assert.equal("routes" in plan, false, `${address} leaked the unjudged routes`);
    }
  });
});

// ──────────────────────── connectImapMailbox ────────────────────────

/**
 * `createApiKeyConnection` runs the real `imapProvider.validateApiKey`, which
 * opens an IMAP socket and an SMTP socket to whatever the form named. Every
 * test below that needs to reach *past* the credential check replaces that one
 * method for the duration of the test; the refusal test replaces it with a
 * tripwire instead, because reaching it at all is the bug.
 *
 * Swapped by hand rather than through `t.mock.method`, whose typing rejects an
 * optional method — and always restored to the value captured at load, so a
 * test that stubs twice cannot leave the second stub installed for the next
 * file-mate.
 */
type ValidateApiKey = NonNullable<typeof imapProvider.validateApiKey>;

const realValidateApiKey = imapProvider.validateApiKey;

function stubCredentialCheck(t: TestContext, implementation: ValidateApiKey): void {
  imapProvider.validateApiKey = implementation;
  t.after(() => {
    imapProvider.validateApiKey = realValidateApiKey;
  });
}

const acceptCredential: ValidateApiKey = async (input) => ({
  config: {
    address: input.address,
    password: input.password,
    imapHost: input.imapHost || "imap.fastmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: input.smtpHost || "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  accountHint: `${input.address} · 7 folders`,
});

describe("connectImapMailbox", () => {
  test("refuses an address the company already connected before it makes a Connection", async (t) => {
    const companyId = testCompanyId();
    await insert(MailAccount, {
      companyId,
      connectionId: "conn_already_here",
      provider: "imap",
      address: "ops@fastmail.com",
      status: "active",
    });

    let validated = 0;
    stubCredentialCheck(t, async () => {
      validated += 1;
      throw new Error("the credential check should never have been reached");
    });

    await assert.rejects(
      connectImapMailbox({
        companyId,
        userId: null,
        // The address comes off a form, so the duplicate check has to survive
        // the capitalisation and stray spaces a person actually types.
        input: { address: "  OPS@Fastmail.COM  ", password: "app-password" },
      }),
      /ops@fastmail\.com is already connected to this company/,
    );

    // The refusal has to land before anything is built or dialled: a second
    // attempt at a mailbox that is already here must cost the person nothing
    // and leave the install exactly as it was.
    assert.equal(validated, 0);
    assert.equal(
      await AppDataSource.getRepository(IntegrationConnection).countBy({ companyId }),
      0,
    );
  });

  test("lets a different address through the duplicate check", async (t) => {
    // The guard is scoped to one address, not to "this company has mail" — a
    // team connecting its second shared mailbox must not be turned away.
    const companyId = testCompanyId();
    await insert(MailAccount, {
      companyId,
      connectionId: "conn_already_here",
      provider: "imap",
      address: "ops@fastmail.com",
      status: "active",
    });
    stubCredentialCheck(t, acceptCredential);

    const { account } = await connectImapMailbox({
      companyId,
      userId: null,
      input: { address: "billing@fastmail.com", password: "app-password" },
    });

    assert.equal(account.address, "billing@fastmail.com");
    assert.equal(await AppDataSource.getRepository(MailAccount).countBy({ companyId }), 2);
  });

  test("deletes the Connection it just made when the mailbox will not link", async (t) => {
    const companyId = testCompanyId();
    // A credential the validator accepted but that comes back unreadable
    // stands in for the whole class of failures that can strike once the
    // Connection row exists — the database erroring, the Connection being
    // rewritten underneath the link. Which one it is does not matter; what
    // matters is that the half-built Connection does not outlive the attempt.
    stubCredentialCheck(t, async (input) => ({
      config: { address: input.address, imapHost: "imap.fastmail.com", imapPort: 993 },
      accountHint: `${input.address} · 7 folders`,
    }));

    await assert.rejects(
      connectImapMailbox({
        companyId,
        userId: null,
        input: { address: "ops@fastmail.com", password: "app-password" },
      }),
      /no password stored/,
    );

    assert.equal(
      await AppDataSource.getRepository(IntegrationConnection).countBy({ companyId }),
      0,
      "a Connection nobody can explain was left behind",
    );
    assert.equal(await AppDataSource.getRepository(MailAccount).countBy({ companyId }), 0);
    // Rolling back has to leave the address free, or one failed attempt would
    // lock the person out of the mailbox they were trying to connect.
    stubCredentialCheck(t, acceptCredential);
    const { account } = await connectImapMailbox({
      companyId,
      userId: null,
      input: { address: "ops@fastmail.com", password: "app-password" },
    });
    assert.equal(account.address, "ops@fastmail.com");
  });

  test("creates the Connection and the mailbox together from one form", async (t) => {
    const companyId = testCompanyId();
    stubCredentialCheck(t, acceptCredential);

    const { connection, account } = await connectImapMailbox({
      companyId,
      userId: "user_ops",
      input: {
        address: " OPS@Fastmail.com ",
        password: "app-password",
        imapHost: "imap.fastmail.com",
        smtpHost: "smtp.fastmail.com",
      },
    });

    assert.equal(connection.provider, "imap");
    assert.equal(connection.authMode, "apikey");
    // Labelling the Connection with the address is what makes the Integrations
    // list readable once a company has three of them.
    assert.equal(connection.label, "ops@fastmail.com");
    assert.equal(account.connectionId, connection.id);
    assert.equal(account.provider, "imap");
    // The address is read back out of the stored credential rather than taken
    // from the form, so a mailbox always carries the address it really owns.
    assert.equal(account.address, "ops@fastmail.com");
    assert.equal(account.createdByUserId, "user_ops");
    assert.equal(account.status, "active");

    const stored = await AppDataSource.getRepository(MailAccount).findOneBy({ companyId });
    assert.equal(stored?.id, account.id);
  });
});
