import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { encryptSecret } from "../lib/secret.js";
import { listRetiredProviderIds } from "../integrations/index.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { revealVaultItem } from "./vault.js";
import { backfillRetiredIntegrationsIntoVault } from "./retiredIntegrationVaultBackfill.js";

const COMPANY = testCompanyId();
const ADMIN = { userId: "admin-user", role: "admin" as const };

function connection(values: Partial<IntegrationConnection>): Partial<IntegrationConnection> {
  return {
    companyId: COMPANY,
    provider: "nostr",
    label: "Company relay",
    authMode: "apikey",
    accountHint: "npub1abc…xyz9",
    status: "connected",
    statusMessage: "",
    encryptedConfig: encryptSecret(JSON.stringify({ nsec: "nsec1secret" }), `company:${COMPANY}`),
    ...values,
  };
}

describe("retired Integration Vault backfill", () => {
  before(initTestDb);
  after(closeTestDb);
  beforeEach(resetTestDb);

  test("nostr is a retired provider id", () => {
    assert.ok(listRetiredProviderIds().includes("nostr"));
  });

  test("moves a retired connection's credential into the Vault and drops the row", async () => {
    const conn = await insert(IntegrationConnection, connection({}));

    await backfillRetiredIntegrationsIntoVault();

    const items = await AppDataSource.getRepository(VaultItem).find({
      where: { companyId: COMPANY },
    });
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.type, "secure_note");
    // A null author plus `restricted` is the Vault's tightest combination:
    // only company owners and admins can reach it.
    assert.equal(item.visibility, "restricted");
    assert.equal(item.createdByUserId, null);
    assert.equal(item.createdByEmployeeId, null);

    const revealed = await revealVaultItem({
      companyId: COMPANY,
      itemId: item.id,
      actor: ADMIN,
    });
    assert.equal(JSON.parse(revealed.secret).nsec, "nsec1secret");
    assert.match(revealed.item.title, /^Nostr — Company relay \(retired Integration\)$/);
    assert.equal(revealed.item.username, "npub1abc…xyz9");

    // The credential must not be readable without a reveal.
    assert.doesNotMatch(revealed.item.notes, /nsec1secret/);

    assert.equal(await AppDataSource.getRepository(IntegrationConnection).countBy({ id: conn.id }), 0);
  });

  test("revokes the employee Grants that pointed at the dropped connection", async () => {
    const conn = await insert(IntegrationConnection, connection({}));
    await insert(EmployeeConnectionGrant, {
      employeeId: "employee-1",
      connectionId: conn.id,
    });

    await backfillRetiredIntegrationsIntoVault();

    assert.equal(
      await AppDataSource.getRepository(EmployeeConnectionGrant).countBy({ connectionId: conn.id }),
      0,
    );
  });

  test("leaves connections for providers that are still registered alone", async () => {
    const conn = await insert(IntegrationConnection, connection({ provider: "stripe" }));

    await backfillRetiredIntegrationsIntoVault();

    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 0);
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).countBy({ id: conn.id }), 1);
  });

  test("leaves an undecryptable row in place rather than destroying it", async () => {
    const conn = await insert(
      IntegrationConnection,
      connection({ encryptedConfig: "v2.not-a-real-ciphertext" }),
    );

    await backfillRetiredIntegrationsIntoVault();

    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 0);
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).countBy({ id: conn.id }), 1);
  });

  test("is idempotent — a second boot moves nothing further", async () => {
    await insert(IntegrationConnection, connection({}));

    await backfillRetiredIntegrationsIntoVault();
    await backfillRetiredIntegrationsIntoVault();

    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 1);
  });

  test("records a system audit event naming the retirement, without the secret", async () => {
    await insert(IntegrationConnection, connection({}));

    await backfillRetiredIntegrationsIntoVault();

    const events = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: COMPANY, action: "vault.item.create" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actorKind, "system");
    assert.equal(events[0].actorUserId, null);
    const metadata = JSON.parse(events[0].metadataJson) as Record<string, unknown>;
    assert.equal(metadata.source, "retired_integration_backfill");
    assert.equal(metadata.provider, "nostr");
    assert.doesNotMatch(events[0].metadataJson, /nsec1secret/);
  });

  test("marks a row it could not decrypt, so the card does not read as healthy", async () => {
    const conn = await insert(
      IntegrationConnection,
      connection({ encryptedConfig: "v2.not-a-real-ciphertext" }),
    );

    await backfillRetiredIntegrationsIntoVault();

    const after = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: conn.id,
    });
    assert.equal(after.status, "error");
    assert.match(after.statusMessage, /could not be read/i);
    assert.notEqual(after.lastCheckedAt, null);
  });

  test("flags a leftover browser-login connection instead of leaving it green", async () => {
    // X is still a registered provider, so this row is never a migration
    // candidate — only its auth mode was retired.
    const conn = await insert(
      IntegrationConnection,
      connection({ provider: "x", authMode: "browser", label: "X browser login" }),
    );

    await backfillRetiredIntegrationsIntoVault();

    const after = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: conn.id,
    });
    assert.equal(after.status, "error");
    assert.match(after.statusMessage, /browser login was retired/i);
    // Its credential stays sealed on the row rather than moving to the Vault.
    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 0);
  });

  test("leaves an already-failed browser-login row's own message alone", async () => {
    const conn = await insert(
      IntegrationConnection,
      connection({
        provider: "x",
        authMode: "browser",
        status: "expired",
        statusMessage: "Sign-in challenge was never answered.",
      }),
    );

    await backfillRetiredIntegrationsIntoVault();

    const after = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: conn.id,
    });
    assert.equal(after.statusMessage, "Sign-in challenge was never answered.");
  });

  test("keeps each company's migrated credential inside its own company", async () => {
    const otherCompany = `${COMPANY}-other`;
    await insert(IntegrationConnection, connection({}));
    await insert(
      IntegrationConnection,
      connection({
        companyId: otherCompany,
        label: "Other relay",
        encryptedConfig: encryptSecret(
          JSON.stringify({ nsec: "nsec1other" }),
          `company:${otherCompany}`,
        ),
      }),
    );

    await backfillRetiredIntegrationsIntoVault();

    const repo = AppDataSource.getRepository(VaultItem);
    assert.equal(await repo.countBy({ companyId: COMPANY }), 1);
    assert.equal(await repo.countBy({ companyId: otherCompany }), 1);
  });
});
