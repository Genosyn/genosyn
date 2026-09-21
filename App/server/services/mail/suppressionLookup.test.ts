import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { Suppression } from "../../db/entities/Suppression.js";
import { lookupSuppression } from "./suppression.js";

test("suppression lookup distinguishes clear, blocked and unknown without a Contact", async (t) => {
  let suppression: Partial<Suppression> | null = null;
  let contactBlocked = false;
  let suppressionUnavailable = false;
  let contactsUnavailable = false;
  t.mock.method(AppDataSource, "getRepository", (entity: unknown) =>
    entity === Suppression
      ? {
          findOneBy: async (where: { companyId: string; email: string }) => {
            assert.equal(where.companyId, "company-1");
            assert.equal(where.email, "person+tag@example.com");
            if (suppressionUnavailable) throw new Error("private database coordinates");
            return suppression;
          },
        }
      : {
          find: async () => {
            if (contactsUnavailable) throw new Error("private database coordinates");
            return contactBlocked ? [{ id: "contact-1" }] : [];
          },
        },
  );
  const lookup = () => lookupSuppression("company-1", "Person <PERSON+tag@example.com>");
  assert.equal((await lookup()).status, "clear");
  for (const reason of ["unsubscribe", "bounce"] as const) {
    suppression = {
      id: "suppression-1",
      reason,
      source: "inbound",
      createdAt: new Date(),
      contactId: null,
    };
    const result = await lookup();
    assert.equal(result.status, "suppressed");
    assert.equal(result.suppression?.reason, reason);
  }
  contactsUnavailable = true;
  assert.equal(
    (await lookup()).status,
    "suppressed",
    "known suppression wins over partial failure",
  );
  suppression = null;
  const unknown = await lookup();
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.suppressed, null);
  assert.equal(unknown.coverage.complete, false);
  assert.doesNotMatch(JSON.stringify(unknown), /private database/);
  contactsUnavailable = false;
  contactBlocked = true;
  suppressionUnavailable = true;
  assert.equal(
    (await lookup()).status,
    "suppressed",
    "known do-not-contact wins over partial failure",
  );
  contactBlocked = false;
  assert.equal((await lookup()).status, "unknown");
  contactsUnavailable = true;
  assert.equal((await lookup()).status, "unknown");
  await assert.rejects(() => lookupSuppression("company-1", "invalid"));
});
