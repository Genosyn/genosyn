import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import {
  ENCRYPTION_SECRET_PLACEHOLDER,
  SESSION_SECRET_PLACEHOLDER,
  enableLegacyPlaceholderDecryption,
  getEffectiveInstanceSecrets,
} from "../lib/instanceSecrets.js";

export const INSTANCE_SECRETS_DB_MARKER_KEY = "instance.managedSecretsKeyId";
const MARKER_VERSION = 1;

type DatabaseMarker = {
  version: typeof MARKER_VERSION;
  keyId: string;
};

function parseMarker(value: string): DatabaseMarker {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("The database contains an invalid managed-secret marker", {
      cause: error,
    });
  }
  const marker = decoded as Partial<DatabaseMarker>;
  if (
    marker.version !== MARKER_VERSION ||
    typeof marker.keyId !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.keyId)
  ) {
    throw new Error("The database contains an invalid managed-secret marker");
  }
  return { version: MARKER_VERSION, keyId: marker.keyId };
}

function assertMarkerMatches(marker: DatabaseMarker, managedKeyId: string | null): void {
  if (!managedKeyId) {
    throw new Error(
      "The database requires managed instance secrets, but .instance-secrets.json is missing",
    );
  }
  if (marker.keyId !== managedKeyId) {
    throw new Error(
      "Managed instance secrets do not match this database; restore both from the same backup",
    );
  }
}

async function legacyInstallationHasRows(): Promise<boolean> {
  const [users, companies] = await Promise.all([
    AppDataSource.getRepository(User).count(),
    AppDataSource.getRepository(Company).count(),
  ]);
  return users > 0 || companies > 0;
}

/**
 * Bind a managed secret file to the initialized database before any service
 * reads encrypted rows or starts background work.
 *
 * An existing marker must match. Without a marker, a non-empty legacy database
 * enables only the placeholder-configured decrypt fallbacks before the marker
 * is inserted. The insert deliberately does not upsert: concurrent first boots
 * race on the primary key, then the loser verifies the winner instead of ever
 * overwriting a different installation identity.
 */
export async function bindInstanceSecretsToDatabase(): Promise<void> {
  if (config.security.multiTenant) return;

  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key: INSTANCE_SECRETS_DB_MARKER_KEY });
  let effective = getEffectiveInstanceSecrets();
  if (existing) {
    assertMarkerMatches(parseMarker(existing.value), effective.managedKeyId);
    return;
  }
  if (!effective.managedKeyId) return;

  if (await legacyInstallationHasRows()) {
    effective = enableLegacyPlaceholderDecryption({
      session: String(config.sessionSecret) === SESSION_SECRET_PLACEHOLDER,
      encryption: String(config.security.encryptionSecret) === ENCRYPTION_SECRET_PLACEHOLDER,
    });
  }

  const marker: DatabaseMarker = {
    version: MARKER_VERSION,
    keyId: effective.managedKeyId!,
  };
  try {
    await repo.insert({
      key: INSTANCE_SECRETS_DB_MARKER_KEY,
      value: JSON.stringify(marker),
    });
  } catch (error) {
    const winner = await repo.findOneBy({ key: INSTANCE_SECRETS_DB_MARKER_KEY });
    if (!winner) throw error;
    assertMarkerMatches(parseMarker(winner.value), effective.managedKeyId);
  }
}
