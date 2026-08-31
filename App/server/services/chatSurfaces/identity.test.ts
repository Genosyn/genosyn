import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { hashToken } from "../../lib/token.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import {
  BIND_LINK_TTL_MS,
  bindIdentity,
  deleteIdentitiesForConnection,
  listIdentities,
  mintBindLink,
  previewBind,
  recordSighting,
  resolveBoundRequester,
  unbindIdentity,
} from "./identity.js";

/**
 * The authority boundary for external chat.
 *
 * Every assertion here is really one question asked from a different angle:
 * can somebody who is not a Member of this company end up holding a Member's
 * authority? The interesting cases are not the happy path — they are the
 * revoked Membership, the replayed link, the identity bound to somebody else,
 * and the token that is checked against the wrong company.
 */

let companyId: string;
let otherCompanyId: string;
let connectionId: string;
let user: User;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  otherCompanyId = testCompanyId();
  connectionId = testId("conn");
  user = await insert(User, {
    email: "mia@example.com",
    passwordHash: "x",
    name: "Mia Member",
    sessionVersion: 1,
  });
  await insert(Membership, { companyId, userId: user.id, role: "member" });
});

async function sighting(overrides: Partial<Parameters<typeof recordSighting>[0]> = {}) {
  return recordSighting({
    companyId,
    provider: "slack",
    connectionId,
    externalUserId: "U0001",
    externalUserLabel: "mia",
    ...overrides,
  });
}

describe("recordSighting", () => {
  test("creates a pending row on first contact", async () => {
    const identity = await sighting();
    assert.equal(identity.companyId, companyId);
    assert.equal(identity.provider, "slack");
    assert.equal(identity.externalUserId, "U0001");
    assert.equal(identity.externalUserLabel, "mia");
    assert.equal(identity.userId, null, "a first sighting must never be bound");
    assert.equal(identity.boundAt, null);
    assert.equal(identity.boundVia, null);
    assert.equal(identity.linkTokenHash, null);
    assert.ok(identity.lastSeenAt instanceof Date);
  });

  test("is idempotent on (connection, external user) and refreshes the label", async () => {
    const first = await sighting();
    const second = await sighting({ externalUserLabel: "mia.renamed" });
    assert.equal(second.id, first.id);
    assert.equal(second.externalUserLabel, "mia.renamed");
    const rows = await AppDataSource.getRepository(ExternalChatIdentity).find();
    assert.equal(rows.length, 1);
  });

  test("keeps the old label when the surface reports nothing", async () => {
    await sighting();
    const again = await sighting({ externalUserLabel: null });
    assert.equal(again.externalUserLabel, "mia");
  });

  test("the same person on two Connections is two separate bindings", async () => {
    const a = await sighting();
    const b = await sighting({ connectionId: testId("conn") });
    assert.notEqual(a.id, b.id);
  });

  test("a company drift drops the binding rather than re-pointing authority", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    const moved = await sighting({ companyId: otherCompanyId });
    assert.equal(moved.id, identity.id);
    assert.equal(moved.companyId, otherCompanyId);
    assert.equal(moved.userId, null, "authority must not survive a company change");
    assert.equal(moved.boundAt, null);
  });

  test("advances lastSeenAt", async () => {
    const first = await sighting();
    const before = first.lastSeenAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const second = await sighting();
    assert.ok(second.lastSeenAt!.getTime() >= before);
  });
});

/** Bind without going through the token, for fixtures that are about something else. */
async function bindTo(identityId: string, userId: string): Promise<void> {
  const repo = AppDataSource.getRepository(ExternalChatIdentity);
  const row = await repo.findOneByOrFail({ id: identityId });
  row.userId = userId;
  row.boundAt = new Date();
  row.boundVia = "link";
  const bound = await AppDataSource.getRepository(User).findOneByOrFail({ id: userId });
  row.boundSessionVersion = bound.sessionVersion;
  await repo.save(row);
}

