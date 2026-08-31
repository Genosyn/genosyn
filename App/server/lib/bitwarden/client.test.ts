import assert from "node:assert/strict";
import test from "node:test";

import {
  BitwardenApiError,
  bitwardenEndpoints,
  normalizeBitwardenServerUrl,
  readField,
  readKdf,
  readStringField,
} from "./client.js";
import { BITWARDEN_KDF_ARGON2ID, BITWARDEN_KDF_PBKDF2 } from "./keys.js";

/**
 * The pure half of the Bitwarden HTTP client: where a server lives, and how to
 * read a response whose capitalization depends on the server's vintage.
 *
 * No test here makes a network call — every function under test is a pure
 * transformation, which is exactly why they are the ones worth pinning.
 */

test("normalizeBitwardenServerUrl trims trailing slashes", () => {
  assert.equal(
    normalizeBitwardenServerUrl("https://vault.example.com/"),
    "https://vault.example.com",
  );
  assert.equal(
    normalizeBitwardenServerUrl("https://vault.example.com///"),
    "https://vault.example.com",
  );
  assert.equal(
    normalizeBitwardenServerUrl("  https://vault.example.com  "),
    "https://vault.example.com",
  );
});

test("normalizeBitwardenServerUrl defaults a bare host to https", () => {
  assert.equal(normalizeBitwardenServerUrl("vault.example.com"), "https://vault.example.com");
  assert.equal(
    normalizeBitwardenServerUrl("vault.example.com/bitwarden"),
    "https://vault.example.com/bitwarden",
  );
  // An explicit http stays http — a Vaultwarden on the operator's own LAN is
  // the case this whole feature exists for.
  assert.equal(normalizeBitwardenServerUrl("http://10.0.0.4:8080"), "http://10.0.0.4:8080");
});

test("normalizeBitwardenServerUrl preserves a subpath install", () => {
  assert.equal(
    normalizeBitwardenServerUrl("https://apps.example.com/bitwarden/"),
    "https://apps.example.com/bitwarden",
  );
  assert.equal(
    normalizeBitwardenServerUrl("https://apps.example.com/a/b/"),
    "https://apps.example.com/a/b",
  );
});

test("normalizeBitwardenServerUrl rejects embedded credentials", () => {
  for (const url of [
    "https://user:secret@vault.example.com",
    "https://user@vault.example.com",
    "user:secret@vault.example.com",
  ]) {
    assert.throws(
      () => normalizeBitwardenServerUrl(url),
      (error: unknown) =>
        error instanceof BitwardenApiError && /embed credentials/i.test((error as Error).message),
      `expected ${url} to be refused`,
    );
  }
});

test("normalizeBitwardenServerUrl rejects a query string or fragment", () => {
  assert.throws(
    () => normalizeBitwardenServerUrl("https://vault.example.com/?next=/admin"),
    (error: unknown) =>
      error instanceof BitwardenApiError && /query or fragment/i.test((error as Error).message),
  );
  assert.throws(
    () => normalizeBitwardenServerUrl("https://vault.example.com/#/login"),
    (error: unknown) =>
      error instanceof BitwardenApiError && /query or fragment/i.test((error as Error).message),
  );
});

test("normalizeBitwardenServerUrl rejects an empty or unreadable URL", () => {
  for (const url of ["", "   ", "///", "http://[::1", "https://exa mple.com"]) {
    assert.throws(
      () => normalizeBitwardenServerUrl(url),
      (error: unknown) => error instanceof BitwardenApiError,
      `expected ${JSON.stringify(url)} to be refused`,
    );
  }
});

test("a self-hosted install mounts identity and api under the web vault URL", () => {
  assert.deepEqual(bitwardenEndpoints("https://vault.example.com/"), {
    identityUrl: "https://vault.example.com/identity",
    apiUrl: "https://vault.example.com/api",
  });
  assert.deepEqual(bitwardenEndpoints("vaultwarden.internal:8080"), {
    identityUrl: "https://vaultwarden.internal:8080/identity",
    apiUrl: "https://vaultwarden.internal:8080/api",
  });
});

test("a subpath install keeps its subpath", () => {
  assert.deepEqual(bitwardenEndpoints("https://apps.example.com/bitwarden"), {
    identityUrl: "https://apps.example.com/bitwarden/identity",
    apiUrl: "https://apps.example.com/bitwarden/api",
  });
});

