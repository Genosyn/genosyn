import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import {
  DuplicateContactError,
  archiveContact,
  createContact,
  findContactByEmail,
  findContactsByEmails,
  getContact,
  listContacts,
  listStaleContacts,
  markContactBounced,
  markContactUnsubscribed,
  restoreContact,
  touchLastActivity,
  updateContact,
  upsertContactByEmail,
} from "./contacts.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_contacts";
const OTHER = "co_other";

describe("createContact", () => {
  test("normalizes the address and applies defaults", async () => {
    const c = await createContact(CO, { name: "  Ada Lovelace ", email: "Ada@Example.COM" });
    assert.equal(c.name, "Ada Lovelace");
    assert.equal(c.email, "ada@example.com");
    assert.equal(c.lifecycleStage, "lead");
    assert.equal(c.score, 0);
    assert.equal(c.doNotContact, false);
    assert.equal(c.archivedAt, null);
  });

  test("allows a contact with no email at all", async () => {
    // Plenty of real contacts are a name and a phone number.
    const c = await createContact(CO, { name: "Phone Only", phone: "+44 7700 900000" });
    assert.equal(c.email, "");
  });

  test("allows MANY contacts with no email — the empty string is not a key", async () => {
    await createContact(CO, { name: "A" });
    await createContact(CO, { name: "B" });
    const { total } = await listContacts(CO);
    assert.equal(total, 2);
  });

  test("refuses a duplicate address rather than silently merging", async () => {
    await createContact(CO, { name: "First", email: "dup@example.com" });
    await assert.rejects(
      () => createContact(CO, { name: "Second", email: "DUP@example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateContactError);
        assert.ok(err.existingId);
        return true;
      },
    );
  });

  test("the same address in two companies is fine", async () => {
    await createContact(CO, { name: "A", email: "same@example.com" });
    const other = await createContact(OTHER, { name: "B", email: "same@example.com" });
    assert.equal(other.companyId, OTHER);
  });

  test("clamps score into 0..100 and rounds it", async () => {
    assert.equal((await createContact(CO, { name: "a", score: 150 })).score, 100);
    assert.equal((await createContact(CO, { name: "b", score: -20 })).score, 0);
    assert.equal((await createContact(CO, { name: "c", score: 61.6 })).score, 62);
    assert.equal((await createContact(CO, { name: "d", score: Number.NaN })).score, 0);
  });

  test("records the actor, human or AI", async () => {
    const byHuman = await createContact(CO, { name: "H" }, { userId: "u_1" });
    assert.equal(byHuman.createdById, "u_1");
    assert.equal(byHuman.createdByEmployeeId, null);
    const byAi = await createContact(CO, { name: "A" }, { employeeId: "e_1" });
    assert.equal(byAi.createdByEmployeeId, "e_1");
  });
});

describe("findContactByEmail / findContactsByEmails", () => {
  test("resolves regardless of the caller's formatting", async () => {
    await createContact(CO, { name: "Ada", email: "ada@example.com" });
    assert.ok(await findContactByEmail(CO, "Ada Lovelace <ADA@Example.com>"));
  });

  test("returns null for junk instead of throwing", async () => {
    assert.equal(await findContactByEmail(CO, "garbage"), null);
    assert.equal(await findContactByEmail(CO, ""), null);
  });

  test("is company-scoped", async () => {
    await createContact(OTHER, { name: "Ada", email: "ada@example.com" });
    assert.equal(await findContactByEmail(CO, "ada@example.com"), null);
  });

  test("batch lookup keys by normalized address and skips unknowns", async () => {
    await createContact(CO, { name: "A", email: "a@example.com" });
    await createContact(CO, { name: "B", email: "b@example.com" });
    const found = await findContactsByEmails(CO, ["A@example.com", "c@example.com", "junk"]);
    assert.equal(found.size, 1);
    assert.equal(found.get("a@example.com")?.name, "A");
  });

  test("batch lookup on an empty list does not query", async () => {
    assert.equal((await findContactsByEmails(CO, [])).size, 0);
  });
});

describe("upsertContactByEmail", () => {
  test("creates when absent", async () => {
    const c = await upsertContactByEmail(CO, { name: "New", email: "new@example.com" });
    assert.equal(c?.name, "New");
  });

  test("returns the existing row when present", async () => {
    const first = await createContact(CO, { name: "Existing", email: "e@example.com" });
    const again = await upsertContactByEmail(CO, { name: "Different", email: "e@example.com" });
    assert.equal(again?.id, first.id);
  });

  test("never overwrites a value a human already set", async () => {
    // An inbound email's display name must not clobber a corrected name.
    const first = await createContact(CO, {
      name: "Ada Lovelace",
      email: "e@example.com",
      title: "Countess",
    });
    await upsertContactByEmail(CO, {
      name: "ada l (via gmail)",
      email: "e@example.com",
      title: "Unknown",
    });
    const after = await getContact(CO, first.id);
    assert.equal(after?.name, "Ada Lovelace");
    assert.equal(after?.title, "Countess");
  });

  test("does fill fields that are still empty", async () => {
    const first = await createContact(CO, { name: "Ada", email: "e@example.com" });
    await upsertContactByEmail(CO, {
      name: "Ada",
      email: "e@example.com",
      title: "CTO",
      companyName: "Analytical Engines",
    });
    const after = await getContact(CO, first.id);
    assert.equal(after?.title, "CTO");
    assert.equal(after?.companyName, "Analytical Engines");
  });

  test("returns null for an unusable address rather than throwing", async () => {
    assert.equal(await upsertContactByEmail(CO, { name: "x", email: "junk" }), null);
  });

  test("links an account when the contact had none", async () => {
    const cust = await insert(Customer, { companyId: CO, name: "Acme", slug: "acme" });
    const first = await createContact(CO, { name: "Ada", email: "e@example.com" });
    await upsertContactByEmail(CO, { name: "Ada", email: "e@example.com", customerId: cust.id });
    assert.equal((await getContact(CO, first.id))?.customerId, cust.id);
  });
});

describe("updateContact", () => {
  test("applies a partial patch and leaves the rest alone", async () => {
    const c = await createContact(CO, { name: "Ada", email: "a@example.com", title: "CTO" });
    const updated = await updateContact(CO, c.id, { title: "CEO" });
    assert.equal(updated?.title, "CEO");
    assert.equal(updated?.name, "Ada");
    assert.equal(updated?.email, "a@example.com");
  });

  test("refuses to move an address onto one another contact already holds", async () => {
    await createContact(CO, { name: "A", email: "a@example.com" });
    const b = await createContact(CO, { name: "B", email: "b@example.com" });
    await assert.rejects(
      () => updateContact(CO, b.id, { email: "a@example.com" }),
      DuplicateContactError,
    );
  });

  test("re-saving a contact with its own address is not a conflict", async () => {
    const a = await createContact(CO, { name: "A", email: "a@example.com" });
    const updated = await updateContact(CO, a.id, { email: "A@Example.com", name: "A2" });
    assert.equal(updated?.name, "A2");
  });

  test("clearing the email is allowed", async () => {
    const a = await createContact(CO, { name: "A", email: "a@example.com" });
    assert.equal((await updateContact(CO, a.id, { email: "" }))?.email, "");
  });

  test("returns null for an unknown id or another company's row", async () => {
    const a = await createContact(OTHER, { name: "A" });
    assert.equal(await updateContact(CO, a.id, { name: "x" }), null);
    assert.equal(await updateContact(CO, "missing", { name: "x" }), null);
  });
});

describe("archive / restore", () => {
  test("archiving hides from the default list but keeps the row", async () => {
    const c = await createContact(CO, { name: "Gone" });
    await archiveContact(CO, c.id);
    assert.equal((await listContacts(CO)).total, 0);
    assert.equal((await listContacts(CO, { includeArchived: true })).total, 1);
    assert.ok(await getContact(CO, c.id));
  });

  test("restore brings it back", async () => {
    const c = await createContact(CO, { name: "Back" });
    await archiveContact(CO, c.id);
    await restoreContact(CO, c.id);
    assert.equal((await listContacts(CO)).total, 1);
  });

  test("archiving an unknown id returns null", async () => {
    assert.equal(await archiveContact(CO, "nope"), null);
  });
});

describe("listContacts", () => {
  test("searches name, email, company and title", async () => {
    await createContact(CO, { name: "Ada Lovelace", email: "ada@analytical.com" });
    await createContact(CO, { name: "Bob", companyName: "Analytical Engines" });
    await createContact(CO, { name: "Carol", title: "Chief Analytical Officer" });
    await createContact(CO, { name: "Dave", email: "dave@other.com" });

    assert.equal((await listContacts(CO, { q: "analytical" })).total, 3);
    assert.equal((await listContacts(CO, { q: "ADA" })).total, 1);
    assert.equal((await listContacts(CO, { q: "nothing" })).total, 0);
  });

  test("filters by lifecycle stage and owner", async () => {
    await createContact(CO, { name: "A", lifecycleStage: "customer", ownerId: "u_1" });
    await createContact(CO, { name: "B", lifecycleStage: "lead", ownerId: "u_2" });
    assert.equal((await listContacts(CO, { lifecycleStage: "customer" })).total, 1);
    assert.equal((await listContacts(CO, { ownerId: "u_2" })).total, 1);
  });

  test("sorts by most recent activity, with never-touched contacts last", async () => {
    const old = await createContact(CO, { name: "Old" });
    const fresh = await createContact(CO, { name: "Fresh" });
    await createContact(CO, { name: "Never" });
    await touchLastActivity(CO, [old.id], new Date("2026-01-01T00:00:00Z"));
    await touchLastActivity(CO, [fresh.id], new Date("2026-07-01T00:00:00Z"));

    const { rows } = await listContacts(CO);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Fresh", "Old", "Never"],
    );
  });

  test("paginates with a stable total", async () => {
    for (let i = 0; i < 7; i += 1) await createContact(CO, { name: `C${i}` });
    const page = await listContacts(CO, { limit: 3, offset: 3 });
    assert.equal(page.total, 7);
    assert.equal(page.rows.length, 3);
  });

  test("caps an absurd limit instead of trying to serve it", async () => {
    await createContact(CO, { name: "A" });
    const page = await listContacts(CO, { limit: 100_000 });
    assert.equal(page.rows.length, 1);
  });

  test("attaches the account name without an N+1", async () => {
    const cust = await insert(Customer, { companyId: CO, name: "Acme Inc", slug: "acme-inc" });
    await createContact(CO, { name: "A", customerId: cust.id });
    await createContact(CO, { name: "B" });
    const { rows } = await listContacts(CO);
    const withAccount = rows.find((r) => r.name === "A");
    const without = rows.find((r) => r.name === "B");
    assert.equal(withAccount?.customerName, "Acme Inc");
    assert.equal(without?.customerName, null);
  });

  test("never returns another company's contacts", async () => {
    await createContact(OTHER, { name: "Theirs" });
    assert.equal((await listContacts(CO)).total, 0);
  });
});

