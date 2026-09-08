import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Request, Response } from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { UserSession } from "../db/entities/UserSession.js";
import { establishUserSession, requireAuth } from "../middleware/auth.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { createUserSession, resolveUserSession, revokeCurrentUserSession } from "./userSessions.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

function member(): Promise<User> {
  return insert(User, {
    email: "sessions@example.com",
    name: "Session Member",
    passwordHash: "fixture",
    sessionVersion: 0,
  });
}

test("sign-in persists a unique identity with the configured absolute lifetime", async () => {
  const user = await member();
  const before = Date.now();
  const identity = await createUserSession(user);
  const row = await AppDataSource.getRepository(UserSession).findOneByOrFail({
    id: identity.userSessionId,
  });
  assert.equal(row.expiresAt.getTime(), identity.expiresAt);
  assert.ok(identity.expiresAt >= before + config.security.sessionMaxAgeDays * 86_400_000);
  assert.equal((await resolveUserSession(identity))?.id, user.id);
});

test("HTTP auth rejects a legacy or expired session even if the account epoch is current", async () => {
  const user = await member();
  const identity = await createUserSession(user);
  for (const session of [
    { userId: user.id, sessionVersion: user.sessionVersion },
    { ...identity, expiresAt: Date.now() - 1 },
  ]) {
    const req = { session, get: () => undefined } as unknown as Request;
    let status = 0;
    let allowed = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    await requireAuth(req, res, () => {
      allowed = true;
    });
    assert.equal(status, 401);
    assert.equal(allowed, false);
    assert.equal(req.session, null);
  }
});

test("the persisted deadline and account epoch independently revoke a session", async () => {
  const user = await member();
  const identity = await createUserSession(user);
  await AppDataSource.getRepository(UserSession).update(identity.userSessionId, {
    expiresAt: new Date(Date.now() - 1),
  });
  assert.equal(await resolveUserSession(identity), null);
  const second = await createUserSession(user);
  await AppDataSource.getRepository(User).increment({ id: user.id }, "sessionVersion", 1);
  assert.equal(await resolveUserSession(second), null);
});

test("logout revokes only the current persisted sign-in", async () => {
  const user = await member();
  const first = await createUserSession(user);
  const second = await createUserSession(user);
  const req = { session: first } as Request;
  await revokeCurrentUserSession(req);
  assert.equal(req.session, null);
  assert.equal(await resolveUserSession(first), null);
  assert.equal((await resolveUserSession(second))?.id, user.id);
});

test("re-authentication replaces the current identity without retaining the old login", async () => {
  const user = await member();
  const old = await createUserSession(user);
  const req = { session: old } as Request;
  await establishUserSession(req, user);
  assert.notEqual(req.session?.userSessionId, old.userSessionId);
  assert.equal(await resolveUserSession(old), null);
  assert.equal((await resolveUserSession(req.session))?.id, user.id);
  assert.ok(req.session?.authenticatedAt);
});
