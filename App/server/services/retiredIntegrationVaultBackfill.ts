import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { getRetiredProvider, listRetiredProviderIds } from "../integrations/index.js";
import { recordAudit } from "./audit.js";
import { decryptConnectionConfig } from "./integrations.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { createSystemVaultItem } from "./vault.js";

/**
 * Move the credentials of retired Integrations into the company Vault.
 *
 * When a connector leaves the catalog its `IntegrationConnection` rows stay
 * behind, and their `encryptedConfig` becomes unreachable: nothing decrypts
 * it, and the integrations API has no reveal endpoint. The operator typed a
 * real API key into that row once and can no longer get it back out. So on
 * the first boot after the upgrade we decrypt each one, write it into the
 * Vault — where a human *can* reveal it, under audit — and then drop the
 * dead connection.
 *
 * Ordering matters and is why this is a boot service rather than a
 * migration. `decryptSecret` needs the complete key ring, which
 * `bindInstanceSecretsToDatabase()` only finishes assembling after
 * `runMigrations()`; and the Vault reads through `decryptSecretWithStrongKeys`,
 * so re-encrypting before `validateRuntimeSecurity()` has passed could write
 * a row that is never readable again. Both have run by the time `main()`
 * calls this.
 *
 * Idempotent: it processes only providers in the retired table, and each row
 * it processes is deleted in the same transaction that writes the Vault item.
 * A second boot finds nothing.
 *
 * That argument only holds for boots that do not overlap. Two Postgres
 * replicas starting together would each read the same rows before either
 * deleted them and write the credential into the Vault twice, so the work
 * takes a scheduler lease first — the same one `bootBackups` uses, and a
 * no-op on single-process SQLite.
 */
export async function backfillRetiredIntegrationsIntoVault(): Promise<void> {
  await withSchedulerLease("retired-integration-vault-backfill", 30 * 60_000, async () => {
    await moveRetiredIntegrationCredentials();
    await markRetiredBrowserLoginConnections();
  });
}

/**
 * Flag Connections left over from the retired browser-login auth mode.
 *
 * These are not retired *providers* — X is still registered, so the rows keep
 * a live provider id and skip the migration above. What they lost is their
 * auth mode: no driver replays their password any more, and every tool call
 * refuses. Nothing re-checks a Connection on its own, so without this they sit
 * at whatever status they were last saved with — typically a green
 * "Connected" badge over something that cannot answer a single call.
 *
 * Their credential stays sealed on the row rather than moving to the Vault: it
 * is a site password whose replacement is a Vault login the operator captures
 * against the real origin, not a config blob worth transplanting.
 */
async function markRetiredBrowserLoginConnections(): Promise<void> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const result = await repo.update(
    { authMode: "browser", status: "connected" },
    {
      status: "error",
      statusMessage:
        "Browser login was retired. Connect this Integration over OAuth instead, and keep the site password in the Vault so the built-in Browser can sign in under a Grant.",
      lastCheckedAt: new Date(),
    },
  );
  if (result.affected) {
    // eslint-disable-next-line no-console
    console.log(
      `[vault-backfill] flagged ${result.affected} retired browser-login connection(s)`,
    );
  }
}

async function moveRetiredIntegrationCredentials(): Promise<void> {
  const retiredIds = listRetiredProviderIds();
  if (retiredIds.length === 0) return;

  const rows = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { provider: In(retiredIds) },
  });
  if (rows.length === 0) return;

  let moved = 0;
  let skipped = 0;

  for (const conn of rows) {
    const retired = getRetiredProvider(conn.provider);
    if (!retired) continue;

    let config: Record<string, unknown>;
    try {
      config = decryptConnectionConfig(conn) as Record<string, unknown>;
    } catch (err) {
      // A row encrypted under a key this instance no longer holds is exactly
      // the row we must not destroy: leave it, say so once, and let the
      // operator decide.
      //
      // Mark it too. Every row this function *succeeds* on is deleted, so an
      // undecryptable row is the only kind that survives into the connection
      // list — and without a message there it would look like an ordinary
      // retired connector whose secret had been moved, which is the opposite
      // of what happened.
      skipped += 1;
      await AppDataSource.getRepository(IntegrationConnection).update(
        { id: conn.id },
        {
          status: "error",
          statusMessage:
            "Its saved credential could not be read with this instance's encryption key, so it was left here rather than moved.",
          lastCheckedAt: new Date(),
        },
      );
      // eslint-disable-next-line no-console
      console.warn(
        `[vault-backfill] ${retired.name} connection ${conn.id} could not be decrypted; leaving it in place:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // The credential goes in `secret`, never in `notes`. `notes` is returned
    // by the ordinary item view; `secret` requires an explicit reveal, which
    // is separately audited. Putting a migrated key anywhere else would make
    // the move a downgrade in exposure.
    // One transaction, one manager. Reaching for AppDataSource.getRepository
    // inside the callback would run on a different connection and quietly
    // leave the transaction empty — which here would mean deleting the
    // Connection without the Vault item having been committed.
    const item = await AppDataSource.transaction(async (manager) => {
      const created = await createSystemVaultItem({
        manager,
        companyId: conn.companyId,
        type: "secure_note",
        payload: {
          title: `${retired.name}${conn.label ? ` — ${conn.label}` : ""} (retired Integration)`,
          username: conn.accountHint ?? "",
          secret: JSON.stringify(config, null, 2),
          websiteUrl: "",
          notes: [
            `Moved out of the ${retired.name} Integration when it was retired in ${retired.retiredIn}.`,
            retired.reason,
            "",
            `Original connection: ${conn.label || "(unlabelled)"} · ${conn.authMode} · created ${conn.createdAt.toISOString()}`,
            "The saved secret is the connector's raw configuration JSON.",
          ].join("\n"),
        },
      });
      await manager.getRepository(EmployeeConnectionGrant).delete({
        connectionId: conn.id,
      });
      await manager.getRepository(IntegrationConnection).delete({ id: conn.id });
      return created;
    });

    moved += 1;
    await recordAudit({
      companyId: conn.companyId,
      actorKind: "system",
      action: "vault.item.create",
      targetType: "vault_item",
      targetId: item.id,
      targetLabel: "Vault item",
      metadata: {
        source: "retired_integration_backfill",
        provider: conn.provider,
        retiredIn: retired.retiredIn,
        type: "secure_note",
      },
    });
  }

  if (moved > 0 || skipped > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[vault-backfill] retired Integrations: ${moved} credential(s) moved into the Vault, ${skipped} left in place`,
    );
  }
}
