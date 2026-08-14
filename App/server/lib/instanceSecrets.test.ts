import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import Keygrip from "keygrip";

import { config } from "../../config.js";
import {
  ENCRYPTION_SECRET_PLACEHOLDER,
  SESSION_SECRET_PLACEHOLDER,
  getEffectiveInstanceSecrets,
  isStrongInstanceSecret,
  reloadEffectiveInstanceSecrets,
  resetInstanceSecretsCacheForTests,
  restoreManagedInstanceSecretsIfMissing,
  snapshotManagedInstanceSecrets,
} from "./instanceSecrets.js";
import { decryptSecret, decryptSecretWithStrongKeys, encryptSecret } from "./secret.js";
import {
  deriveUnsubscribeSecret,
  signUnsubscribeToken,
  unsubscribeSecret,
  unsubscribeSecrets,
  verifyUnsubscribeToken,
} from "../services/revenue/unsubscribeToken.js";

type MutableConfig = {
  dataDir: string;
  db: {
    driver: "sqlite" | "postgres";
    sqlitePath: string;
  };
  sessionSecret: string;
  security: {
    multiTenant: boolean;
    encryptionSecret: string;
    previousEncryptionSecrets: string[];
  };
};

const mutable = config as unknown as MutableConfig;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let original: MutableConfig;
let tempDir = "";

beforeEach(() => {
  original = structuredClone(mutable);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-instance-secrets-"));
  mutable.dataDir = tempDir;
  mutable.db.driver = "sqlite";
  mutable.db.sqlitePath = path.join(tempDir, "app.sqlite");
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

function managedPath(): string {
  return path.join(tempDir, ".instance-secrets.json");
}

function sentinelPath(): string {
  return path.join(tempDir, ".instance-secrets.required");
}

function encryptV2WithMaster(plaintext: string, master: string, scope: string): string {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(master, "utf8"),
      Buffer.from("genosyn-secret-v2", "utf8"),
      Buffer.from(scope, "utf8"),
      32,
    ),
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`v2:${scope}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v2",
    Buffer.from(scope, "utf8").toString("base64url"),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function encryptLegacyWithSessionSecret(plaintext: string, sessionSecret: string): string {
  const key = crypto.createHash("sha256").update(sessionSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

async function resolveInChild(dataDir: string): Promise<[string, string]> {
  const script = `
    import { config } from "./config.ts";
    config.dataDir = ${JSON.stringify(dataDir)};
    config.db.sqlitePath = ${JSON.stringify(path.join(dataDir, "app.sqlite"))};
    config.security.multiTenant = false;
    const { getEffectiveInstanceSecrets } = await import("./server/lib/instanceSecrets.ts");
    const value = getEffectiveInstanceSecrets();
    process.stdout.write(JSON.stringify([value.sessionSecret, value.encryptionSecret]));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as [string, string]);
    });
  });
}

