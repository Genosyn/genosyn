import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Contact } from "../../db/entities/Contact.js";
import { Suppression } from "../../db/entities/Suppression.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import {
  SuppressedRecipientError,
  addSuppression,
  assertRecipientsAllowed,
  collectRecipients,
  isSuppressed,
  partitionRecipients,
  removeSuppression,
  suppressedAmong,
} from "./suppression.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_test_fixed";
const OTHER_CO = "co_other_fixed";

async function suppress(email: string, companyId = CO) {
  return addSuppression({ companyId, email, reason: "unsubscribe", source: "test" });
}

// ───────────────────────── collectRecipients ─────────────────────────

describe("collectRecipients", () => {
  test("gathers to, cc and bcc", () => {
    assert.deepEqual(
      collectRecipients({ to: "a@x.com", cc: "b@y.com", bcc: "c@z.com" }).sort(),
      ["a@x.com", "b@y.com", "c@z.com"],
    );
  });

  test("normalizes and de-duplicates across fields", () => {
    // Somebody in both To and Cc must be counted once, or the suppression
    // error would name them twice.
    assert.deepEqual(collectRecipients({ to: "A@X.com", cc: "Foo <a@x.com>" }), [
      "a@x.com",
    ]);
  });

  test("tolerates missing, null and empty fields", () => {
    assert.deepEqual(collectRecipients({}), []);
    assert.deepEqual(collectRecipients({ to: null, cc: undefined, bcc: "" }), []);
  });

  test("drops unparseable entries rather than passing junk to the gate", () => {
    assert.deepEqual(collectRecipients({ to: "good@x.com, garbage" }), ["good@x.com"]);
  });
});

// ────────────────────────── addSuppression ──────────────────────────

describe("addSuppression", () => {
  test("stores a normalized address", async () => {
    const row = await suppress("  Foo@Example.COM ");
    assert.equal(row?.email, "foo@example.com");
    assert.equal(row?.reason, "unsubscribe");
    assert.equal(row?.companyId, CO);
  });

  test("is idempotent — a bounce arriving twice is harmless", async () => {
    const first = await suppress("dup@example.com");
    const second = await suppress("dup@example.com");
    assert.equal(first?.id, second?.id);
    const count = await (
      await import("../../db/datasource.js")
    ).AppDataSource.getRepository(Suppression).countBy({ companyId: CO });
    assert.equal(count, 1);
  });

  test("returns null for an unusable address instead of throwing", async () => {
    // A malformed bounce header must not throw inside mail sync.
    assert.equal(await addSuppression({ companyId: CO, email: "junk", reason: "bounce" }), null);
    assert.equal(await addSuppression({ companyId: CO, email: "", reason: "bounce" }), null);
  });

  test("records the optional provenance fields", async () => {
    const row = await addSuppression({
      companyId: CO,
      email: "p@example.com",
      reason: "complaint",
      source: "sequence:q3-outbound",
      contactId: "ct_1",
      notes: "marked as spam",
      createdById: "u_1",
    });
    assert.equal(row?.source, "sequence:q3-outbound");
    assert.equal(row?.contactId, "ct_1");
    assert.equal(row?.notes, "marked as spam");
    assert.equal(row?.createdById, "u_1");
  });
});

// ─────────────────────── suppressedAmong / isSuppressed ───────────────────────

describe("suppressedAmong", () => {
  test("finds a suppressed address regardless of the caller's formatting", async () => {
    await suppress("blocked@example.com");
    const found = await suppressedAmong(CO, ["Blocked <BLOCKED@Example.com>"]);
    assert.deepEqual([...found], ["blocked@example.com"]);
  });

  test("is company-scoped — another tenant's opt-out does not block us", async () => {
    await suppress("shared@example.com", OTHER_CO);
    assert.equal((await suppressedAmong(CO, ["shared@example.com"])).size, 0);
    assert.equal((await suppressedAmong(OTHER_CO, ["shared@example.com"])).size, 1);
  });

  test("a doNotContact Contact blocks their address with no Suppression row", async () => {
    await insert(Contact, {
      companyId: CO,
      name: "Do Not Mail",
      email: "dnc@example.com",
      doNotContact: true,
    });
    assert.equal(await isSuppressed(CO, "dnc@example.com"), true);
  });

  test("a Contact without doNotContact does not block", async () => {
    await insert(Contact, {
      companyId: CO,
      name: "Fine",
      email: "fine@example.com",
      doNotContact: false,
    });
    assert.equal(await isSuppressed(CO, "fine@example.com"), false);
  });

  test("empty input short-circuits without a query", async () => {
    assert.equal((await suppressedAmong(CO, [])).size, 0);
    assert.equal((await suppressedAmong(CO, ["garbage", ""])).size, 0);
  });

  test("resolves a large batch in one pass", async () => {
    const emails: string[] = [];
    for (let i = 0; i < 120; i += 1) emails.push(`user${i}@example.com`);
    await suppress("user7@example.com");
    await suppress("user119@example.com");
    const found = await suppressedAmong(CO, emails);
    assert.deepEqual([...found].sort(), ["user119@example.com", "user7@example.com"]);
  });

  test("does NOT treat gmail dot/plus variants as the same mailbox", async () => {
    // Over-matching silently drops mail the user never asked us to drop.
    await suppress("foo@gmail.com");
    assert.equal(await isSuppressed(CO, "f.o.o@gmail.com"), false);
    assert.equal(await isSuppressed(CO, "foo+sales@gmail.com"), false);
    assert.equal(await isSuppressed(CO, "foo@gmail.com"), true);
  });
});

