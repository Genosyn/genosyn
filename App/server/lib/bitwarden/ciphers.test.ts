import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import test from "node:test";

import {
  decodeBitwardenCipher,
  readBitwardenScopeNames,
  readBitwardenVault,
  readBitwardenVaultKeys,
} from "./ciphers.js";
import { type BitwardenSymmetricKey, symmetricKeyFromBytes } from "./encString.js";

/**
 * The mapping rules: which key each field of a cipher is encrypted under, and
 * which ciphers cross into a Genosyn Vault at all.
 *
 * Every fixture below is built here with `node:crypto`, so the tests assert
 * against the Bitwarden wire format rather than against the module's own idea
 * of it. The per-item key case is the one that matters most — a client that
 * ignores it fails on *some* items with an integrity error, which reads like a
 * corrupt vault rather than a missing feature.
 */

/** Seal a value the way a Bitwarden client writes a type-2 EncString. */
function seal(plaintext: string | Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ]);
  const mac = crypto
    .createHmac("sha256", key.subarray(32, 64))
    .update(iv)
    .update(ciphertext)
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}

const userKeyBytes = crypto.randomBytes(64);
const userKey: BitwardenSymmetricKey = symmetricKeyFromBytes(userKeyBytes);
const noScopes = { folders: new Map<string, string>(), collections: new Map<string, string>() };

type OrganizationFixture = {
  organizationId: string;
  organizationKeyBytes: Buffer;
  profile: Record<string, unknown>;
};

/** An account that belongs to one organization, keys and all. */
function organizationFixture(): OrganizationFixture {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const organizationId = randomUUID();
  const organizationKeyBytes = crypto.randomBytes(64);
  const wrapped = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    organizationKeyBytes,
  );
  return {
    organizationId,
    organizationKeyBytes,
    profile: {
      privateKey: seal(der, userKeyBytes),
      organizations: [{ id: organizationId, key: `4.${wrapped.toString("base64")}` }],
    },
  };
}

function loginCipher(
  key: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: randomUUID(),
    type: 1,
    revisionDate: "2026-02-01T09:30:00.000Z",
    name: seal("Production login", key),
    login: {
      username: seal("ops@example.com", key),
      password: seal("correct horse battery staple", key),
      totp: seal("otpauth://totp/Example:ops?secret=JBSWY3DPEHPK3PXP&issuer=Example", key),
      uris: [{ uri: seal("https://accounts.example.com/login", key) }],
    },
    ...overrides,
  };
}

test("a Login with no per-item key decrypts under the user key", () => {
  const cipher = loginCipher(userKeyBytes);
  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);

  assert.ok(item);
  assert.equal(item.id, cipher.id);
  assert.equal(item.type, "login");
  assert.equal(item.title, "Production login");
  assert.equal(item.username, "ops@example.com");
  assert.equal(item.secret, "correct horse battery staple");
  assert.equal(item.websiteUrl, "https://accounts.example.com/login");
  assert.equal(
    item.totpSetupKey,
    "otpauth://totp/Example:ops?secret=JBSWY3DPEHPK3PXP&issuer=Example",
  );
  assert.equal(item.organizationId, null);
  assert.deepEqual(item.scopeNames, []);
  assert.equal(item.revisionDate, "2026-02-01T09:30:00.000Z");
});

test("a Login WITH a per-item key decrypts every field under that key, not the user key", () => {
  const itemKeyBytes = crypto.randomBytes(64);
  const cipher = loginCipher(itemKeyBytes, { key: seal(itemKeyBytes, userKeyBytes) });

  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);
  assert.ok(item, "a cipher with its own key must still decode");
  assert.equal(item.title, "Production login");
  assert.equal(item.username, "ops@example.com");
  assert.equal(item.secret, "correct horse battery staple");
  assert.equal(item.websiteUrl, "https://accounts.example.com/login");

  // The rule holds in the other direction too: once a cipher carries a key,
  // fields still sealed under the user key are not readable. If this ever
  // passes, the per-item key is being ignored.
  const mismatched = loginCipher(userKeyBytes, { key: seal(itemKeyBytes, userKeyBytes) });
  const read = readBitwardenVault({ ciphers: [mismatched] }, userKey);
  assert.deepEqual(read.items, []);
  assert.equal(read.skipped.unreadable, 1);
  assert.equal(read.skipped.unsupportedType, 0);
});