describe("resolveBoundRequester", () => {
  test("returns nothing for a sender who has never bound", async () => {
    const identity = await sighting();
    assert.equal(await resolveBoundRequester(identity), null);
  });

  test("returns the Member and their live auth epoch", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    const requester = await resolveBoundRequester(fresh);
    assert.deepEqual(requester, { userId: user.id, sessionVersion: 1 });
  });

  test("a moved auth epoch revokes the binding — sign-out-everywhere reaches here", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    await AppDataSource.getRepository(User).update({ id: user.id }, { sessionVersion: 7 });
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(await resolveBoundRequester(fresh), null);
  });

  test("a row with no recorded epoch is not trusted", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    await AppDataSource.getRepository(ExternalChatIdentity).update(
      { id: identity.id },
      { boundSessionVersion: null },
    );
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(await resolveBoundRequester(fresh), null);
  });

  test("a removed Membership revokes the binding on the very next turn", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    await AppDataSource.getRepository(Membership).delete({ companyId, userId: user.id });
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(await resolveBoundRequester(fresh), null);
  });

  test("a Membership in a different company does not count", async () => {
    const identity = await sighting({ companyId: otherCompanyId });
    await bindTo(identity.id, user.id);
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(await resolveBoundRequester(fresh), null);
  });

  test("a deleted User revokes the binding", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    await AppDataSource.getRepository(User).delete({ id: user.id });
    const fresh = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(await resolveBoundRequester(fresh), null);
  });
});

describe("mintBindLink", () => {
  test("stores only the hash and returns a URL carrying the clear token", async () => {
    const identity = await sighting();
    const url = await mintBindLink(identity);
    const stored = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    const token = url.split("/").pop()!;
    assert.ok(url.includes(`/link-chat/${identity.id}/`));
    assert.ok(token.length >= 32);
    assert.equal(stored.linkTokenHash, hashToken(token));
    assert.notEqual(stored.linkTokenHash, token, "the clear token must never be persisted");
    assert.ok(stored.linkExpiresAt!.getTime() > Date.now());
    assert.ok(stored.linkExpiresAt!.getTime() <= Date.now() + BIND_LINK_TTL_MS + 1_000);
  });

  test("re-minting replaces the previous token", async () => {
    const identity = await sighting();
    const first = (await mintBindLink(identity)).split("/").pop()!;
    const second = (await mintBindLink(identity)).split("/").pop()!;
    assert.notEqual(first, second);
    const outcome = await bindIdentity({
      identityId: identity.id,
      token: first,
      userId: user.id,
    });
    assert.deepEqual(outcome, { ok: false, reason: "not_found" });
  });
});

