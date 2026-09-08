import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { TotpCredential } from "../db/entities/TotpCredential.js";
import { User } from "../db/entities/User.js";
import { requireTwoFactorAfterPrimaryAuth } from "../routes/twoFactor.js";
import { createUserSession, resolveUserSession } from "../services/userSessions.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";

before(initTestDb);
after(closeTestDb);

import type { Request } from "express";
import {
  beginTwoFactorLoginSession,
  completeTwoFactorLogin,
  pendingTwoFactorUserId,
  recordTwoFactorFailure,
} from "./twoFactorSession.js";

function request(): Request {
  return { session: {} } as Request;
}

test("second-factor completion carries signed recent-auth evidence into the full session", async () => {
  const req = request();
  const before = Date.now();
  beginTwoFactorLoginSession(req, "user-id", 7);
  const primaryAuthenticatedAt = req.session?.primaryAuthenticatedAt;
  assert.ok(primaryAuthenticatedAt);
  await completeTwoFactorLogin(req, "user-id", 7);
  assert.deepEqual(
    {
      userId: req.session?.userId,
      sessionVersion: req.session?.sessionVersion,
      authenticatedAt: req.session?.authenticatedAt,
    },
    { userId: "user-id", sessionVersion: 7, authenticatedAt: primaryAuthenticatedAt },
  );
  assert.ok((req.session?.secondFactorAt ?? 0) >= before);
  assert.ok(req.session?.userSessionId);
  assert.ok((req.session?.expiresAt ?? 0) > before);
  assert.equal(req.session?.twoFactorUserId, undefined);
});

test("replacement pending sessions do not retain full-login or factor evidence", () => {
  const req = request();
  req.session = {
    userId: "old-user",
    sessionVersion: 1,
    authenticatedAt: Date.now(),
    secondFactorAt: Date.now(),
  };
  beginTwoFactorLoginSession(req, "new-user", 1);
  assert.equal(req.session?.userId, undefined);
  assert.equal(req.session?.authenticatedAt, undefined);
  assert.equal(req.session?.secondFactorAt, undefined);
  assert.equal(pendingTwoFactorUserId(req), "new-user");
});

test("starting a second-factor challenge revokes the previous browser sign-in", async () => {
  const user = await insert(User, {
    email: "mfa-transition@example.com",
    name: "MFA Member",
    passwordHash: "fixture",
    sessionVersion: 2,
  });
  await insert(TotpCredential, {
    userId: user.id,
    name: "Fixture authenticator",
    secret: "fixture-not-used-to-verify-a-code",
    verifiedAt: new Date(),
  });
  const previous = await createUserSession(user);
  const req = { session: previous } as Request;

  const methods = await requireTwoFactorAfterPrimaryAuth(req, user);

  assert.equal(methods.enabled, true);
  assert.equal(await resolveUserSession(previous), null);
  assert.equal(req.session?.userId, undefined);
  assert.equal(req.session?.userSessionId, undefined);
  assert.equal(req.session?.twoFactorUserId, user.id);
  assert.equal(req.session?.twoFactorSessionVersion, user.sessionVersion);
});

test("the cookie-local attempt ceiling still destroys a pending session", () => {
  const req = request();
  beginTwoFactorLoginSession(req, "user-id", 0);
  for (let attempt = 1; attempt < 8; attempt += 1) {
    assert.equal(recordTwoFactorFailure(req), false);
  }
  assert.equal(recordTwoFactorFailure(req), true);
  assert.equal(req.session, null);
});
