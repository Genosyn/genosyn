import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import cookieSession from "cookie-session";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { User } from "../db/entities/User.js";
import { UserSession } from "../db/entities/UserSession.js";
import { WebAuthnCredential } from "../db/entities/WebAuthnCredential.js";
import { requireAuth, requireBrowserSession } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { setPublicUrl } from "../services/publicUrl.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { passkeyLoginRouter } from "./passkeyLogin.js";

const ORIGIN = "https://genosyn.example.test";
const RP_ID = "genosyn.example.test";

type MutableAuthRateLimit = {
  windowMinutes: number;
  maxAttempts: number;
  blockMinutes: number;
};

const authRateLimit = config.security.authRateLimit as MutableAuthRateLimit;
const originalAuthRateLimit = structuredClone(authRateLimit);

type VirtualPasskey = {
  credentialId: string;
  privateKey: KeyObject;
  cosePublicKey: Buffer;
};

function encodeCosePublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.ok(jwk.x);
  assert.ok(jwk.y);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  assert.equal(x.length, 32);
  assert.equal(y.length, 32);
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function virtualPasskey(): VirtualPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    credentialId: randomBytes(32).toString("base64url"),
    privateKey,
    cosePublicKey: encodeCosePublicKey(publicKey),
  };
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function assertion(args: {
  passkey: VirtualPasskey;
  challenge: string;
  userId: string;
  counter?: number;
}): AuthenticationResponseJSON {
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: args.challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }),
    "utf8",
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x05]), // user present + user verified
    uint32(args.counter ?? 1),
  ]);
  const signatureBase = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest(),
  ]);
  return {
    id: args.passkey.credentialId,
    rawId: args.passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: sign("sha256", signatureBase, args.passkey.privateKey).toString("base64url"),
      userHandle: Buffer.from(args.userId, "utf8").toString("base64url"),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  } as AuthenticationResponseJSON;
}

async function memberWithPasskey() {
  const user = await insert(User, {
    email: "passkey-route@example.test",
    name: "Passkey Route Member",
    passwordHash: "not-used-by-passkey-authentication",
    emailVerifiedAt: new Date(),
    sessionVersion: 3,
  });
  const passkey = virtualPasskey();
  const credential = await insert(WebAuthnCredential, {
    userId: user.id,
    credentialId: passkey.credentialId,
    publicKey: passkey.cosePublicKey.toString("base64url"),
    counter: 0,
    transports: JSON.stringify(["internal"]),
    kind: "passkey",
    name: "Route passkey",
    deviceType: "singleDevice",
    backedUp: false,
    lastUsedAt: null,
  });
  return { user, passkey, credential };
}

type OptionsBody = {
  options: { challenge: string; allowCredentials?: unknown };
  flowToken: string;
  error?: string;
};

type HttpResult<T = Record<string, unknown>> = {
  status: number;
  body: T;
  cookie: string;
};

let server: Server;
let baseUrl: string;

/** Keep both signed cookie-session cookies together across real HTTP calls. */
function nextCookie(response: Response, previous = ""): string {
  const values = response.headers.getSetCookie();
  if (values.length === 0) return previous;
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    cookie: nextCookie(response, options.cookie),
  };
}

async function options(cookie = ""): Promise<HttpResult<OptionsBody>> {
  return call<OptionsBody>("POST", "/api/auth/login/passkey/options", {
    body: {},
    cookie,
  });
}

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({
      name: "genosyn.sid",
      keys: ["passkey-route-test-signing-key-that-is-long-enough"],
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    }),
  );
  app.use("/api/auth", passkeyLoginRouter);
  app.get("/api/session-probe", requireAuth, requireBrowserSession, (req, res) => {
    res.json({
      userId: req.user!.id,
      sessionVersion: req.session?.sessionVersion,
      userSessionId: req.session?.userSessionId,
      authenticatedAt: req.session?.authenticatedAt,
      secondFactorAt: req.session?.secondFactorAt,
      twoFactorUserId: req.session?.twoFactorUserId ?? null,
      passkeyBrowserBinding: req.session?.passkeyBrowserBinding ?? null,
    });
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  await setPublicUrl(ORIGIN);
  Object.assign(authRateLimit, originalAuthRateLimit);
});