describe("bindIdentity", () => {
  async function pending() {
    const identity = await sighting();
    const token = (await mintBindLink(identity)).split("/").pop()!;
    return { identity, token };
  }

  test("binds, records how, and burns the token", async () => {
    const { identity, token } = await pending();
    const outcome = await bindIdentity({ identityId: identity.id, token, userId: user.id });
    assert.equal(outcome.ok, true);
    const stored = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(stored.boundSessionVersion, 1, "the auth epoch is pinned at bind time");
    assert.equal(stored.userId, user.id);
    assert.equal(stored.boundVia, "link");
    assert.ok(stored.boundAt instanceof Date);
    assert.equal(stored.linkTokenHash, null);
    assert.equal(stored.linkExpiresAt, null);
  });

  test("the token is single use", async () => {
    const { identity, token } = await pending();
    await bindIdentity({ identityId: identity.id, token, userId: user.id });
    const replay = await bindIdentity({ identityId: identity.id, token, userId: user.id });
    assert.deepEqual(replay, { ok: false, reason: "not_found" });
  });

  test("a wrong token is refused and leaves the real one usable", async () => {
    const { identity, token } = await pending();
    const wrong = await bindIdentity({
      identityId: identity.id,
      token: "f".repeat(64),
      userId: user.id,
    });
    assert.deepEqual(wrong, { ok: false, reason: "not_found" });
    const right = await bindIdentity({ identityId: identity.id, token, userId: user.id });
    assert.equal(right.ok, true);
  });

  test("an unknown identity is indistinguishable from a bad token", async () => {
    const outcome = await bindIdentity({
      identityId: "00000000-0000-4000-8000-000000000000",
      token: "whatever",
      userId: user.id,
    });
    assert.deepEqual(outcome, { ok: false, reason: "not_found" });
  });

  test("an identity with no outstanding link cannot be bound", async () => {
    const identity = await sighting();
    const outcome = await bindIdentity({
      identityId: identity.id,
      token: "whatever",
      userId: user.id,
    });
    assert.deepEqual(outcome, { ok: false, reason: "not_found" });
  });

  test("an expired link says so, because the fix is to ask the bot again", async () => {
    const { identity, token } = await pending();
    await AppDataSource.getRepository(ExternalChatIdentity).update(
      { id: identity.id },
      { linkExpiresAt: new Date(Date.now() - 1_000) },
    );
    const outcome = await bindIdentity({ identityId: identity.id, token, userId: user.id });
    assert.deepEqual(outcome, { ok: false, reason: "expired" });
  });

  test("a link cannot be redirected onto a second Member", async () => {
    const { identity, token } = await pending();
    await bindIdentity({ identityId: identity.id, token, userId: user.id });
    const second = await insert(User, {
      email: "theo@example.com",
      passwordHash: "x",
      name: "Theo Thief",
      sessionVersion: 1,
    });
    await insert(Membership, { companyId, userId: second.id, role: "member" });
    const nextToken = (
      await mintBindLink(
        await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
          id: identity.id,
        }),
      )
    )
      .split("/")
      .pop()!;
    const outcome = await bindIdentity({
      identityId: identity.id,
      token: nextToken,
      userId: second.id,
    });
    assert.deepEqual(outcome, { ok: false, reason: "already_bound" });
  });

  test("the same Member re-binding their own identity is allowed", async () => {
    const { identity, token } = await pending();
    await bindIdentity({ identityId: identity.id, token, userId: user.id });
    const again = (
      await mintBindLink(
        await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
          id: identity.id,
        }),
      )
    )
      .split("/")
      .pop()!;
    const outcome = await bindIdentity({
      identityId: identity.id,
      token: again,
      userId: user.id,
    });
    assert.equal(outcome.ok, true);
  });

  test("someone outside the company cannot bind, even holding a valid token", async () => {
    const { identity, token } = await pending();
    const outsider = await insert(User, {
      email: "guest@other.example",
      passwordHash: "x",
      name: "Gale Guest",
      sessionVersion: 1,
    });
    await insert(Membership, { companyId: otherCompanyId, userId: outsider.id, role: "owner" });
    const outcome = await bindIdentity({
      identityId: identity.id,
      token,
      userId: outsider.id,
    });
    assert.deepEqual(outcome, { ok: false, reason: "forbidden" });
    const stored = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(stored.userId, null);
  });
});

describe("unbindIdentity", () => {
  test("clears the authority but keeps the row", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    const cleared = await unbindIdentity({ companyId, identityId: identity.id });
    assert.equal(cleared?.userId, null);
    assert.equal(cleared?.boundAt, null);
    assert.equal(cleared?.boundVia, null);
    assert.equal(cleared?.externalUserLabel, "mia", "the row survives so the label does");
  });

  test("is scoped to the company that owns the identity", async () => {
    const identity = await sighting();
    await bindTo(identity.id, user.id);
    assert.equal(await unbindIdentity({ companyId: otherCompanyId, identityId: identity.id }), null);
    const stored = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(stored.userId, user.id);
  });
});

describe("listIdentities", () => {
  test("hydrates the bound Member and marks the pending ones", async () => {
    const bound = await sighting();
    await bindTo(bound.id, user.id);
    await sighting({ externalUserId: "U0002", externalUserLabel: "pat" });

    const rows = await listIdentities({ companyId });
    assert.equal(rows.length, 2);
    const boundRow = rows.find((r) => r.externalUserId === "U0001")!;
    assert.equal(boundRow.bound, true);
    assert.equal(boundRow.userName, "Mia Member");
    assert.equal(boundRow.userEmail, "mia@example.com");
    assert.ok(boundRow.boundAt);
    const pendingRow = rows.find((r) => r.externalUserId === "U0002")!;
    assert.equal(pendingRow.bound, false);
    assert.equal(pendingRow.userId, null);
    assert.equal(pendingRow.userName, null);
  });

  test("never leaks another company's identities", async () => {
    await sighting();
    await sighting({ companyId: otherCompanyId, externalUserId: "U9999" });
    const rows = await listIdentities({ companyId });
    assert.deepEqual(
      rows.map((r) => r.externalUserId),
      ["U0001"],
    );
  });

  test("filters to one Connection when asked", async () => {
    const otherConnection = testId("conn");
    await sighting();
    await sighting({ connectionId: otherConnection, externalUserId: "U0003" });
    const rows = await listIdentities({ companyId, connectionId: otherConnection });
    assert.deepEqual(
      rows.map((r) => r.externalUserId),
      ["U0003"],
    );
  });

  test("never returns a token hash or expiry", async () => {
    const identity = await sighting();
    await mintBindLink(identity);
    const [row] = await listIdentities({ companyId });
    assert.ok(!("linkTokenHash" in row));
    assert.ok(!("linkExpiresAt" in row));
  });
});

