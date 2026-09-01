import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import bcrypt from "bcrypt";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { User } from "../db/entities/User.js";
import { hashApiToken, requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import {
  GLOBAL_SMTP_SETTING_KEY,
  resetGlobalSmtpCacheForTests,
} from "../services/globalEmailTransport.js";
import { hashEmailVerificationToken } from "../services/emailVerification.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { authRouter } from "./auth.js";

/**
 * Account → Profile's "Resend verification email" button, end to end.
 *
 * The bug this suite exists for: `requireMasterAdmin` refuses an unverified
 * operator on *every* install, but `emailVerificationRequired()` — which raises
 * the full-page gate that used to own the only Resend button in the app — is
 * true in shared SaaS mode alone. A self-hosted operator was therefore told to
 * verify an email with nothing anywhere to click, and the endpoint that could
 * have helped answered a flat `{ ok: true }` even when the install had no mail
 * transport and the link had gone to the server log instead of a mailbox.
 *
 * So the assertions below care about two things: that the button's endpoint
 * reports what actually happened to the mail, and that following the link it
 * produces really does open instance administration.
 */

type MutableSecurityConfig = {
  multiTenant: boolean;
  bootstrapMasterAdminEmail: string;
  authRateLimit: {
    windowMinutes: number;
    maxAttempts: number;
    blockMinutes: number;
  };
};

const security = config.security as unknown as MutableSecurityConfig;
const originalSecurity = structuredClone(security);

let server: Server;
let baseUrl: string;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  // Same signed-session shim the sibling auth suite uses: rebuild the session
  // from headers on every request so no test can lean on cookie state left
  // behind by the one before it.
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: Number(req.header("x-test-session-version") ?? "0") }
      : {};
    next();
  });
  app.use("/api/auth", authRouter);
  // Stands in for the whole Admin router: the one middleware pair that emits
  // "Verify your email before using instance administration".
  app.get("/api/operator-probe", requireAuth, requireMasterAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(security, originalSecurity);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  security.multiTenant = false;
  security.bootstrapMasterAdminEmail = "";
  Object.assign(security.authRateLimit, originalSecurity.authRateLimit);
  // `resetTestDb` drops the AppSetting row but not the module-level cache in
  // front of it, and a stale "configured" transport would make the console
  // fallback untestable.
  resetGlobalSmtpCacheForTests();
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T; headers: Headers };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; userId?: string; bearer?: string; sessionVersion?: number } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.userId) headers["x-test-user"] = options.userId;
  if (options.sessionVersion !== undefined) {
    headers["x-test-session-version"] = String(options.sessionVersion);
  }
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

async function createUser(over: Partial<User> = {}): Promise<User> {
  return insert(User, {
    email: `person-${randomUUID()}@example.com`,
    name: "Person",
    passwordHash: await bcrypt.hash("correct horse battery staple", 4),
    isMasterAdmin: false,
    emailVerifiedAt: null,
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    sessionVersion: 0,
    ...over,
  });
}

async function reload(user: User): Promise<User> {
  return AppDataSource.getRepository(User).findOneByOrFail({ id: user.id });
}

async function verificationLogs(userId: string): Promise<EmailLog[]> {
  return AppDataSource.getRepository(EmailLog).findBy({
    purpose: "email_verification",
    triggeredByUserId: userId,
  });
}

/**
 * Run `fn` with `console.log` captured, and hand back everything it printed.
 *
 * With no transport configured `sendEmail` writes the message body — link and
 * all — to the console so an operator can copy it out of `genosyn logs`. That
 * console line is the documented way to claim a fresh install, so the tests
 * that follow the link read it the same way a human would.
 */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  // eslint-disable-next-line no-console
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const value = await fn();
    return { value, output: lines.join("\n") };
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

/** Pull the single-use token out of a `/verify-email/<token>` link. */
function tokenFromConsole(output: string): string {
  const match = output.match(/\/verify-email\/([A-Za-z0-9_-]+)/);
  assert.ok(match, `no verification link in console output: ${output}`);
  return match[1];
}

/** Point the install-wide transport at a port nothing is listening on. */
async function configureUnreachableSmtp(): Promise<void> {
  const repo = AppDataSource.getRepository(AppSetting);
  await repo.save(
    repo.create({
      key: GLOBAL_SMTP_SETTING_KEY,
      value: JSON.stringify({
        host: "127.0.0.1",
        // Port 1 refuses immediately on loopback, so this stays a fast unit
        // test rather than a connect timeout.
        port: 1,
        secure: false,
        user: "",
        encryptedPass: "",
        fromName: "Genosyn",
        from: "no-reply@genosyn.test",
      }),
    }),
  );
  resetGlobalSmtpCacheForTests();
}

