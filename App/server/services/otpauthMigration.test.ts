import assert from "node:assert/strict";
import { test } from "node:test";

import { generate, generateSecret } from "otplib";
import { isOtpauthMigrationUri, readOtpauthMigrationUri } from "../../shared/otpauthMigration.js";
import { normalizeVaultTotpSetup } from "./vault.js";

/** A real export payload, assembled the way Google Authenticator's own encoder lays it out. */
function field(number: number, wire: 0 | 2, value: number | Uint8Array): number[] {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    let rest = n;
    while (rest >= 0x80) {
      out.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    out.push(rest);
    return out;
  };
  const tag = varint(number * 8 + wire);
  return wire === 0
    ? [...tag, ...varint(value as number)]
    : [...tag, ...varint((value as Uint8Array).length), ...(value as Uint8Array)];
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function account(values: {
  secret: Uint8Array;
  name: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
}): Uint8Array {
  return Uint8Array.from([
    ...field(1, 2, values.secret),
    ...field(2, 2, text(values.name)),
    ...(values.issuer ? field(3, 2, text(values.issuer)) : []),
    ...field(4, 0, values.algorithm ?? 1),
    ...field(5, 0, values.digits ?? 1),
    ...field(6, 0, values.type ?? 2),
    ...field(7, 0, 0),
  ]);
}

function exportUri(accounts: Uint8Array[]): string {
  const payload = Uint8Array.from([
    ...accounts.flatMap((row) => field(1, 2, row)),
    ...field(2, 0, 1),
    ...field(3, 0, 1),
    ...field(4, 0, 0),
    ...field(5, 0, 12345),
  ]);
  const data = btoa(String.fromCharCode(...payload));
  return `otpauth-migration://offline?data=${encodeURIComponent(data)}`;
}

const SECRET = Uint8Array.from(
  // "Hello!\xDE\xAD\xBE\xEF" is the example the format's own docs use.
  [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef],
);

test("reads an account into a URI the Vault takes, with the same secret", () => {
  const [row] = readOtpauthMigrationUri(
    exportUri([account({ secret: SECRET, name: "ada@acme.test", issuer: "FreeAgent" })]),
  );
  assert.equal(row.label, "FreeAgent (ada@acme.test)");
  const setup = normalizeVaultTotpSetup(row.uri);
  assert.equal(setup.secret, "JBSWY3DPEHPK3PXP");
  assert.equal(setup.issuer, "FreeAgent");
  assert.equal(setup.accountName, "ada@acme.test");
  assert.equal(setup.algorithm, "sha1");
  assert.equal(setup.digits, 6);
  assert.equal(setup.period, 30);
});

test("the codes the Vault then generates are the ones the original would", async () => {
  const secret = generateSecret();
  const raw = Uint8Array.from(
    Array.from(secret).reduce<number[]>((bytes, character, index, all) => {
      const bitsBefore = index * 5;
      const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
      for (let bit = 4; bit >= 0; bit -= 1) {
        const position = bitsBefore + (4 - bit);
        const at = Math.floor(position / 8);
        if (at >= Math.floor((all.length * 5) / 8)) continue;
        bytes[at] = (bytes[at] ?? 0) | (((value >> bit) & 1) << (7 - (position % 8)));
      }
      return bytes;
    }, []),
  );
  const [row] = readOtpauthMigrationUri(exportUri([account({ secret: raw, name: "a" })]));
  const setup = normalizeVaultTotpSetup(row.uri);
  const epoch = 1_800_000_000;
  const expected = await generate({ secret, strategy: "totp", epoch });
  const actual = await generate({ secret: setup.secret, strategy: "totp", epoch });
  assert.equal(actual, expected);
});

test("keeps algorithm and digits, and takes the issuer from the name when that's where it is", () => {
  const [row] = readOtpauthMigrationUri(
    exportUri([
      account({ secret: SECRET, name: "Xero:finance@acme.test", algorithm: 2, digits: 2 }),
    ]),
  );
  assert.equal(row.label, "Xero (finance@acme.test)");
  const setup = normalizeVaultTotpSetup(row.uri);
  assert.equal(setup.issuer, "Xero");
  assert.equal(setup.algorithm, "sha256");
  assert.equal(setup.digits, 8);
});

test("reads every account, and leaves out what the Vault couldn't generate codes for", () => {
  const rows = readOtpauthMigrationUri(
    exportUri([
      account({ secret: SECRET, name: "one", issuer: "A" }),
      account({ secret: SECRET, name: "counter", issuer: "B", type: 1 }),
      account({ secret: SECRET, name: "md5", issuer: "C", algorithm: 4 }),
      account({ secret: SECRET, name: "two", issuer: "D" }),
    ]),
  );
  assert.deepEqual(
    rows.map((row) => row.label),
    ["A (one)", "D (two)"],
  );
});

test("a + in the data survives an exporter that didn't escape it", () => {
  const uri = exportUri([account({ secret: SECRET, name: "x", issuer: "A" })]);
  const unescaped = decodeURIComponent(uri);
  assert.equal(readOtpauthMigrationUri(unescaped).length, 1);
});

test("recognises the format, and refuses anything else", () => {
  assert.equal(isOtpauthMigrationUri(" OTPAUTH-MIGRATION://offline?data=abc"), true);
  assert.equal(isOtpauthMigrationUri("otpauth://totp/x?secret=ABC"), false);
  assert.throws(() => readOtpauthMigrationUri("otpauth-migration://offline"), /isn't a Google/);
  assert.throws(() => readOtpauthMigrationUri("https://example.com/?data=abc"), /isn't a Google/);
  assert.throws(() => readOtpauthMigrationUri("otpauth-migration://offline?data=%2F%2F%2F%2F"));
});
