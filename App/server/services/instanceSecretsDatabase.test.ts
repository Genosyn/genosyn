import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import Keygrip from "keygrip";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { User } from "../db/entities/User.js";
import {
  ENCRYPTION_SECRET_PLACEHOLDER,
  INSTANCE_SECRETS_FILENAME,
  INSTANCE_SECRETS_SENTINEL_FILENAME,
  SESSION_SECRET_PLACEHOLDER,
  getEffectiveInstanceSecrets,
  resetInstanceSecretsCacheForTests,
} from "../lib/instanceSecrets.js";
import {
  deriveUnsubscribeSecret,
  signUnsubscribeToken,
  unsubscribeSecrets,
  verifyUnsubscribeToken,
} from "./revenue/unsubscribeToken.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  INSTANCE_SECRETS_DB_MARKER_KEY,
  bindInstanceSecretsToDatabase,
} from "./instanceSecretsDatabase.js";

type MutableConfig = {
  dataDir: string;
  db: { driver: "sqlite" | "postgres"; sqlitePath: string };
  sessionSecret: string;
  security: {
    multiTenant: boolean;
    encryptionSecret: string;
    previousEncryptionSecrets: string[];
  };
};

const mutable = config as unknown as MutableConfig;
let original: MutableConfig;
let tempDir = "";

before(initTestDb);

beforeEach(async () => {
  await resetTestDb();
  original = structuredClone(mutable);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-secret-db-marker-"));
  mutable.dataDir = tempDir;
  // The shared test DataSource remains in-memory SQLite. The runtime config is
  // Postgres so filesystem detection deliberately has no legacy DB signal.
  mutable.db.driver = "postgres";
  mutable.db.sqlitePath = path.join(tempDir, "unused.sqlite");
  mutable.sessionSecret = SESSION_SECRET_PLACEHOLDER;
  mutable.security.multiTenant = false;
  mutable.security.encryptionSecret = ENCRYPTION_SECRET_PLACEHOLDER;
  mutable.security.previousEncryptionSecrets = [];
  resetInstanceSecretsCacheForTests();
});

afterEach(() => {
  mutable.dataDir = original.dataDir;
  mutable.db.driver = original.db.driver;
  mutable.db.sqlitePath = original.db.sqlitePath;
  mutable.sessionSecret = original.sessionSecret;
  mutable.security.multiTenant = original.security.multiTenant;
  mutable.security.encryptionSecret = original.security.encryptionSecret;
  mutable.security.previousEncryptionSecrets = original.security.previousEncryptionSecrets;
  resetInstanceSecretsCacheForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

after(closeTestDb);

describe("managed instance secret database binding", () => {
  test("detects a legacy Postgres install after DB init and enables decrypt-only fallbacks", async () => {
    await AppDataSource.getRepository(User).save(
      AppDataSource.getRepository(User).create({
        email: "legacy@example.com",
        passwordHash: "hash",
        name: "Legacy Member",
      }),
    );

    const before = getEffectiveInstanceSecrets();
    assert.equal(before.placeholderSessionFallbackEnabled, false);
    assert.equal(before.placeholderEncryptionFallbackEnabled, false);

    await bindInstanceSecretsToDatabase();
    const after = getEffectiveInstanceSecrets();
    assert.equal(after.placeholderSessionFallbackEnabled, true);
    assert.equal(after.placeholderEncryptionFallbackEnabled, true);
    assert.ok(after.legacySessionDecryptionSecrets.includes(SESSION_SECRET_PLACEHOLDER));
    assert.ok(after.encryptionDecryptionSecrets.includes(ENCRYPTION_SECRET_PLACEHOLDER));

    const marker = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
      key: INSTANCE_SECRETS_DB_MARKER_KEY,
    });
    assert.equal(JSON.parse(marker.value).keyId, after.managedKeyId);

    const signedCookie = "genosyn.sid=forged-session";
    const publicCookieSignature = new Keygrip([SESSION_SECRET_PLACEHOLDER]).sign(signedCookie);
    assert.equal(
      new Keygrip([after.sessionSecret]).verify(signedCookie, publicCookieSignature),
      false,
    );

    const payload = {
      companyId: "company-legacy",
      contactId: null,
      email: "recipient@example.com",
    };
    const forgedUnsubscribe = signUnsubscribeToken(
      payload,
      deriveUnsubscribeSecret(ENCRYPTION_SECRET_PLACEHOLDER),
    );
    assert.equal(
      unsubscribeSecrets().some(
        (secret) => verifyUnsubscribeToken(forgedUnsubscribe, secret) !== null,
      ),
      false,
    );
  });

  test("binds a fresh database without enabling public decrypt fallbacks", async () => {
    const effective = getEffectiveInstanceSecrets();
    await bindInstanceSecretsToDatabase();

    assert.equal(effective.placeholderSessionFallbackEnabled, false);
    assert.equal(effective.placeholderEncryptionFallbackEnabled, false);
    const marker = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
      key: INSTANCE_SECRETS_DB_MARKER_KEY,
    });
    assert.equal(JSON.parse(marker.value).keyId, effective.managedKeyId);
  });

  test("fails closed when both managed files are lost and regenerated", async () => {
    const originalSecrets = getEffectiveInstanceSecrets();
    await bindInstanceSecretsToDatabase();

    fs.rmSync(path.join(tempDir, INSTANCE_SECRETS_FILENAME));
    fs.rmSync(path.join(tempDir, INSTANCE_SECRETS_SENTINEL_FILENAME));
    resetInstanceSecretsCacheForTests();
    const replacement = getEffectiveInstanceSecrets();
    assert.notEqual(replacement.managedKeyId, originalSecrets.managedKeyId);

    await assert.rejects(
      bindInstanceSecretsToDatabase(),
      /Managed instance secrets do not match this database/,
    );
    const marker = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
      key: INSTANCE_SECRETS_DB_MARKER_KEY,
    });
    assert.equal(JSON.parse(marker.value).keyId, originalSecrets.managedKeyId);
  });
});
