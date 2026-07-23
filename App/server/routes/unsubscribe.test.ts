import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { SequenceEnrollment } from "../db/entities/SequenceEnrollment.js";
import { Suppression } from "../db/entities/Suppression.js";
import { isSuppressed } from "../services/mail/suppression.js";
import {
  signUnsubscribeToken,
  unsubscribeSecret,
} from "../services/revenue/unsubscribeToken.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import {
  applyUnsubscribe,
  renderErrorPage,
  renderInvalidPage,
  renderUnsubscribedPage,
  unsubscribeHandler,
} from "./unsubscribe.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const SECRET = "unsubscribe-route-test-secret";
const OTHER_SECRET = "some-other-installations-secret";
const EMAIL = "recipient@example.com";

let CO = "";
beforeEach(() => {
  CO = testCompanyId();
});

function tokenFor(over: Partial<{ companyId: string; contactId: string | null; email: string }> = {}) {
  return signUnsubscribeToken(
    {
      companyId: over.companyId ?? CO,
      contactId: over.contactId === undefined ? null : over.contactId,
      email: over.email ?? EMAIL,
    },
    SECRET,
  );
}

/** A token the handler will accept — the handler verifies against the real key. */
function installationToken(email = EMAIL): string {
  return signUnsubscribeToken(
    { companyId: CO, contactId: null, email },
    unsubscribeSecret(),
  );
}

async function seedContact(over: Partial<Contact> = {}): Promise<Contact> {
  return insert(Contact, {
    companyId: CO,
    name: "Rec Ipient",
    email: EMAIL,
    ...over,
  });
}

async function seedEnrollment(
  contactId: string,
  status: SequenceEnrollment["status"] = "active",
): Promise<SequenceEnrollment> {
  return insert(SequenceEnrollment, {
    companyId: CO,
    sequenceId: testId("seq"),
    contactId,
    status,
    nextRunAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function suppressions() {
  return AppDataSource.getRepository(Suppression);
}
function activities() {
  return AppDataSource.getRepository(Activity);
}
function enrollments() {
  return AppDataSource.getRepository(SequenceEnrollment);
}

/** A response stand-in — enough surface for the handler, none of Express. */
type Captured = {
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  sends: number;
};

function fakeRes(): { res: Parameters<typeof unsubscribeHandler>[1]; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, body: null, sends: 0 };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    set(fields: Record<string, string>) {
      Object.assign(captured.headers, fields);
      return this;
    },
    send(body: string) {
      captured.body = body;
      captured.sends += 1;
      return this;
    },
  };
  return { res: res as unknown as Parameters<typeof unsubscribeHandler>[1], captured };
}

function fakeReq(token: unknown) {
  return { params: { token } } as unknown as Parameters<typeof unsubscribeHandler>[0];
}

// ──────────────────────────── token handling ────────────────────────────

describe("applyUnsubscribe — token handling", () => {
  test("round-trips a signed token and suppresses the address", async () => {
    const result = await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(result.outcome, "unsubscribed");
    assert.equal(await isSuppressed(CO, EMAIL), true);
  });

  test("returns the normalized address from inside the token", async () => {
    const token = signUnsubscribeToken(
      { companyId: CO, contactId: null, email: "  Recipient@Example.COM " },
      SECRET,
    );
    const result = await applyUnsubscribe(token, SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.email, EMAIL);
  });

  test("rejects a token signed with a different secret", async () => {
    const token = signUnsubscribeToken({ companyId: CO, contactId: null, email: EMAIL }, OTHER_SECRET);
    assert.deepEqual(await applyUnsubscribe(token, SECRET), { outcome: "invalid" });
  });

  test("rejects a tampered payload — the address cannot be swapped", async () => {
    const token = tokenFor();
    const [version, payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ c: CO, k: null, e: "victim@example.com" }),
    ).toString("base64url");
    assert.notEqual(forged, payload);
    const result = await applyUnsubscribe(`${version}.${forged}.${signature}`, SECRET);
    assert.deepEqual(result, { outcome: "invalid" });
    assert.equal(await suppressions().countBy({ companyId: CO }), 0);
  });

  test("rejects a tampered signature", async () => {
    const token = tokenFor();
    assert.deepEqual(await applyUnsubscribe(`${token}x`, SECRET), { outcome: "invalid" });
  });

  test("rejects a truncated token", async () => {
    const token = tokenFor();
    const cut = token.slice(0, token.lastIndexOf("."));
    assert.deepEqual(await applyUnsubscribe(cut, SECRET), { outcome: "invalid" });
  });

  test("rejects empty, null and undefined tokens without throwing", async () => {
    assert.deepEqual(await applyUnsubscribe("", SECRET), { outcome: "invalid" });
    assert.deepEqual(await applyUnsubscribe(null, SECRET), { outcome: "invalid" });
    assert.deepEqual(await applyUnsubscribe(undefined, SECRET), { outcome: "invalid" });
  });

  test("rejects arbitrary junk in the path segment", async () => {
    for (const junk of ["hello", "../../etc/passwd", "u1..", "u1.a.b", "%%%"]) {
      assert.deepEqual(await applyUnsubscribe(junk, SECRET), { outcome: "invalid" });
    }
  });

  test("writes nothing at all for an invalid token", async () => {
    await applyUnsubscribe("not-a-token", SECRET);
    assert.equal(await suppressions().count(), 0);
    assert.equal(await activities().count(), 0);
  });
});