test("an organization-owned cipher uses the organization key from the profile", () => {
  const organization = organizationFixture();
  const cipher = loginCipher(organization.organizationKeyBytes, {
    organizationId: organization.organizationId,
    collectionIds: [],
  });

  const keys = readBitwardenVaultKeys({ profile: organization.profile }, userKey);
  assert.equal(keys.organizationKeys.size, 1);
  assert.deepEqual(
    keys.organizationKeys.get(organization.organizationId)?.encKey,
    organization.organizationKeyBytes.subarray(0, 32),
  );

  const read = readBitwardenVault({ profile: organization.profile, ciphers: [cipher] }, userKey);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].title, "Production login");
  assert.equal(read.items[0].secret, "correct horse battery staple");
  assert.equal(read.items[0].organizationId, organization.organizationId);

  // Without the organization key that same cipher must be reported unreadable
  // rather than decrypted with the wrong key.
  const orphaned = readBitwardenVault({ ciphers: [cipher] }, userKey);
  assert.deepEqual(orphaned.items, []);
  assert.equal(orphaned.skipped.unreadable, 1);
});

test("an organization cipher can also carry its own per-item key", () => {
  const organization = organizationFixture();
  const itemKeyBytes = crypto.randomBytes(64);
  const cipher = loginCipher(itemKeyBytes, {
    organizationId: organization.organizationId,
    key: seal(itemKeyBytes, organization.organizationKeyBytes),
  });

  const read = readBitwardenVault({ profile: organization.profile, ciphers: [cipher] }, userKey);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].secret, "correct horse battery staple");
});

test("a SecureNote maps its notes to the secret and has no website", () => {
  const cipher = {
    id: randomUUID(),
    type: 2,
    revisionDate: "2026-02-02T00:00:00.000Z",
    name: seal("Root recovery codes", userKeyBytes),
    notes: seal("11111-22222\n33333-44444", userKeyBytes),
    // A note that somehow carries login URIs must still map to no website.
    login: { uris: [{ uri: seal("https://example.com", userKeyBytes) }] },
  };

  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);
  assert.ok(item);
  assert.equal(item.type, "secure_note");
  assert.equal(item.title, "Root recovery codes");
  assert.equal(item.secret, "11111-22222\n33333-44444");
  assert.equal(item.websiteUrl, "");
  assert.equal(item.username, "");
  assert.equal(item.totpSetupKey, null);
});

test("cards, identities and SSH keys are skipped and counted, not mangled", () => {
  const ciphers = [3, 4, 5].map((type) => ({
    id: randomUUID(),
    type,
    name: seal("Company card", userKeyBytes),
  }));
  const read = readBitwardenVault({ ciphers: [...ciphers, loginCipher(userKeyBytes)] }, userKey);

  assert.equal(read.items.length, 1);
  assert.equal(read.skipped.unsupportedType, 3);
  assert.equal(read.skipped.unreadable, 0);

  for (const cipher of ciphers) {
    assert.equal(
      decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes),
      null,
    );
  }
});

test("a trashed cipher is skipped entirely and counted as neither", () => {
  const trashedLogin = loginCipher(userKeyBytes, { deletedDate: "2026-02-03T10:00:00.000Z" });
  const trashedCard = {
    id: randomUUID(),
    type: 3,
    deletedDate: "2026-02-03T10:00:00.000Z",
    name: seal("Old card", userKeyBytes),
  };
  const trashedUnreadable = {
    id: randomUUID(),
    type: 1,
    deletedDate: "2026-02-03T10:00:00.000Z",
    name: seal("Unreadable", crypto.randomBytes(64)),
  };

  const read = readBitwardenVault(
    { ciphers: [trashedLogin, trashedCard, trashedUnreadable, loginCipher(userKeyBytes)] },
    userKey,
  );
  assert.equal(read.items.length, 1, "only the live login is mirrored");
  assert.equal(read.skipped.unsupportedType, 0);
  assert.equal(read.skipped.unreadable, 0);
  assert.equal(
    decodeBitwardenCipher(trashedLogin, { userKey, organizationKeys: new Map() }, noScopes),
    null,
  );
});