describe("managed instance secrets", () => {
  test("concurrent first-boot processes converge on one atomic value pair", async () => {
    const [first, second] = await Promise.all([resolveInChild(tempDir), resolveInChild(tempDir)]);
    assert.deepEqual(first, second);
    resetInstanceSecretsCacheForTests();
    const parent = getEffectiveInstanceSecrets();
    assert.deepEqual(first, [parent.sessionSecret, parent.encryptionSecret]);
    assert.equal(fs.statSync(managedPath()).mode & 0o777, 0o600);
  });

  test("creates distinct durable 0600 secrets without enabling public fallbacks on a fresh install", () => {
    const first = getEffectiveInstanceSecrets();
    assert.equal(first.sessionSecret.length, 64);
    assert.equal(first.encryptionSecret.length, 64);
    assert.notEqual(first.sessionSecret, first.encryptionSecret);
    assert.equal(first.usingManagedSessionSecret, true);
    assert.equal(first.usingManagedEncryptionSecret, true);
    assert.equal(first.placeholderSessionFallbackEnabled, false);
    assert.equal(first.placeholderEncryptionFallbackEnabled, false);
    assert.equal(first.encryptionDecryptionSecrets.includes(ENCRYPTION_SECRET_PLACEHOLDER), false);
    assert.equal(first.encryptionDecryptionSecrets.includes(SESSION_SECRET_PLACEHOLDER), false);
    assert.equal(first.legacySessionDecryptionSecrets.includes(SESSION_SECRET_PLACEHOLDER), false);
    assert.equal(fs.statSync(managedPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sentinelPath()).mode & 0o777, 0o600);
    const signedCookie = "genosyn.sid=forged-session";
    const publicSignature = new Keygrip([SESSION_SECRET_PLACEHOLDER]).sign(signedCookie);
    assert.equal(new Keygrip([first.sessionSecret]).verify(signedCookie, publicSignature), false);

    const freshPlaceholderV2 = encryptV2WithMaster(
      "forged",
      ENCRYPTION_SECRET_PLACEHOLDER,
      "company:fresh",
    );
    const freshPlaceholderLegacy = encryptLegacyWithSessionSecret(
      "forged",
      SESSION_SECRET_PLACEHOLDER,
    );
    assert.throws(() => decryptSecret(freshPlaceholderV2));
    assert.throws(() => decryptSecret(freshPlaceholderLegacy));

    resetInstanceSecretsCacheForTests();
    const afterRestart = getEffectiveInstanceSecrets();
    assert.equal(afterRestart.sessionSecret, first.sessionSecret);
    assert.equal(afterRestart.encryptionSecret, first.encryptionSecret);
  });

  test("enables decrypt-only placeholder compatibility for an existing self-host upgrade", () => {
    fs.writeFileSync(mutable.db.sqlitePath, "existing database marker");
    const effective = getEffectiveInstanceSecrets();
    assert.equal(effective.placeholderSessionFallbackEnabled, true);
    assert.equal(effective.placeholderEncryptionFallbackEnabled, true);

    const oldV2 = encryptV2WithMaster(
      "old v2 value",
      ENCRYPTION_SECRET_PLACEHOLDER,
      "company:upgrade",
    );
    const oldLegacy = encryptLegacyWithSessionSecret(
      "old legacy value",
      SESSION_SECRET_PLACEHOLDER,
    );
    assert.equal(decryptSecret(oldV2), "old v2 value");
    assert.equal(decryptSecret(oldLegacy), "old legacy value");
    assert.throws(() => decryptSecretWithStrongKeys(oldV2));

    const newlyEncrypted = encryptSecret("new managed value", "company:upgrade");
    assert.equal(decryptSecret(newlyEncrypted), "new managed value");
    assert.equal(decryptSecretWithStrongKeys(newlyEncrypted), "new managed value");
    assert.throws(() => {
      const parts = newlyEncrypted.split(".");
      const scope = Buffer.from(parts[1], "base64url").toString("utf8");
      const key = Buffer.from(
        crypto.hkdfSync(
          "sha256",
          Buffer.from(ENCRYPTION_SECRET_PLACEHOLDER, "utf8"),
          Buffer.from("genosyn-secret-v2", "utf8"),
          Buffer.from(scope, "utf8"),
          32,
        ),
      );
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(parts[2], "base64url"),
      );
      decipher.setAAD(Buffer.from(`v2:${scope}`, "utf8"));
      decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
      decipher.update(Buffer.from(parts[4], "base64url"));
      decipher.final();
    });
  });

  test("keeps explicit strong values authoritative without creating managed state", () => {
    const explicitSession = "s".repeat(48);
    const explicitEncryption = "e".repeat(48);
    mutable.sessionSecret = explicitSession;
    mutable.security.encryptionSecret = explicitEncryption;
    const effective = getEffectiveInstanceSecrets();
    assert.equal(effective.sessionSecret, explicitSession);
    assert.equal(effective.encryptionSecret, explicitEncryption);
    assert.equal(effective.managedFilePath, null);
    assert.equal(fs.existsSync(managedPath()), false);
    assert.equal(
      effective.encryptionDecryptionSecrets.includes(ENCRYPTION_SECRET_PLACEHOLDER),
      false,
    );
  });

  test("supports a mixed explicit session and managed encryption configuration", () => {
    const explicitSession = "explicit-session-secret-".padEnd(48, "s");
    mutable.sessionSecret = explicitSession;
    const effective = getEffectiveInstanceSecrets();
    assert.equal(effective.sessionSecret, explicitSession);
    assert.equal(effective.usingManagedSessionSecret, false);
    assert.equal(effective.usingManagedEncryptionSecret, true);
    assert.notEqual(effective.encryptionSecret, ENCRYPTION_SECRET_PLACEHOLDER);
    assert.notEqual(effective.encryptionSecret, explicitSession);
    assert.ok(fs.existsSync(managedPath()));
  });

  test("retains an existing managed encryption key after moving to explicit config", () => {
    const managed = getEffectiveInstanceSecrets();
    const managedCiphertext = encryptSecret("managed era", "company:rotation");
    mutable.sessionSecret = "explicit-session-".padEnd(48, "s");
    mutable.security.encryptionSecret = "explicit-encryption-".padEnd(48, "e");
    resetInstanceSecretsCacheForTests();

    const explicit = getEffectiveInstanceSecrets();
    assert.equal(explicit.sessionSecret, mutable.sessionSecret);
    assert.equal(explicit.encryptionSecret, mutable.security.encryptionSecret);
    assert.ok(explicit.encryptionDecryptionSecrets.includes(managed.encryptionSecret));
    assert.ok(explicit.legacySessionDecryptionSecrets.includes(managed.sessionSecret));
    assert.equal(decryptSecret(managedCiphertext), "managed era");
  });

  test("preserves the identity and old ciphertext across a pre-managed data restore", () => {
    const before = getEffectiveInstanceSecrets();
    const snapshot = snapshotManagedInstanceSecrets();
    assert.ok(snapshot);
    fs.rmSync(managedPath());
    fs.rmSync(sentinelPath());

    restoreManagedInstanceSecretsIfMissing(snapshot, {
      enablePlaceholderCompatibility: true,
    });
    const after = reloadEffectiveInstanceSecrets();
    assert.equal(after.sessionSecret, before.sessionSecret);
    assert.equal(after.encryptionSecret, before.encryptionSecret);
    assert.equal(after.placeholderSessionFallbackEnabled, true);
    assert.equal(after.placeholderEncryptionFallbackEnabled, true);
    assert.equal(
      decryptSecret(
        encryptV2WithMaster("restored old v2", ENCRYPTION_SECRET_PLACEHOLDER, "company:restored"),
      ),
      "restored old v2",
    );
    assert.equal(
      decryptSecret(
        encryptLegacyWithSessionSecret("restored old legacy", SESSION_SECRET_PLACEHOLDER),
      ),
      "restored old legacy",
    );
    assert.equal(fs.statSync(managedPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sentinelPath()).mode & 0o777, 0o600);
  });

  test("reloads an archive-supplied managed identity instead of mixing it with the current one", () => {
    const first = getEffectiveInstanceSecrets();
    const firstSnapshot = snapshotManagedInstanceSecrets();
    assert.ok(firstSnapshot);

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-other-instance-"));
    try {
      mutable.dataDir = otherDir;
      mutable.db.sqlitePath = path.join(otherDir, "app.sqlite");
      resetInstanceSecretsCacheForTests();
      const other = getEffectiveInstanceSecrets();
      const otherSnapshot = snapshotManagedInstanceSecrets();
      assert.ok(otherSnapshot);
      assert.notEqual(other.encryptionSecret, first.encryptionSecret);

      mutable.dataDir = tempDir;
      mutable.db.sqlitePath = path.join(tempDir, "app.sqlite");
      fs.rmSync(managedPath());
      fs.rmSync(sentinelPath());
      resetInstanceSecretsCacheForTests();
      restoreManagedInstanceSecretsIfMissing(otherSnapshot);
      // A preserved current snapshot must not overwrite archive-supplied state.
      restoreManagedInstanceSecretsIfMissing(firstSnapshot);
      const restored = reloadEffectiveInstanceSecrets();
      assert.equal(restored.sessionSecret, other.sessionSecret);
      assert.equal(restored.encryptionSecret, other.encryptionSecret);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
      mutable.dataDir = tempDir;
      mutable.db.sqlitePath = path.join(tempDir, "app.sqlite");
      resetInstanceSecretsCacheForTests();
    }
  });

  test("requires explicit secrets in multi-tenant mode and never creates a managed file", () => {
    mutable.security.multiTenant = true;
    assert.throws(getEffectiveInstanceSecrets, /require explicit session and encryption secrets/);
    assert.equal(fs.existsSync(managedPath()), false);
  });

  test("fails closed on malformed managed state and repairs its permissions before reading", () => {
    fs.writeFileSync(managedPath(), "not json", { mode: 0o644 });
    assert.throws(getEffectiveInstanceSecrets, /could not be read as JSON/);
    assert.equal(fs.statSync(managedPath()).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(managedPath(), "utf8"), "not json");
  });

  test("rejects short, equal, and non-regular managed secret state", () => {
    const base = {
      version: 1,
      sessionSecret: "s".repeat(48),
      encryptionSecret: "e".repeat(48),
      compatibility: {
        placeholderSessionDecryption: false,
        placeholderEncryptionDecryption: false,
      },
    };
    for (const candidate of [
      { ...base, sessionSecret: "short" },
      { ...base, encryptionSecret: base.sessionSecret },
      { ...base, version: 99 },
    ]) {
      fs.writeFileSync(managedPath(), JSON.stringify(candidate), { mode: 0o600 });
      resetInstanceSecretsCacheForTests();
      assert.throws(getEffectiveInstanceSecrets);
      fs.rmSync(managedPath());
    }
    fs.mkdirSync(managedPath());
    resetInstanceSecretsCacheForTests();
    assert.throws(getEffectiveInstanceSecrets, /must be a regular file/);
  });

  test("refuses to regenerate after a managed secret file is lost", () => {
    getEffectiveInstanceSecrets();
    fs.rmSync(managedPath());
    resetInstanceSecretsCacheForTests();
    assert.throws(
      getEffectiveInstanceSecrets,
      /is missing; restore it from the same backup as the database/,
    );
    assert.equal(fs.existsSync(managedPath()), false);
  });

  test("never accepts public-placeholder unsubscribe forgeries", () => {
    mutable.security.previousEncryptionSecrets = [
      ENCRYPTION_SECRET_PLACEHOLDER,
      SESSION_SECRET_PLACEHOLDER,
      "weak-previous-key",
    ];
    const payload = {
      companyId: "company-safe",
      contactId: "contact-safe",
      email: "recipient@example.com",
    };
    const forged = signUnsubscribeToken(
      payload,
      deriveUnsubscribeSecret(ENCRYPTION_SECRET_PLACEHOLDER),
    );
    assert.equal(
      unsubscribeSecrets().some((secret) => verifyUnsubscribeToken(forged, secret) !== null),
      false,
    );
    assert.equal(
      getEffectiveInstanceSecrets().encryptionDecryptionSecrets.some(
        (secret) => !isStrongInstanceSecret(secret),
      ),
      false,
    );

    const valid = signUnsubscribeToken(payload, unsubscribeSecret());
    resetInstanceSecretsCacheForTests();
    assert.deepEqual(
      unsubscribeSecrets()
        .map((secret) => verifyUnsubscribeToken(valid, secret))
        .find(Boolean),
      payload,
    );
  });

  test("keeps links signed by a strong configured previous encryption key valid", () => {
    const oldEncryptionSecret = "old-private-encryption-key-".padEnd(48, "x");
    mutable.security.previousEncryptionSecrets = [oldEncryptionSecret];
    const payload = {
      companyId: "company-rotation",
      contactId: null,
      email: "rotation@example.com",
    };
    const oldToken = signUnsubscribeToken(payload, deriveUnsubscribeSecret(oldEncryptionSecret));
    assert.deepEqual(
      unsubscribeSecrets()
        .map((secret) => verifyUnsubscribeToken(oldToken, secret))
        .find(Boolean),
      payload,
    );
  });
});