// ──────────────────────── unknown-token neutrality ────────────────────────

describe("applyUnsubscribe — leaks nothing", () => {
  test("a well-formed token for an unknown company still succeeds", async () => {
    const result = await applyUnsubscribe(tokenFor({ companyId: "co_does_not_exist" }), SECRET);
    assert.equal(result.outcome, "unsubscribed");
    assert.equal(result.outcome === "unsubscribed" && result.companyName, null);
  });

  test("an address with no Contact row is still suppressed", async () => {
    const result = await applyUnsubscribe(tokenFor({ email: "stranger@example.com" }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.contactId, null);
    assert.equal(await isSuppressed(CO, "stranger@example.com"), true);
  });

  test("a contactId in the token that no longer exists does not throw", async () => {
    const result = await applyUnsubscribe(tokenFor({ contactId: "ct_deleted" }), SECRET);
    assert.equal(result.outcome, "unsubscribed");
  });

  test("the page for a known contact is byte-identical to one for a stranger", async () => {
    // The rendered confirmation must not encode whether we recognised anybody.
    await seedContact();
    const known = await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(known.outcome, "unsubscribed");
    await resetTestDb();
    const unknown = await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(unknown.outcome, "unsubscribed");
    if (known.outcome !== "unsubscribed" || unknown.outcome !== "unsubscribed") return;
    assert.notEqual(known.contactId, unknown.contactId);
    assert.equal(renderUnsubscribedPage(known), renderUnsubscribedPage(unknown));
  });
});

// ───────────────────────────── side effects ─────────────────────────────

describe("applyUnsubscribe — effects", () => {
  test("records the suppression with the compliance reason and source", async () => {
    await applyUnsubscribe(tokenFor(), SECRET);
    const row = await suppressions().findOneBy({ companyId: CO, email: EMAIL });
    assert.equal(row?.reason, "unsubscribe");
    assert.equal(row?.source, "unsubscribe-link");
    assert.equal(row?.createdById, null, "the recipient did this, not an operator");
  });

  test("marks the Contact unsubscribed", async () => {
    const contact = await seedContact();
    const now = new Date("2026-03-04T05:06:07.000Z");
    await applyUnsubscribe(tokenFor({ contactId: contact.id }), SECRET, now);
    const after_ = await AppDataSource.getRepository(Contact).findOneBy({ id: contact.id });
    assert.equal(after_?.unsubscribedAt?.toISOString(), now.toISOString());
  });

  test("resolves the Contact by address when the token carries no id", async () => {
    const contact = await seedContact();
    const result = await applyUnsubscribe(tokenFor({ contactId: null }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.contactId, contact.id);
  });

  test("stops active sequence enrolments", async () => {
    const contact = await seedContact();
    const enrolment = await seedEnrollment(contact.id, "active");
    const result = await applyUnsubscribe(tokenFor({ contactId: contact.id }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.stoppedEnrollments, 1);
    const row = await enrollments().findOneBy({ id: enrolment.id });
    assert.equal(row?.status, "stopped_unsubscribed");
    assert.equal(row?.nextRunAt, null, "clearing nextRunAt is what removes it from the scheduler");
    assert.match(row?.stoppedReason ?? "", /unsubscribed/i);
  });

  test("stops paused enrolments too — a resume must not restart sending", async () => {
    const contact = await seedContact();
    const enrolment = await seedEnrollment(contact.id, "paused");
    await applyUnsubscribe(tokenFor({ contactId: contact.id }), SECRET);
    assert.equal((await enrollments().findOneBy({ id: enrolment.id }))?.status, "stopped_unsubscribed");
  });

  test("leaves terminal enrolments untouched", async () => {
    const contact = await seedContact();
    const done = await seedEnrollment(contact.id, "completed");
    const result = await applyUnsubscribe(tokenFor({ contactId: contact.id }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.stoppedEnrollments, 0);
    assert.equal((await enrollments().findOneBy({ id: done.id }))?.status, "completed");
  });

  test("stops enrolments held against a stale contact id from the token", async () => {
    // Contact deleted and re-created: the token's id and the live row differ,
    // and an enrolment may still be attached to either.
    const live = await seedContact();
    const stale = testId("ct");
    const staleEnrolment = await seedEnrollment(stale, "active");
    const liveEnrolment = await seedEnrollment(live.id, "active");
    const result = await applyUnsubscribe(tokenFor({ contactId: stale }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.stoppedEnrollments, 2);
    assert.equal((await enrollments().findOneBy({ id: staleEnrolment.id }))?.status, "stopped_unsubscribed");
    assert.equal((await enrollments().findOneBy({ id: liveEnrolment.id }))?.status, "stopped_unsubscribed");
  });

  test("never touches another company's rows", async () => {
    const other = testCompanyId();
    await insert(Suppression, { companyId: other, email: EMAIL, reason: "manual" });
    const otherContact = await insert(Contact, { companyId: other, name: "Same Person", email: EMAIL });
    await applyUnsubscribe(tokenFor(), SECRET);
    const row = await AppDataSource.getRepository(Contact).findOneBy({ id: otherContact.id });
    assert.equal(row?.unsubscribedAt ?? null, null);
    assert.equal(await suppressions().countBy({ companyId: other }), 1);
  });

  test("records an unsubscribe Activity on the timeline", async () => {
    const contact = await seedContact();
    await applyUnsubscribe(tokenFor({ contactId: contact.id }), SECRET);
    const rows = await activities().findBy({ companyId: CO, kind: "unsubscribe" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contactId, contact.id);
    assert.match(rows[0].subject, /recipient@example\.com/);
  });

  test("resolves the company name when the row exists", async () => {
    const company = await insert(Company, {
      name: "  Acme Rockets  ",
      slug: `acme-${Date.now()}`,
      ownerId: testId("u"),
    });
    const result = await applyUnsubscribe(tokenFor({ companyId: company.id }), SECRET);
    assert.equal(result.outcome === "unsubscribed" && result.companyName, "Acme Rockets");
  });
});

// ───────────────────────────── idempotency ─────────────────────────────

describe("applyUnsubscribe — idempotency", () => {
  test("clicking twice succeeds both times", async () => {
    const first = await applyUnsubscribe(tokenFor(), SECRET);
    const second = await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(first.outcome, "unsubscribed");
    assert.equal(second.outcome, "unsubscribed");
    assert.equal(first.outcome === "unsubscribed" && first.alreadySuppressed, false);
    assert.equal(second.outcome === "unsubscribed" && second.alreadySuppressed, true);
  });

  test("does not create a second suppression row", async () => {
    await applyUnsubscribe(tokenFor(), SECRET);
    await applyUnsubscribe(tokenFor(), SECRET);
    await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(await suppressions().countBy({ companyId: CO, email: EMAIL }), 1);
  });

  test("Gmail POSTing then the human clicking writes one timeline entry", async () => {
    const contact = await seedContact();
    const token = tokenFor({ contactId: contact.id });
    await applyUnsubscribe(token, SECRET);
    await applyUnsubscribe(token, SECRET);
    assert.equal(await activities().countBy({ companyId: CO, kind: "unsubscribe" }), 1);
  });

  test("keeps the first unsubscribedAt rather than moving it forward", async () => {
    const contact = await seedContact();
    const token = tokenFor({ contactId: contact.id });
    const first = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-06-01T00:00:00.000Z");
    await applyUnsubscribe(token, SECRET, first);
    await applyUnsubscribe(token, SECRET, later);
    const row = await AppDataSource.getRepository(Contact).findOneBy({ id: contact.id });
    assert.equal(row?.unsubscribedAt?.toISOString(), first.toISOString());
  });

  test("a second call reports no further enrolments stopped", async () => {
    const contact = await seedContact();
    await seedEnrollment(contact.id, "active");
    const token = tokenFor({ contactId: contact.id });
    const first = await applyUnsubscribe(token, SECRET);
    const second = await applyUnsubscribe(token, SECRET);
    assert.equal(first.outcome === "unsubscribed" && first.stoppedEnrollments, 1);
    assert.equal(second.outcome === "unsubscribed" && second.stoppedEnrollments, 0);
  });

  test("still succeeds when the address was suppressed for another reason first", async () => {
    await insert(Suppression, { companyId: CO, email: EMAIL, reason: "bounce" });
    const result = await applyUnsubscribe(tokenFor(), SECRET);
    assert.equal(result.outcome, "unsubscribed");
    assert.equal(await suppressions().countBy({ companyId: CO, email: EMAIL }), 1);
  });
});

// ───────────────────────────── rendering ─────────────────────────────

describe("rendering", () => {
  test("the confirmation names the address and the company", () => {
    const html = renderUnsubscribedPage({ email: EMAIL, companyName: "Acme Rockets" });
    assert.match(html, /recipient@example\.com/);
    assert.match(html, /Acme Rockets/);
    assert.match(html, /^<!doctype html>/);
  });

  test("falls back to a generic sender when the company is unknown", () => {
    const html = renderUnsubscribedPage({ email: EMAIL, companyName: null });
    assert.match(html, /this sender/);
  });

  test("escapes a hostile company name", () => {
    const html = renderUnsubscribedPage({
      email: EMAIL,
      companyName: '<script>alert("x")</script>',
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("escapes the address", () => {
    const html = renderUnsubscribedPage({ email: '"><img src=x>@evil.test', companyName: null });
    assert.doesNotMatch(html, /<img src=x>/);
  });

  test("every page is self-contained — no external stylesheet or script", () => {
    for (const html of [
      renderUnsubscribedPage({ email: EMAIL, companyName: "Acme" }),
      renderInvalidPage(),
      renderErrorPage(),
    ]) {
      assert.doesNotMatch(html, /<link\b/i);
      assert.doesNotMatch(html, /<script\b/i);
      assert.doesNotMatch(html, /https?:\/\//i);
    }
  });

  test("the invalid page says nothing about addresses, contacts or companies", () => {
    const html = renderInvalidPage();
    assert.doesNotMatch(html, /[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(html, /exist|unknown|not found|already/i);
    assert.match(html, /not valid/i);
  });
});

// ───────────────────────────── handler ─────────────────────────────

describe("unsubscribeHandler", () => {
  test("responds 200 with the confirmation for a good token", async () => {
    const { res, captured } = fakeRes();
    await unsubscribeHandler(fakeReq(installationToken()), res);
    assert.equal(captured.status, 200);
    assert.match(captured.body ?? "", /unsubscribed/i);
    assert.equal(captured.sends, 1);
  });

  test("the same request twice is safe — one response each, one suppression", async () => {
    const token = installationToken();
    for (let i = 0; i < 2; i += 1) {
      const { res, captured } = fakeRes();
      await unsubscribeHandler(fakeReq(token), res);
      assert.equal(captured.status, 200);
      assert.match(captured.body ?? "", /unsubscribed/i);
    }
    assert.equal(await suppressions().countBy({ companyId: CO, email: EMAIL }), 1);
  });

  test("responds 200 with the neutral page for a bad token — 4xx would make one-click clients retry forever", async () => {
    const { res, captured } = fakeRes();
    await unsubscribeHandler(fakeReq("garbage"), res);
    assert.equal(captured.status, 200);
    assert.match(captured.body ?? "", /not valid/i);
  });

  test("sets no-store, no-referrer and noindex", async () => {
    const { res, captured } = fakeRes();
    await unsubscribeHandler(fakeReq(installationToken()), res);
    assert.equal(captured.headers["Content-Type"], "text/html; charset=utf-8");
    assert.equal(captured.headers["Referrer-Policy"], "no-referrer");
    assert.match(captured.headers["Cache-Control"], /no-store/);
    assert.match(captured.headers["X-Robots-Tag"], /noindex/);
  });

  test("survives a missing token param", async () => {
    const { res, captured } = fakeRes();
    await unsubscribeHandler(fakeReq(undefined), res);
    assert.equal(captured.status, 200);
    assert.match(captured.body ?? "", /not valid/i);
  });

  test("never throws when the database is unreachable — it answers 500 so the client retries", async () => {
    const token = installationToken();
    await closeTestDb();
    const { res, captured } = fakeRes();
    await assert.doesNotReject(() => unsubscribeHandler(fakeReq(token), res));
    assert.equal(captured.status, 500);
    assert.match(captured.body ?? "", /went wrong/i);
    await initTestDb();
    await resetTestDb();
  });
});

// ───────────────────────────── wiring ─────────────────────────────

describe("unsubscribeSecret", () => {
  test("is stable and is not the raw encryption secret", async () => {
    const { config } = await import("../../config.js");
    const secret = unsubscribeSecret();
    assert.equal(secret, unsubscribeSecret());
    assert.notEqual(secret, config.security.encryptionSecret);
    assert.match(secret, /^[0-9a-f]{64}$/);
  });

  test("the handler verifies against the installation secret by default", async () => {
    const { res, captured } = fakeRes();
    await unsubscribeHandler(fakeReq(installationToken()), res);
    assert.equal(captured.status, 200);
    assert.equal(await isSuppressed(CO, EMAIL), true);
  });
});