test("PascalCase field names decode as well as camelCase", () => {
  const cipher = {
    Id: randomUUID(),
    Type: 1,
    RevisionDate: "2026-02-04T00:00:00.000Z",
    Name: seal("Legacy server login", userKeyBytes),
    Notes: seal("Filed by the old console", userKeyBytes),
    Login: {
      Username: seal("root", userKeyBytes),
      Password: seal("s3cr3t", userKeyBytes),
      Totp: seal("JBSWY3DPEHPK3PXP", userKeyBytes),
      Uris: [{ Uri: seal("https://console.example.com", userKeyBytes) }],
    },
    OrganizationId: null,
    CollectionIds: [],
  };

  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);
  assert.ok(item);
  assert.equal(item.id, cipher.Id);
  assert.equal(item.title, "Legacy server login");
  assert.equal(item.username, "root");
  assert.equal(item.secret, "s3cr3t");
  assert.equal(item.websiteUrl, "https://console.example.com/");
  assert.equal(item.totpSetupKey, "JBSWY3DPEHPK3PXP");
  assert.equal(item.revisionDate, "2026-02-04T00:00:00.000Z");
});

test("a cipher with no typed fields decodes from its JSON data blob", () => {
  const cipher = {
    id: randomUUID(),
    type: 1,
    revisionDate: "2026-02-05T00:00:00.000Z",
    data: JSON.stringify({
      Name: seal("Data-blob login", userKeyBytes),
      Username: seal("data@example.com", userKeyBytes),
      Password: seal("from-the-blob", userKeyBytes),
      Totp: seal("JBSWY3DPEHPK3PXP", userKeyBytes),
      Uris: [{ Uri: seal("https://blob.example.com/in", userKeyBytes) }],
    }),
  };

  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);
  assert.ok(item);
  assert.equal(item.title, "Data-blob login");
  assert.equal(item.username, "data@example.com");
  assert.equal(item.secret, "from-the-blob");
  assert.equal(item.websiteUrl, "https://blob.example.com/in");
  assert.equal(item.totpSetupKey, "JBSWY3DPEHPK3PXP");
});

test("a cipher whose whole payload is opaque is reported unreadable", () => {
  const read = readBitwardenVault(
    {
      ciphers: [
        { id: randomUUID(), type: 1, data: seal("an opaque blob", userKeyBytes) },
        { id: randomUUID(), type: 1, name: seal("Wrong key", crypto.randomBytes(64)) },
      ],
    },
    userKey,
  );
  assert.deepEqual(read.items, []);
  assert.equal(read.skipped.unreadable, 2);
});

test("a URI that is not a URL yields an empty website rather than throwing", () => {
  const notAUrl = loginCipher(userKeyBytes, {
    login: { uris: [{ uri: seal("not a url", userKeyBytes) }] },
  });
  const item = decodeBitwardenCipher(notAUrl, { userKey, organizationKeys: new Map() }, noScopes);
  assert.ok(item);
  assert.equal(item.websiteUrl, "");

  // A URI with embedded credentials is refused for the same reason.
  const credentials = loginCipher(userKeyBytes, {
    login: { uris: [{ uri: seal("https://user:pw@example.com/", userKeyBytes) }] },
  });
  assert.equal(
    decodeBitwardenCipher(credentials, { userKey, organizationKeys: new Map() }, noScopes)
      ?.websiteUrl,
    "",
  );

  // An unusable first URI must not hide a usable second one.
  const fallback = loginCipher(userKeyBytes, {
    login: {
      uris: [
        { uri: seal("not a url", userKeyBytes) },
        { uri: seal("accounts.example.com/login", userKeyBytes) },
      ],
    },
  });
  assert.equal(
    decodeBitwardenCipher(fallback, { userKey, organizationKeys: new Map() }, noScopes)?.websiteUrl,
    "https://accounts.example.com/login",
  );
});