describe("previewBind", () => {
  async function pendingLink() {
    const identity = await sighting();
    const token = (await mintBindLink(identity)).split("/").pop()!;
    return { identity, token };
  }

  test("names the external account without spending the token", async () => {
    const { identity, token } = await pendingLink();
    const outcome = await previewBind({ identityId: identity.id, token, userId: user.id });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.preview.identityId, identity.id);
    assert.equal(outcome.preview.provider, "slack");
    assert.equal(outcome.preview.externalUserLabel, "mia");
    assert.equal(outcome.preview.externalUserId, "U0001");
    assert.equal(outcome.preview.alreadyMine, false);

    // The point of a preview is that the confirm still works after it.
    const bound = await bindIdentity({ identityId: identity.id, token, userId: user.id });
    assert.equal(bound.ok, true);
  });

  test("refuses exactly what the bind would refuse", async () => {
    const { identity, token } = await pendingLink();
    const outsider = await insert(User, {
      email: "gale@other.example",
      passwordHash: "x",
      name: "Gale Guest",
      sessionVersion: 1,
    });
    assert.deepEqual(await previewBind({ identityId: identity.id, token, userId: outsider.id }), {
      ok: false,
      reason: "forbidden",
    });
    assert.deepEqual(
      await previewBind({ identityId: identity.id, token: "nope", userId: user.id }),
      { ok: false, reason: "not_found" },
    );
    await AppDataSource.getRepository(ExternalChatIdentity).update(
      { id: identity.id },
      { linkExpiresAt: new Date(Date.now() - 1) },
    );
    assert.deepEqual(await previewBind({ identityId: identity.id, token, userId: user.id }), {
      ok: false,
      reason: "expired",
    });
  });

  test("tells a Member the link is already theirs", async () => {
    const { identity, token } = await pendingLink();
    await bindIdentity({ identityId: identity.id, token, userId: user.id });
    const next = (
      await mintBindLink(
        await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
          id: identity.id,
        }),
      )
    )
      .split("/")
      .pop()!;
    const outcome = await previewBind({ identityId: identity.id, token: next, userId: user.id });
    assert.equal(outcome.ok && outcome.preview.alreadyMine, true);
  });
});

describe("concurrent redemption", () => {
  test("only one of two simultaneous binds on one token wins", async () => {
    const identity = await sighting();
    const token = (await mintBindLink(identity)).split("/").pop()!;
    const rival = await insert(User, {
      email: "rory@example.com",
      passwordHash: "x",
      name: "Rory Rival",
      sessionVersion: 1,
    });
    await insert(Membership, { companyId, userId: rival.id, role: "member" });

    const [a, b] = await Promise.all([
      bindIdentity({ identityId: identity.id, token, userId: user.id }),
      bindIdentity({ identityId: identity.id, token, userId: rival.id }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1, "single-use has to survive a tie");
    const stored = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      id: identity.id,
    });
    assert.equal(stored.linkTokenHash, null);
    assert.ok(stored.userId === user.id || stored.userId === rival.id);
  });
});

describe("deleteIdentitiesForConnection", () => {
  test("removes every binding a deleted Connection carried", async () => {
    const survivor = testId("conn");
    await sighting();
    await sighting({ connectionId: survivor, externalUserId: "U0004" });
    await deleteIdentitiesForConnection(connectionId);
    const rows = await AppDataSource.getRepository(ExternalChatIdentity).find();
    assert.deepEqual(
      rows.map((r) => r.connectionId),
      [survivor],
    );
  });
});