test("Bitwarden's own regions use sibling hostnames, not paths", () => {
  for (const url of ["https://vault.bitwarden.com", "vault.bitwarden.com/", "bitwarden.com"]) {
    assert.deepEqual(
      bitwardenEndpoints(url),
      { identityUrl: "https://identity.bitwarden.com", apiUrl: "https://api.bitwarden.com" },
      `expected ${url} to map to the cloud hostnames`,
    );
  }
  assert.deepEqual(bitwardenEndpoints("https://vault.bitwarden.eu"), {
    identityUrl: "https://identity.bitwarden.eu",
    apiUrl: "https://api.bitwarden.eu",
  });
  // A self-hosted server that merely looks similar must not be redirected to
  // Bitwarden's cloud.
  assert.deepEqual(bitwardenEndpoints("https://vault.bitwarden.com.example.net"), {
    identityUrl: "https://vault.bitwarden.com.example.net/identity",
    apiUrl: "https://vault.bitwarden.com.example.net/api",
  });
});

test("readField probes exact, first-character-flipped, all-lower and all-upper", () => {
  assert.equal(readField({ kdfIterations: 600_000 }, "kdfIterations"), 600_000);
  assert.equal(readField({ KdfIterations: 600_000 }, "kdfIterations"), 600_000);
  assert.equal(readField({ kdfiterations: 600_000 }, "kdfIterations"), 600_000);
  assert.equal(readField({ KDFITERATIONS: 600_000 }, "kdfIterations"), 600_000);
  // Asking with a PascalCase name finds the camelCase key too.
  assert.equal(readField({ privateKey: "x" }, "PrivateKey"), "x");

  // Exact wins over every fallback.
  assert.equal(readField({ key: "exact", Key: "flipped" }, "key"), "exact");
  assert.equal(readField({ key: "flipped", Key: "exact" }, "Key"), "exact");

  assert.equal(readField({ other: 1 }, "kdf"), undefined);
  assert.equal(readField(null, "kdf"), undefined);
  assert.equal(readField(undefined, "kdf"), undefined);
  assert.equal(readField("a string", "kdf"), undefined);
  assert.equal(readField(42, "kdf"), undefined);
});

test("readStringField returns only non-empty strings", () => {
  assert.equal(readStringField({ Name: "Prod login" }, "name"), "Prod login");
  assert.equal(readStringField({ name: "" }, "name"), null);
  assert.equal(readStringField({ name: 7 }, "name"), null);
  assert.equal(readStringField({ name: null }, "name"), null);
  assert.equal(readStringField(null, "name"), null);
});

test("readKdf reads the flat fields in either capitalization", () => {
  assert.deepEqual(readKdf({ kdf: 0, kdfIterations: 600_000 }), {
    kind: BITWARDEN_KDF_PBKDF2,
    iterations: 600_000,
    memory: null,
    parallelism: null,
  });
  assert.deepEqual(readKdf({ Kdf: 1, KdfIterations: 3, KdfMemory: 64, KdfParallelism: 4 }), {
    kind: BITWARDEN_KDF_ARGON2ID,
    iterations: 3,
    memory: 64,
    parallelism: 4,
  });
  // Some servers send the numbers as strings.
  assert.deepEqual(readKdf({ kdf: "0", kdfIterations: "600000" }), {
    kind: BITWARDEN_KDF_PBKDF2,
    iterations: 600_000,
    memory: null,
    parallelism: null,
  });
});

test("readKdf falls back to the nested kdfSettings block", () => {
  assert.deepEqual(
    readKdf({ kdfSettings: { kdfType: 1, iterations: 3, memory: 64, parallelism: 4 } }),
    {
      kind: BITWARDEN_KDF_ARGON2ID,
      iterations: 3,
      memory: 64,
      parallelism: 4,
    },
  );
  assert.deepEqual(readKdf({ kdfSettings: { kdf: 0, iterations: 600_000 } }), {
    kind: BITWARDEN_KDF_PBKDF2,
    iterations: 600_000,
    memory: null,
    parallelism: null,
  });
  // The flat fields win when both are present.
  assert.deepEqual(
    readKdf({ kdf: 0, kdfIterations: 600_000, kdfSettings: { kdfType: 1, iterations: 3 } }),
    {
      kind: BITWARDEN_KDF_PBKDF2,
      iterations: 600_000,
      memory: null,
      parallelism: null,
    },
  );
});

test("readKdf refuses an unknown KDF or a missing iteration count", () => {
  for (const source of [{ kdf: 2, kdfIterations: 600_000 }, { kdf: 9, kdfIterations: 3 }, {}]) {
    assert.throws(
      () => readKdf(source),
      (error: unknown) =>
        error instanceof BitwardenApiError &&
        /unknown password KDF/i.test((error as Error).message),
      `expected ${JSON.stringify(source)} to be refused`,
    );
  }
  assert.throws(
    () => readKdf({ kdf: 0 }),
    (error: unknown) =>
      error instanceof BitwardenApiError &&
      /did not report its KDF iterations/i.test((error as Error).message),
  );
});
