import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppSetting } from "../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  LICENSE_KEY_SETTING,
  _setVerifyKeysForTest,
  getInstanceLicense,
  invalidateLicenseCache,
  maskLicenseKey,
  parseLicenseKey,
  signLicense,
  verifyLicenseKeyWith,
  type LicensePayload,
} from "./license.js";

/**
 * The Ed25519 license format end to end with EPHEMERAL keys — the shipped
 * `LICENSE_VERIFY_PUBLIC_KEYS` array stays empty in tests, and trust is
 * injected per-test through the pure `verifyLicenseKeyWith` or the
 * `_setVerifyKeysForTest` seam.
 */

function keypair(): { publicKeyB64: string; privatePem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function payloadFor(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    company: "Acme Corp",
    email: "ops@acme.test",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    seats: 25,
    evaluation: false,
    ...overrides,
  };
}

describe("sign → verify roundtrip", () => {
  test("a signed key verifies against its public key and carries the payload", () => {
    const { publicKeyB64, privatePem } = keypair();
    const payload = payloadFor();
    const key = signLicense(privatePem, payload);
    assert.ok(key.startsWith("genlic1."));
    const verified = verifyLicenseKeyWith([publicKeyB64], key);
    assert.ok(verified);
    assert.deepEqual(verified.payload, payload);
  });

  test("verification succeeds when ANY key in the rotation list matches", () => {
    const old = keypair();
    const current = keypair();
    const key = signLicense(current.privatePem, payloadFor());
    assert.ok(verifyLicenseKeyWith([old.publicKeyB64, current.publicKeyB64], key));
  });

  test("a wrong key, an empty list, and a garbage entry all refuse", () => {
    const signer = keypair();
    const other = keypair();
    const key = signLicense(signer.privatePem, payloadFor());
    assert.equal(verifyLicenseKeyWith([other.publicKeyB64], key), null);
    assert.equal(verifyLicenseKeyWith([], key), null);
    // A malformed entry must not mask a later valid one.
    assert.ok(verifyLicenseKeyWith(["not-a-key", signer.publicKeyB64], key));
  });

  test("a tampered payload fails verification but still parses", () => {
    const { publicKeyB64, privatePem } = keypair();
    const key = signLicense(privatePem, payloadFor({ seats: 1 }));
    const [prefix, , signature] = key.split(".");
    const forged = Buffer.from(
      JSON.stringify(payloadFor({ seats: 10_000 })),
      "utf8",
    ).toString("base64url");
    const tampered = `${prefix}.${forged}.${signature}`;
    assert.equal(verifyLicenseKeyWith([publicKeyB64], tampered), null);
    // parseLicenseKey decodes without trusting — display-only.
    assert.equal(parseLicenseKey(tampered)?.payload.seats, 10_000);
  });

  test("junk strings neither parse nor verify", () => {
    const { publicKeyB64 } = keypair();
    for (const junk of ["", "genlic1", "genlic2.a.b", "genlic1.%%%.%%%", "genlic1.a"]) {
      assert.equal(parseLicenseKey(junk), null);
      assert.equal(verifyLicenseKeyWith([publicKeyB64], junk), null);
    }
  });
});

describe("mask format", () => {
  test("keeps the prefix and 4+4 characters of the body", () => {
    const { privatePem } = keypair();
    const key = signLicense(privatePem, payloadFor());
    const masked = maskLicenseKey(key);
    assert.match(masked, /^genlic1\..{4}….{4}$/);
    assert.ok(masked.length < 20);
    assert.equal(masked.slice(8, 12), key.slice(8, 12));
    assert.equal(masked.slice(-4), key.slice(-4));
  });
});

describe("instance license status (DB-backed)", () => {
  const signer = keypair();

  before(async () => {
    await initTestDb();
    _setVerifyKeysForTest([signer.publicKeyB64]);
  });

  after(async () => {
    _setVerifyKeysForTest(null);
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    invalidateLicenseCache();
  });

  async function seedKey(payload: LicensePayload): Promise<void> {
    await insert(AppSetting, {
      key: LICENSE_KEY_SETTING,
      value: signLicense(signer.privatePem, payload),
    });
    invalidateLicenseCache();
  }

  test("no stored key → status none, features off", async () => {
    const status = await getInstanceLicense();
    assert.equal(status.status, "none");
    assert.equal(status.featureValid, false);
    assert.equal(status.payload, null);
  });

  test("a valid paid key → status valid, features on", async () => {
    await seedKey(payloadFor());
    const status = await getInstanceLicense();
    assert.equal(status.status, "valid");
    assert.equal(status.featureValid, true);
    assert.equal(status.payload?.company, "Acme Corp");
  });

  test("an expired PAID key → status expired but features STAY ON (soft expiry)", async () => {
    await seedKey(payloadFor({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const status = await getInstanceLicense();
    assert.equal(status.status, "expired");
    assert.equal(status.featureValid, true);
  });

  test("an expired EVALUATION key → features off (hard expiry)", async () => {
    await seedKey(
      payloadFor({
        evaluation: true,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const status = await getInstanceLicense();
    assert.equal(status.status, "expired");
    assert.equal(status.featureValid, false);
  });

  test("a key signed by an untrusted keypair → status invalid", async () => {
    const rogue = keypair();
    await insert(AppSetting, {
      key: LICENSE_KEY_SETTING,
      value: signLicense(rogue.privatePem, payloadFor()),
    });
    invalidateLicenseCache();
    const status = await getInstanceLicense();
    assert.equal(status.status, "invalid");
    assert.equal(status.featureValid, false);
  });
});