test("folder names decrypt under the user key and collection names under the organization key", () => {
  const organization = organizationFixture();
  const folderId = randomUUID();
  const collectionId = randomUUID();
  const personalCollectionId = randomUUID();
  const sync = {
    profile: organization.profile,
    folders: [
      { id: folderId, name: seal("Shared ops", userKeyBytes) },
      // A folder sealed with anything else is dropped, not guessed at.
      { id: randomUUID(), name: seal("Unreadable", crypto.randomBytes(64)) },
    ],
    collections: [
      {
        id: collectionId,
        organizationId: organization.organizationId,
        name: seal("Engineering", organization.organizationKeyBytes),
      },
      { id: personalCollectionId, name: seal("Personal", userKeyBytes) },
    ],
  };

  const keys = readBitwardenVaultKeys(sync, userKey);
  const scopes = readBitwardenScopeNames(sync, keys);
  assert.equal(scopes.folders.size, 1);
  assert.equal(scopes.folders.get(folderId), "Shared ops");
  assert.equal(scopes.collections.get(collectionId), "Engineering");
  assert.equal(scopes.collections.get(personalCollectionId), "Personal");

  // ...and those names reach the item, which is what the scope filter reads.
  const cipher = loginCipher(organization.organizationKeyBytes, {
    organizationId: organization.organizationId,
    folderId,
    collectionIds: [collectionId, "an-id-nothing-matches"],
  });
  const item = decodeBitwardenCipher(cipher, keys, scopes);
  assert.deepEqual(item?.scopeNames, ["Shared ops", "Engineering"]);
});

test("one unreadable organization does not cost the rest of the vault", () => {
  const organization = organizationFixture();
  const profile = {
    privateKey: organization.profile.privateKey,
    organizations: [
      ...(organization.profile.organizations as Array<Record<string, unknown>>),
      { id: randomUUID(), key: `4.${crypto.randomBytes(256).toString("base64")}` },
    ],
  };
  const keys = readBitwardenVaultKeys({ profile }, userKey);
  assert.equal(keys.organizationKeys.size, 1);
  assert.ok(keys.organizationKeys.has(organization.organizationId));
});

test("an unreadable account private key still leaves the personal vault usable", () => {
  const organization = organizationFixture();
  const keys = readBitwardenVaultKeys(
    {
      profile: {
        privateKey: seal("not a private key", userKeyBytes),
        organizations: organization.profile.organizations,
      },
    },
    userKey,
  );
  assert.equal(keys.organizationKeys.size, 0);

  const read = readBitwardenVault(
    {
      profile: {
        privateKey: seal("not a private key", userKeyBytes),
        organizations: organization.profile.organizations,
      },
      ciphers: [loginCipher(userKeyBytes)],
    },
    userKey,
  );
  assert.equal(read.items.length, 1);
});

test("readBitwardenVault tolerates a response with no ciphers at all", () => {
  // Tolerating it here is safe only because `readVaultSourceItems` refuses a
  // response with no `ciphers` array outright — otherwise "no ciphers" would
  // read as "the vault is empty" and the sync would delete every mirror.
  assert.deepEqual(readBitwardenVault({}, userKey), {
    items: [],
    skipped: { unsupportedType: 0, unreadable: 0 },
    unreadableIds: [],
  });
  assert.deepEqual(readBitwardenVault({ ciphers: null }, userKey), {
    items: [],
    skipped: { unsupportedType: 0, unreadable: 0 },
    unreadableIds: [],
  });
});

test("a blank title falls back to a placeholder rather than an empty Vault item", () => {
  const cipher = loginCipher(userKeyBytes, { name: seal("   ", userKeyBytes) });
  const item = decodeBitwardenCipher(cipher, { userKey, organizationKeys: new Map() }, noScopes);
  assert.equal(item?.title, "Untitled Bitwarden item");
});