// ─────────────────────── assertRecipientsAllowed ───────────────────────

describe("assertRecipientsAllowed", () => {
  test("passes a clean recipient list", async () => {
    await assertRecipientsAllowed(CO, { to: "ok@example.com", cc: "also@example.com" });
  });

  test("passes when there are no recipients at all", async () => {
    await assertRecipientsAllowed(CO, {});
  });

  test("throws when ANY recipient is suppressed, naming them", async () => {
    await suppress("blocked@example.com");
    await assert.rejects(
      () =>
        assertRecipientsAllowed(CO, {
          to: "fine@example.com",
          cc: "blocked@example.com",
        }),
      (err: unknown) => {
        assert.ok(err instanceof SuppressedRecipientError);
        assert.deepEqual(err.suppressed, ["blocked@example.com"]);
        assert.match(err.message, /do-not-email/);
        return true;
      },
    );
  });

  test("blocks on a bcc — the field a bulk sender is most likely to misuse", async () => {
    await suppress("hidden@example.com");
    await assert.rejects(
      () => assertRecipientsAllowed(CO, { to: "fine@example.com", bcc: "hidden@example.com" }),
      SuppressedRecipientError,
    );
  });

  test("is all-or-nothing: it never silently sends to the remaining recipients", async () => {
    await suppress("a@example.com");
    await suppress("b@example.com");
    await assert.rejects(
      () => assertRecipientsAllowed(CO, { to: "a@example.com, b@example.com, c@example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof SuppressedRecipientError);
        // Sorted and complete, so the UI can list every blocked address.
        assert.deepEqual(err.suppressed, ["a@example.com", "b@example.com"]);
        return true;
      },
    );
  });

  test("a doNotContact contact blocks the send too", async () => {
    await insert(Contact, {
      companyId: CO,
      name: "Nope",
      email: "nope@example.com",
      doNotContact: true,
    });
    await assert.rejects(
      () => assertRecipientsAllowed(CO, { to: "nope@example.com" }),
      SuppressedRecipientError,
    );
  });
});

// ───────────────────────── partitionRecipients ─────────────────────────

describe("partitionRecipients", () => {
  test("splits allowed from suppressed, preserving order", async () => {
    await suppress("no@example.com");
    const r = await partitionRecipients(CO, [
      "yes1@example.com",
      "no@example.com",
      "yes2@example.com",
    ]);
    assert.deepEqual(r.allowed, ["yes1@example.com", "yes2@example.com"]);
    assert.deepEqual(r.suppressed, ["no@example.com"]);
  });

  test("de-duplicates so a contact enrolled twice is only counted once", async () => {
    const r = await partitionRecipients(CO, ["a@x.com", "A@X.com", "Foo <a@x.com>"]);
    assert.deepEqual(r.allowed, ["a@x.com"]);
  });

  test("drops unparseable addresses from both lists", async () => {
    const r = await partitionRecipients(CO, ["good@x.com", "junk", ""]);
    assert.deepEqual(r.allowed, ["good@x.com"]);
    assert.deepEqual(r.suppressed, []);
  });

  test("everything suppressed yields an empty allowed list, not an error", async () => {
    await suppress("a@x.com");
    const r = await partitionRecipients(CO, ["a@x.com"]);
    assert.deepEqual(r.allowed, []);
    assert.deepEqual(r.suppressed, ["a@x.com"]);
  });
});

// ───────────────────────── removeSuppression ─────────────────────────

describe("removeSuppression", () => {
  test("removes an address and reports that it did", async () => {
    await suppress("gone@example.com");
    assert.equal(await removeSuppression(CO, "GONE@example.com"), true);
    assert.equal(await isSuppressed(CO, "gone@example.com"), false);
  });

  test("returns false when there was nothing to remove", async () => {
    assert.equal(await removeSuppression(CO, "absent@example.com"), false);
    assert.equal(await removeSuppression(CO, "junk"), false);
  });

  test("does not reach across companies", async () => {
    await suppress("x@example.com", OTHER_CO);
    assert.equal(await removeSuppression(CO, "x@example.com"), false);
    assert.equal(await isSuppressed(OTHER_CO, "x@example.com"), true);
  });
});