describe("resend verification — what the button reports", () => {
  test("says the link was only logged when the install has no mail transport", async () => {
    const user = await createUser();

    const { value: response, output } = await captureConsole(() =>
      call<{ ok: boolean; delivery: string }>("POST", "/api/auth/resend-verification", {
        userId: user.id,
        body: {},
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    // The whole point: not "sent". Nothing left the process.
    assert.equal(response.body.delivery, "skipped");
    assert.match(output, /\[email:skipped\]/);
    assert.match(output, /\/verify-email\//);

    const logs = await verificationLogs(user.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].transport, "console");
    assert.equal(logs[0].status, "skipped");
    assert.equal(logs[0].toAddress, user.email);
  });

  test("says the send failed when the mail server refuses it", async () => {
    const user = await createUser();
    await configureUnreachableSmtp();

    const response = await call<{ delivery: string }>("POST", "/api/auth/resend-verification", {
      userId: user.id,
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.delivery, "failed");
    const logs = await verificationLogs(user.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "failed");
    assert.ok(logs[0].errorMessage.length > 0);
  });

  test("never returns the transport error, which names install-wide settings", async () => {
    const user = await createUser();
    await configureUnreachableSmtp();

    const response = await call("POST", "/api/auth/resend-verification", {
      userId: user.id,
      body: {},
    });

    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("127.0.0.1"), false);
    assert.equal(serialized.includes("ECONNREFUSED"), false);
    assert.deepEqual(Object.keys(response.body).sort(), ["delivery", "ok"]);
  });

  test("redacts the link from the stored email preview", async () => {
    const user = await createUser();
    await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );

    const logs = await verificationLogs(user.id);
    assert.doesNotMatch(logs[0].bodyPreview, /https?:\/\//);
    assert.doesNotMatch(logs[0].bodyPreview, /verify-email/);
  });
});

describe("resend verification — token lifecycle", () => {
  test("issues a token with a 24-hour life", async () => {
    const user = await createUser();
    const before = Date.now();

    await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );

    const stored = await reload(user);
    assert.ok(stored.emailVerificationTokenHash);
    assert.ok(stored.emailVerificationExpiresAt);
    const ttl = stored.emailVerificationExpiresAt.getTime() - before;
    assert.ok(ttl > 23 * 60 * 60_000, `ttl too short: ${ttl}ms`);
    assert.ok(ttl <= 24 * 60 * 60_000 + 5_000, `ttl too long: ${ttl}ms`);
  });

  test("rotates the token, so the link from an earlier email stops working", async () => {
    const user = await createUser({
      emailVerificationTokenHash: hashEmailVerificationToken("first-link"),
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    });

    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );

    const rotated = await reload(user);
    assert.notEqual(rotated.emailVerificationTokenHash, hashEmailVerificationToken("first-link"));
    assert.equal(
      (await call("POST", "/api/auth/verify-email", { body: { token: "first-link" } })).status,
      400,
    );
    // The newest link is the one that works.
    assert.equal(
      (
        await call("POST", "/api/auth/verify-email", {
          body: { token: tokenFromConsole(output) },
        })
      ).status,
      200,
    );
  });

  test("burns the token, so the same link cannot be replayed", async () => {
    const user = await createUser();
    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );
    const token = tokenFromConsole(output);

    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token } })).status, 200);
    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token } })).status, 400);
    assert.equal((await reload(user)).emailVerificationTokenHash, null);
  });

  test("refuses an expired link", async () => {
    const user = await createUser();
    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );
    const token = tokenFromConsole(output);

    const stale = await reload(user);
    stale.emailVerificationExpiresAt = new Date(Date.now() - 1_000);
    await AppDataSource.getRepository(User).save(stale);

    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token } })).status, 400);
    assert.equal((await reload(user)).emailVerifiedAt, null);
  });

  test("does nothing at all once the address is verified", async () => {
    const verifiedAt = new Date(Date.now() - 60_000);
    const user = await createUser({ emailVerifiedAt: verifiedAt });

    const response = await call<{ delivery: string }>("POST", "/api/auth/resend-verification", {
      userId: user.id,
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.delivery, "already_verified");
    assert.equal((await verificationLogs(user.id)).length, 0);
    const untouched = await reload(user);
    assert.equal(untouched.emailVerificationTokenHash, null);
    assert.equal(untouched.emailVerifiedAt?.getTime(), verifiedAt.getTime());
    // The early return sits in front of the throttle, so a verified account
    // clicking a stale page cannot spend anyone's budget.
    assert.equal(await AppDataSource.getRepository(AuthRateLimit).count(), 0);
  });

  test("a verified address stays verified when a stray old link is opened", async () => {
    const user = await createUser({
      emailVerificationTokenHash: hashEmailVerificationToken("stale-link"),
      emailVerificationExpiresAt: new Date(Date.now() - 1_000),
      emailVerifiedAt: new Date(Date.now() - 60_000),
    });

    assert.equal(
      (await call("POST", "/api/auth/verify-email", { body: { token: "stale-link" } })).status,
      400,
    );
    assert.ok((await reload(user)).emailVerifiedAt);
  });
});

