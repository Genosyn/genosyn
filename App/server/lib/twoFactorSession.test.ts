import assert from "node:assert/strict";
import test from "node:test";

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

test("second-factor completion carries signed recent-auth evidence into the full session", () => {
  const req = request();
  const before = Date.now();
  beginTwoFactorLoginSession(req, "user-id");
  const primaryAuthenticatedAt = req.session?.primaryAuthenticatedAt;
  assert.ok(primaryAuthenticatedAt);
  completeTwoFactorLogin(req, "user-id", 7);
  assert.deepEqual(
    {
      userId: req.session?.userId,
      sessionVersion: req.session?.sessionVersion,
      authenticatedAt: req.session?.authenticatedAt,
    },
    { userId: "user-id", sessionVersion: 7, authenticatedAt: primaryAuthenticatedAt },
  );
  assert.ok((req.session?.secondFactorAt ?? 0) >= before);
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
  beginTwoFactorLoginSession(req, "new-user");
  assert.equal(req.session?.userId, undefined);
  assert.equal(req.session?.authenticatedAt, undefined);
  assert.equal(req.session?.secondFactorAt, undefined);
  assert.equal(pendingTwoFactorUserId(req), "new-user");
});

test("the cookie-local attempt ceiling still destroys a pending session", () => {
  const req = request();
  beginTwoFactorLoginSession(req, "user-id");
  for (let attempt = 1; attempt < 8; attempt += 1) {
    assert.equal(recordTwoFactorFailure(req), false);
  }
  assert.equal(recordTwoFactorFailure(req), true);
  assert.equal(req.session, null);
});