describe("touchLastActivity", () => {
  test("moves the marker forward", async () => {
    const c = await createContact(CO, { name: "A" });
    const when = new Date("2026-07-01T00:00:00Z");
    await touchLastActivity(CO, [c.id], when);
    assert.equal((await getContact(CO, c.id))?.lastActivityAt?.getTime(), when.getTime());
  });

  test("never moves it BACKWARD — a backfilled old email must not look fresh", async () => {
    const c = await createContact(CO, { name: "A" });
    const recent = new Date("2026-07-01T00:00:00Z");
    await touchLastActivity(CO, [c.id], recent);
    await touchLastActivity(CO, [c.id], new Date("2024-01-01T00:00:00Z"));
    assert.equal((await getContact(CO, c.id))?.lastActivityAt?.getTime(), recent.getTime());
  });

  test("handles an empty id list and unknown ids without error", async () => {
    await touchLastActivity(CO, [], new Date());
    await touchLastActivity(CO, ["nope"], new Date());
  });
});

describe("unsubscribe / bounce markers", () => {
  test("marks unsubscribed once and does not overwrite the original date", async () => {
    const c = await createContact(CO, { name: "A", email: "a@example.com" });
    const first = new Date("2026-01-01T00:00:00Z");
    await markContactUnsubscribed(CO, c.id, first);
    await markContactUnsubscribed(CO, c.id, new Date("2026-07-01T00:00:00Z"));
    assert.equal((await getContact(CO, c.id))?.unsubscribedAt?.getTime(), first.getTime());
  });

  test("marks bounced by address", async () => {
    const c = await createContact(CO, { name: "A", email: "a@example.com" });
    await markContactBounced(CO, "A@Example.com", new Date("2026-07-01T00:00:00Z"));
    assert.ok((await getContact(CO, c.id))?.bouncedAt);
  });

  test("bouncing an unknown or malformed address is a no-op", async () => {
    await markContactBounced(CO, "nobody@example.com");
    await markContactBounced(CO, "junk");
  });
});

describe("listStaleContacts", () => {
  test("returns contacts never touched and those touched before the cutoff", async () => {
    const stale = await createContact(CO, { name: "Stale" });
    const fresh = await createContact(CO, { name: "Fresh" });
    await createContact(CO, { name: "Never" });
    await touchLastActivity(CO, [stale.id], new Date("2026-01-01T00:00:00Z"));
    await touchLastActivity(CO, [fresh.id], new Date("2026-07-20T00:00:00Z"));

    const rows = await listStaleContacts(CO, new Date("2026-06-01T00:00:00Z"));
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ["Never", "Stale"]);
  });

  test("excludes archived contacts", async () => {
    const c = await createContact(CO, { name: "Archived" });
    await archiveContact(CO, c.id);
    assert.equal((await listStaleContacts(CO, new Date())).length, 0);
  });
});