describe("resend verification — who may ask", () => {
  test("turns away a caller with no session", async () => {
    const response = await call("POST", "/api/auth/resend-verification", { body: {} });
    assert.equal(response.status, 401);
    assert.equal((await AppDataSource.getRepository(EmailLog).count()), 0);
  });

  test("turns away an API key, because a bearer token proves no mailbox", async () => {
    const user = await createUser();
    const body = "A".repeat(43);
    await insert(ApiKey, {
      userId: user.id,
      companyId: `co_${randomUUID()}`,
      name: "automation",
      prefix: body.slice(0, 8),
      tokenHash: hashApiToken(body),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });

    const response = await call<{ error: string }>("POST", "/api/auth/resend-verification", {
      bearer: `gen_${body}`,
      body: {},
    });

    // 401, not the 403 `requireBrowserSession` would give: a key only
    // authenticates under the `/api/companies/:cid` mount it was minted for, so
    // on an account route it never becomes a caller in the first place. The
    // route keeps `requireBrowserSession` behind that anyway — see the
    // following test, which proves a key cannot mail anyone even so.
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "Unauthorized");
    assert.equal((await verificationLogs(user.id)).length, 0);
    assert.equal((await reload(user)).emailVerificationTokenHash, null);
  });

  test("turns away a cookie minted before the session version moved on", async () => {
    const user = await createUser({ sessionVersion: 2 });

    const response = await call("POST", "/api/auth/resend-verification", {
      userId: user.id,
      sessionVersion: 0,
      body: {},
    });

    assert.equal(response.status, 401);
    assert.equal((await verificationLogs(user.id)).length, 0);
  });

  test("mails the signed-in account, never an address named by the caller", async () => {
    const user = await createUser();
    const victim = await createUser({ email: "victim@example.com" });

    await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", {
        userId: user.id,
        body: { email: victim.email, to: victim.email },
      }),
    );

    const logs = await AppDataSource.getRepository(EmailLog).find();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].toAddress, user.email);
    assert.equal((await reload(victim)).emailVerificationTokenHash, null);
  });
});

describe("resend verification — throttling", () => {
  test("counts every successful resend, then answers 429 with Retry-After", async () => {
    security.authRateLimit.maxAttempts = 3;
    security.authRateLimit.windowMinutes = 15;
    security.authRateLimit.blockMinutes = 15;
    const user = await createUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ok = await captureConsole(() =>
        call<{ delivery: string }>("POST", "/api/auth/resend-verification", {
          userId: user.id,
          body: {},
        }),
      );
      assert.equal(ok.value.status, 200, `attempt ${attempt} should still be allowed`);
      assert.equal(ok.value.body.delivery, "skipped");
    }

    const blocked = await call<{ error: string }>("POST", "/api/auth/resend-verification", {
      userId: user.id,
      body: {},
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many attempts/);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter > 0, `expected a positive Retry-After, got ${retryAfter}`);
    assert.ok(retryAfter <= 15 * 60);
    // A blocked attempt must not have burned a fresh token either.
    assert.equal((await verificationLogs(user.id)).length, 3);

    // Two buckets, not one: the caller's IP and the account's address. A shared
    // NAT must not be the only thing standing between one address and an
    // unbounded mail loop.
    const buckets = await AppDataSource.getRepository(AuthRateLimit).find();
    assert.equal(buckets.length, 2);
    for (const bucket of buckets) {
      assert.ok(bucket.blockedUntil && bucket.blockedUntil > new Date());
    }
  });

  test("a blocked resend does not rotate the token a working link is using", async () => {
    security.authRateLimit.maxAttempts = 1;
    const user = await createUser();

    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );
    const token = tokenFromConsole(output);
    const hashAfterFirst = (await reload(user)).emailVerificationTokenHash;

    assert.equal(
      (await call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} })).status,
      429,
    );
    assert.equal((await reload(user)).emailVerificationTokenHash, hashAfterFirst);
    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token } })).status, 200);
  });
});