after(async () => {
  Object.assign(authRateLimit, originalAuthRateLimit);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

describe("passwordless passkey HTTP flow", () => {
  test("turns a signed pre-auth cookie and real assertion into a full persisted 2FA session", async () => {
    const { user, passkey } = await memberWithPasskey();
    const started = await options();
    assert.equal(started.status, 200);
    assert.equal(started.body.options.allowCredentials, undefined);
    assert.ok(started.body.flowToken);
    assert.match(started.cookie, /genosyn\.sid=/);
    assert.match(started.cookie, /genosyn\.sid\.sig=/);
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 0);
    const preAuthCookie = started.cookie;
    const response = assertion({
      passkey,
      challenge: started.body.options.challenge,
      userId: user.id,
      counter: 1,
    });

    const verified = await call<{ id: string; email: string }>(
      "POST",
      "/api/auth/login/passkey/verify",
      {
        cookie: preAuthCookie,
        body: { flowToken: started.body.flowToken, response },
      },
    );
    assert.equal(verified.status, 200);
    assert.equal(verified.body.id, user.id);
    assert.equal(verified.body.email, user.email);

    const probe = await call<{
      userId: string;
      sessionVersion: number;
      userSessionId: string;
      authenticatedAt: number;
      secondFactorAt: number;
      twoFactorUserId: null;
      passkeyBrowserBinding: string;
    }>("GET", "/api/session-probe", { cookie: verified.cookie });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.userId, user.id);
    assert.equal(probe.body.sessionVersion, user.sessionVersion);
    assert.ok(probe.body.userSessionId);
    assert.ok(probe.body.authenticatedAt > 0);
    assert.equal(probe.body.secondFactorAt, probe.body.authenticatedAt);
    assert.equal(probe.body.twoFactorUserId, null);
    assert.ok(probe.body.passkeyBrowserBinding);

    const sessions = await AppDataSource.getRepository(UserSession).find();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, probe.body.userSessionId);
    assert.equal(sessions[0].userId, user.id);
    assert.equal(sessions[0].sessionVersion, user.sessionVersion);

    // The exact old cookie, state, and signed assertion cannot mint a second session.
    const replay = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: preAuthCookie,
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(replay.status, 400);
    assert.match(String(replay.body.error), /expired|another browser/i);
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 1);
  });

  test("binds state to the initiating browser and burns it on a cross-browser attempt", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const started = await options();
    const response = assertion({
      passkey,
      challenge: started.body.options.challenge,
      userId: user.id,
    });

    const wrongBrowser = await call("POST", "/api/auth/login/passkey/verify", {
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(wrongBrowser.status, 400);

    const retryInRightBrowser = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: started.cookie,
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(retryInRightBrowser.status, 400);
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 0);
    const stored = await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
      id: credential.id,
    });
    assert.equal(stored.counter, 0);
    assert.equal(stored.lastUsedAt, null);
  });

  test("allows exactly one simultaneous HTTP consumer of a flow token", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const started = await options();
    const body = {
      flowToken: started.body.flowToken,
      response: assertion({
        passkey,
        challenge: started.body.options.challenge,
        userId: user.id,
        counter: 1,
      }),
    };

    const results = await Promise.all([
      call("POST", "/api/auth/login/passkey/verify", { cookie: started.cookie, body }),
      call("POST", "/api/auth/login/passkey/verify", { cookie: started.cookie, body }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort((a, b) => a - b),
      [200, 400],
    );
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 1);
    assert.equal(
      (
        await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
          id: credential.id,
        })
      ).counter,
      1,
    );
  });

  test("allows two tabs in one browser to complete independently", async () => {
    const { user, passkey } = await memberWithPasskey();
    const first = await options();
    const second = await options(first.cookie);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const firstVerified = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: second.cookie,
      body: {
        flowToken: first.body.flowToken,
        response: assertion({
          passkey,
          challenge: first.body.options.challenge,
          userId: user.id,
          counter: 1,
        }),
      },
    });
    assert.equal(firstVerified.status, 200);

    const secondVerified = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: firstVerified.cookie,
      body: {
        flowToken: second.body.flowToken,
        response: assertion({
          passkey,
          challenge: second.body.options.challenge,
          userId: user.id,
          counter: 2,
        }),
      },
    });
    assert.equal(secondVerified.status, 200);
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 1);
  });

  test("rejects malformed assertions at the Zod boundary without consuming a valid ceremony", async () => {
    const { user, passkey } = await memberWithPasskey();
    const started = await options();

    const malformed = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: started.cookie,
      body: {
        flowToken: started.body.flowToken,
        response: { id: passkey.credentialId, type: "public-key" },
      },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "ValidationError");

    const response = assertion({
      passkey,
      challenge: started.body.options.challenge,
      userId: user.id,
    });
    const validRetry = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: started.cookie,
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(validRetry.status, 200);
  });

  test("returns a generic failure for an unknown credential and consumes its state", async () => {
    const unknown = virtualPasskey();
    const started = await options();
    const response = assertion({
      passkey: unknown,
      challenge: started.body.options.challenge,
      userId: "unknown-user",
    });

    const rejected = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: started.cookie,
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error, "The passkey could not be verified");
    assert.equal(await AppDataSource.getRepository(UserSession).count(), 0);

    const replay = await call("POST", "/api/auth/login/passkey/verify", {
      cookie: started.cookie,
      body: { flowToken: started.body.flowToken, response },
    });
    assert.equal(replay.status, 400);
  });

  test("limits challenge issuance even when no assertion is submitted", async () => {
    authRateLimit.maxAttempts = 2;
    try {
      assert.equal((await options()).status, 200);
      assert.equal((await options()).status, 200);

      const blocked = await options();
      assert.equal(blocked.status, 429);
      assert.match(String(blocked.body.error), /too many attempts/i);
      const rows = await AppDataSource.getRepository(AuthRateLimit).find();
      assert.equal(rows.length, 1, "challenge issuance is limited by IP");
      assert.ok(rows[0].blockedUntil && rows[0].blockedUntil > new Date());
    } finally {
      Object.assign(authRateLimit, originalAuthRateLimit);
    }
  });

  test("admits only the configured number of concurrent challenge writes", async () => {
    authRateLimit.maxAttempts = 3;
    try {
      const results = await Promise.all(Array.from({ length: 16 }, () => options()));
      assert.equal(results.filter((result) => result.status === 200).length, 3);
      assert.equal(results.filter((result) => result.status === 429).length, 13);
      assert.equal(
        await AppDataSource.getRepository(AuthFlowState).count(),
        3,
        "only requests holding an issuance permit may persist ceremony state",
      );
    } finally {
      Object.assign(authRateLimit, originalAuthRateLimit);
    }
  });

  test("persists passkey failures by IP and credential and blocks fresh ceremonies", async () => {
    const unknown = virtualPasskey();
    authRateLimit.maxAttempts = 2;
    try {
      let cookie = "";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = await options(cookie);
        assert.equal(started.status, 200);
        cookie = started.cookie;
        const response = assertion({
          passkey: unknown,
          challenge: started.body.options.challenge,
          userId: "unknown-user",
          counter: attempt + 1,
        });
        const rejected = await call("POST", "/api/auth/login/passkey/verify", {
          cookie,
          body: { flowToken: started.body.flowToken, response },
        });
        assert.equal(rejected.status, 401);
        cookie = rejected.cookie;
      }

      const blocked = await options(cookie);
      assert.equal(blocked.status, 429);
      assert.match(String(blocked.body.error), /too many attempts/i);
      const rows = await AppDataSource.getRepository(AuthRateLimit).find();
      assert.equal(
        rows.length,
        3,
        "issuance, assertion IP, and opaque credential id have separate counters",
      );
      assert.ok(rows.every((row) => row.attempts === 2));
      assert.ok(rows.every((row) => row.blockedUntil && row.blockedUntil > new Date()));
    } finally {
      Object.assign(authRateLimit, originalAuthRateLimit);
    }
  });
});