describe("the operator who could not get in", () => {
  test("an unverified master admin is refused, resends, follows the log link, and is let in", async () => {
    const operator = await createUser({ email: "operator@example.com", isMasterAdmin: true });

    // 1. The message the person actually saw, on a self-hosted install.
    const refused = await call<{ error: string }>("GET", "/api/operator-probe", {
      userId: operator.id,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "Verify your email before using instance administration");

    // 2. The button Account → Profile now offers them.
    const { value: resent, output } = await captureConsole(() =>
      call<{ delivery: string }>("POST", "/api/auth/resend-verification", {
        userId: operator.id,
        body: {},
      }),
    );
    assert.equal(resent.status, 200);
    assert.equal(resent.body.delivery, "skipped");

    // 3. The link, read out of the server log exactly as the docs describe.
    assert.equal(
      (
        await call("POST", "/api/auth/verify-email", { body: { token: tokenFromConsole(output) } })
      ).status,
      200,
    );

    // 4. Instance administration opens, and the session that was already
    //    signed in still works — an operator who is already a master admin is
    //    not re-issued a session by verifying.
    const stored = await reload(operator);
    assert.ok(stored.emailVerifiedAt);
    assert.equal(stored.sessionVersion, 0);
    assert.equal((await call("GET", "/api/operator-probe", { userId: operator.id })).status, 200);
  });

  test("verifying the bootstrap mailbox claims the instance and re-issues the session", async () => {
    security.bootstrapMasterAdminEmail = "operator@example.com";
    const candidate = await createUser({ email: "operator@example.com" });

    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: candidate.id, body: {} }),
    );
    assert.equal(
      (
        await call("POST", "/api/auth/verify-email", { body: { token: tokenFromConsole(output) } })
      ).status,
      200,
    );

    const claimed = await reload(candidate);
    assert.equal(claimed.isMasterAdmin, true);
    // The cookie minted while the account was unverified must not inherit
    // operator authority — the version bump is what invalidates it.
    assert.equal(claimed.sessionVersion, 1);
    assert.equal(
      (await call("GET", "/api/operator-probe", { userId: candidate.id, sessionVersion: 0 })).status,
      401,
    );
    assert.equal(
      (await call("GET", "/api/operator-probe", { userId: candidate.id, sessionVersion: 1 })).status,
      200,
    );
  });

  test("the profile page is told the truth about its own address", async () => {
    const user = await createUser();

    const unverified = await call<{ emailVerified: boolean; emailVerificationRequired: boolean }>(
      "GET",
      "/api/auth/me",
      { userId: user.id },
    );
    assert.equal(unverified.body.emailVerified, false);
    // Single-tenant: the full-page gate stays down, which is exactly why the
    // profile page has to carry the indicator itself.
    assert.equal(unverified.body.emailVerificationRequired, false);

    const { output } = await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );
    await call("POST", "/api/auth/verify-email", { body: { token: tokenFromConsole(output) } });

    const verified = await call<{ emailVerified: boolean }>("GET", "/api/auth/me", {
      userId: user.id,
    });
    assert.equal(verified.body.emailVerified, true);
  });

  test("shared SaaS still raises the full-page gate as well", async () => {
    security.multiTenant = true;
    const user = await createUser();

    const me = await call<{ emailVerificationRequired: boolean }>("GET", "/api/auth/me", {
      userId: user.id,
    });
    assert.equal(me.body.emailVerificationRequired, true);
  });

  test("the button behaves the same in either tenancy mode", async () => {
    for (const multiTenant of [false, true]) {
      await resetTestDb();
      resetGlobalSmtpCacheForTests();
      security.multiTenant = multiTenant;
      const user = await createUser();

      const { value } = await captureConsole(() =>
        call<{ delivery: string }>("POST", "/api/auth/resend-verification", {
          userId: user.id,
          body: {},
        }),
      );

      assert.equal(value.status, 200, `multiTenant=${multiTenant}`);
      // The surface must not be coupled to `emailVerificationRequired`, which
      // was the whole reason the self-hosted operator had nothing to click.
      assert.equal(value.body.delivery, "skipped", `multiTenant=${multiTenant}`);
    }
  });
});

describe("resend verification — while an email change is pending", () => {
  test("mails the address on the account, not the unconfirmed new one", async () => {
    const user = await createUser({ email: "old@example.com" });

    const requested = await call<{ pendingEmail: string }>("PATCH", "/api/auth/me", {
      userId: user.id,
      body: { email: "new@example.com", currentPassword: "correct horse battery staple" },
    });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.pendingEmail, "new@example.com");

    await captureConsole(() =>
      call("POST", "/api/auth/resend-verification", { userId: user.id, body: {} }),
    );

    // Two verification-purpose sends now exist: the change confirmation to the
    // new mailbox, and this resend. The resend must go to the address the
    // account still has — mailing the unconfirmed one would let an unverified
    // account prove an address it has not yet been granted.
    const logs = await verificationLogs(user.id);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      logs.map((log) => log.toAddress).sort(),
      ["new@example.com", "old@example.com"],
    );
    const latest = logs[logs.length - 1];
    assert.equal(latest.toAddress, "old@example.com");
    assert.equal((await reload(user)).email, "old@example.com");
  });
});
