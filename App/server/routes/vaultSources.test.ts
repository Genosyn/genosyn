import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultSource } from "../db/entities/VaultSource.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { vaultRouter } from "./vault.js";

/**
 * The Vault source HTTP surface: who may reach it, what it refuses, and how a
 * mirrored Vault item behaves once one exists.
 *
 * Nothing here talks to a real Bitwarden server. Connecting a source proves
 * its sign-in before writing a row, so the only network case worth asserting
 * is the failing one — that a server which cannot be reached leaves no row
 * behind. Every other route is exercised against a source inserted directly,
 * which is exactly what a connected one looks like on disk.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let admin: User;
let member: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid/vault", vaultRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  [owner, admin, member] = await Promise.all([
    insert(User, {
      email: "source-owner@example.com",
      name: "Source Owner",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: "source-admin@example.com",
      name: "Source Admin",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: "source-member@example.com",
      name: "Source Member",
      passwordHash: "x",
      sessionVersion: 0,
    }),
  ]);
  [company, otherCompany] = await Promise.all([
    insert(Company, {
      name: "Vault Source Company",
      slug: `vault-source-${randomUUID()}`,
      ownerId: owner.id,
    }),
    insert(Company, {
      name: "Other Company",
      slug: `vault-source-other-${randomUUID()}`,
      ownerId: owner.id,
    }),
  ]);
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role }),
    insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role }),
    insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role }),
    insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" as Role }),
  ]);
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = {
  status: number;
  body: T;
  text: string;
};

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  cid: string = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${cid}/vault${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

const MASTER_PASSWORD = "correct horse battery staple";

function sourceConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "ops@example.com",
    masterPassword: MASTER_PASSWORD,
    clientId: "",
    clientSecret: "",
    deviceIdentifier: randomUUID(),
    refreshToken: "",
    twoFactorToken: "",
    ...overrides,
  });
}

/**
 * A connected source, written the way `services/vaultSources.ts` writes one.
 * Going through the API would require a reachable Bitwarden server.
 */
async function insertSource(
  overrides: Partial<VaultSource> = {},
  config: Record<string, unknown> = {},
): Promise<VaultSource> {
  const companyId = overrides.companyId ?? company.id;
  return insert(VaultSource, {
    companyId,
    kind: "bitwarden",
    label: "Vaultwarden (ops)",
    serverUrl: "https://vault.example.com",
    accountHint: "ops@example.com",
    encryptedConfig: encryptSecret(sourceConfig(config), `company:${companyId}:vault-source`),
    scopeName: "",
    defaultVisibility: "restricted",
    status: "connected",
    statusMessage: "",
    lastSyncedAt: null,
    lastSyncItemCount: 0,
    createdByUserId: owner.id,
    ...overrides,
  });
}

/**
 * A mirror: title, username and website only. The secret stays in the external
 * vault, which is why the payload's `secret` is deliberately empty.
 */
async function insertMirroredItem(
  source: VaultSource,
  overrides: Partial<VaultItem> = {},
  payload: Partial<{
    title: string;
    username: string;
    websiteUrl: string;
  }> = {},
): Promise<VaultItem> {
  const companyId = overrides.companyId ?? source.companyId;
  return insert(VaultItem, {
    companyId,
    type: "login",
    visibility: "restricted",
    encryptedPayload: encryptSecret(
      JSON.stringify({
        title: "Mirrored production login",
        username: "ops@example.com",
        secret: "",
        websiteUrl: "https://accounts.example.com/login",
        notes: "",
        totp: null,
        passkeys: [],
        passkeyRegistrationLease: null,
        ...payload,
      }),
      `company:${companyId}:vault`,
    ),
    createdByUserId: owner.id,
    createdByEmployeeId: null,
    vaultSourceId: source.id,
    externalItemId: randomUUID(),
    externalRevision: "2026-02-01T09:30:00.000Z",
    externalHasTotp: true,
    ...overrides,
  });
}

function countSources(): Promise<number> {
  return AppDataSource.getRepository(VaultSource).count();
}

describe("Vault source routes", () => {
  test("lists no Vault sources for a company that has connected none", async () => {
    const response = await call<{ sources: unknown[] }>("GET", "/sources");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.sources, []);
  });

  test("describes a connected source without ever returning its sign-in", async () => {
    const source = await insertSource({ label: "Vaultwarden (ops)", scopeName: "Engineering" });
    await insertMirroredItem(source);
    const cloud = await insertSource(
      { label: "Bitwarden cloud", serverUrl: "https://vault.bitwarden.com" },
      { clientId: "user.abc", clientSecret: "shh" },
    );

    const response = await call<{ sources: Array<Record<string, unknown>> }>("GET", "/sources");
    assert.equal(response.status, 200);
    assert.equal(response.body.sources.length, 2);

    // Looked up by id rather than by position: two rows created in the same
    // millisecond have no defined order.
    const byId = new Map(response.body.sources.map((row) => [row.id as string, row]));
    const first = byId.get(source.id) ?? ({} as Record<string, unknown>);
    const second = byId.get(cloud.id) ?? ({} as Record<string, unknown>);
    assert.equal(first.id, source.id);
    assert.equal(first.kind, "bitwarden");
    assert.equal(first.label, "Vaultwarden (ops)");
    assert.equal(first.scopeName, "Engineering");
    assert.equal(first.usesApiKey, false);
    assert.equal(first.itemCount, 1);
    assert.equal(first.status, "connected");
    assert.equal(first.lastSyncedAt, null);
    assert.equal(first.lastSyncItemCount, 0);
    assert.equal(second.usesApiKey, true);
    assert.equal(second.itemCount, 0);

    // Nothing that could unlock the external vault may cross the API boundary.
    assert.doesNotMatch(response.text, /correct horse|encryptedConfig|masterPassword|shh/);
    assert.equal(Object.hasOwn(first, "encryptedConfig"), false);
  });

  test("an admin may read Vault sources; a Member may not reach any route", async () => {
    const source = await insertSource();

    actingUserId = admin.id;
    assert.equal((await call("GET", "/sources")).status, 200);

    actingUserId = member.id;
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/sources"],
      [
        "POST",
        "/sources",
        {
          label: "Vaultwarden",
          serverUrl: "https://vault.example.com",
          email: "ops@example.com",
          masterPassword: MASTER_PASSWORD,
        },
      ],
      ["PATCH", `/sources/${source.id}`, { label: "Renamed" }],
      ["DELETE", `/sources/${source.id}`],
      ["POST", `/sources/${source.id}/sync`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call<{ error: string }>(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} must be refused for a Member`);
      assert.match(response.body.error, /admin company role required/i);
    }
    assert.equal(await countSources(), 1, "a refused request must not write anything");
  });

  test("refuses a create body that is incomplete or self-contradictory", async () => {
    const base = {
      label: "Vaultwarden",
      serverUrl: "https://vault.example.com",
      email: "ops@example.com",
      masterPassword: MASTER_PASSWORD,
    };
    const bodies: Array<[string, Record<string, unknown>]> = [
      [
        "missing serverUrl",
        { label: base.label, email: base.email, masterPassword: base.masterPassword },
      ],
      [
        "missing label",
        { serverUrl: base.serverUrl, email: base.email, masterPassword: base.masterPassword },
      ],
      [
        "missing masterPassword",
        { label: base.label, serverUrl: base.serverUrl, email: base.email },
      ],
      ["blank label", { ...base, label: "   " }],
      ["a client id with no client secret", { ...base, clientId: "user.abc" }],
      ["a client secret with no client id", { ...base, clientSecret: "shh" }],
      [
        "a server URL with embedded credentials",
        { ...base, serverUrl: "https://u:p@vault.example.com" },
      ],
      ["an unknown visibility", { ...base, defaultVisibility: "everyone" }],
      ["an unexpected field", { ...base, apiToken: "nope" }],
    ];

    for (const [what, body] of bodies) {
      const response = await call<{ error: string }>("POST", "/sources", body);
      assert.equal(response.status, 400, `expected ${what} to be refused`);
      assert.equal(response.body.error, "ValidationError");
    }
    assert.equal(await countSources(), 0);
  });

  test("a server that cannot be reached fails cleanly and leaves no row", async () => {
    const response = await call<{ error: string }>("POST", "/sources", {
      label: "Vaultwarden",
      // `.invalid` can never resolve (RFC 6761), so this never leaves the host.
      serverUrl: "https://vault.invalid",
      email: "ops@example.com",
      masterPassword: MASTER_PASSWORD,
    });

    assert.ok(
      response.status >= 400 && response.status <= 599,
      `expected an error status, got ${response.status}`,
    );
    assert.equal(typeof response.body.error, "string");
    assert.notEqual(response.body.error, "");
    assert.doesNotMatch(response.text, /correct horse/);
    assert.equal(await countSources(), 0, "a source is only written once its sign-in is proved");
    assert.deepEqual((await call<{ sources: unknown[] }>("GET", "/sources")).body.sources, []);
  });

  test("a source belongs to one company and is invisible to another", async () => {
    const source = await insertSource();

    const otherList = await call<{ sources: unknown[] }>(
      "GET",
      "/sources",
      undefined,
      otherCompany.id,
    );
    assert.equal(otherList.status, 200);
    assert.deepEqual(otherList.body.sources, []);

    const attempts: Array<[string, string, unknown?]> = [
      ["PATCH", `/sources/${source.id}`, { label: "Stolen" }],
      ["DELETE", `/sources/${source.id}`],
      ["POST", `/sources/${source.id}/sync`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call<{ error: string }>(method, path, body, otherCompany.id);
      assert.equal(response.status, 404, `${method} ${path} must be a 404 for another company`);
      assert.match(response.body.error, /not found/i);
    }

    const stillThere = await AppDataSource.getRepository(VaultSource).findOneByOrFail({
      id: source.id,
    });
    assert.equal(stillThere.label, "Vaultwarden (ops)");
    assert.equal(stillThere.companyId, company.id);
  });

  test("a source id that is not a uuid is refused before anything is loaded", async () => {
    const response = await call<{ error: string }>("PATCH", "/sources/not-a-uuid", {
      label: "Renamed",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
  });

  test("renames a source and retargets its scope without re-proving credentials", async () => {
    const source = await insertSource();

    const renamed = await call<{ source: Record<string, unknown> }>(
      "PATCH",
      `/sources/${source.id}`,
      { label: "  Vaultwarden (finance)  ", scopeName: "Finance", defaultVisibility: "company" },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.source.label, "Vaultwarden (finance)");
    assert.equal(renamed.body.source.scopeName, "Finance");
    assert.equal(renamed.body.source.defaultVisibility, "company");
    assert.equal(renamed.body.source.accountHint, "ops@example.com");

    const stored = await AppDataSource.getRepository(VaultSource).findOneByOrFail({
      id: source.id,
    });
    assert.equal(stored.label, "Vaultwarden (finance)");
    assert.equal(stored.scopeName, "Finance");

    const empty = await call<{ error: string }>("PATCH", `/sources/${source.id}`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "ValidationError");
  });

  test("disconnecting a source removes exactly what it mirrored", async () => {
    const source = await insertSource();
    const otherSource = await insertSource({ label: "Second vault" });
    await insertMirroredItem(source);
    await insertMirroredItem(source, {}, { title: "Second mirrored login" });
    const keptMirror = await insertMirroredItem(otherSource);
    const native = await insert(VaultItem, {
      companyId: company.id,
      type: "login",
      visibility: "restricted",
      encryptedPayload: encryptSecret(
        JSON.stringify({
          title: "Native login",
          username: "native@example.com",
          secret: "kept",
          websiteUrl: "",
          notes: "",
          totp: null,
          passkeys: [],
          passkeyRegistrationLease: null,
        }),
        `company:${company.id}:vault`,
      ),
      createdByUserId: owner.id,
      createdByEmployeeId: null,
    });

    const response = await call<{ ok: boolean; removedItems: number }>(
      "DELETE",
      `/sources/${source.id}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.removedItems, 2);

    const remaining = await AppDataSource.getRepository(VaultItem).find({ order: { id: "ASC" } });
    assert.deepEqual(
      remaining.map((row) => row.id).sort(),
      [keptMirror.id, native.id].sort(),
      "only the disconnected source's mirrors are removed",
    );
    assert.equal(await countSources(), 1);

    const gone = await call<{ error: string }>("DELETE", `/sources/${source.id}`);
    assert.equal(gone.status, 404);
  });
});

describe("Mirrored Vault items", () => {
  test("a mirror is listed as read-only content that can still be revealed", async () => {
    const source = await insertSource();
    const mirror = await insertMirroredItem(source);

    const list = await call<{ items: Array<Record<string, unknown>> }>("GET", "/items");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    const item = list.body.items[0];
    assert.equal(item.id, mirror.id);
    assert.equal(item.vaultSourceId, source.id);
    assert.equal(item.title, "Mirrored production login");
    assert.equal(item.username, "ops@example.com");
    assert.equal(item.canEdit, false);
    assert.equal(item.canDelete, false);
    // Sharing and revealing stay Genosyn's own policy, so they are unchanged.
    assert.equal(item.canShare, true);
    assert.equal(item.canReveal, true);
    // The seed lives in the external vault; the mirror only remembers that
    // there is one, and never carries software passkeys.
    assert.equal(item.hasTotp, true);
    assert.deepEqual(item.passkeys, []);
    assert.equal(Object.hasOwn(item, "secret"), false);
    assert.equal(Object.hasOwn(item, "encryptedPayload"), false);

    const detail = await call<{ item: Record<string, unknown> }>("GET", `/items/${mirror.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.vaultSourceId, source.id);
    assert.equal(detail.body.item.canEdit, false);
  });

  test("editing a mirror's contents is refused, and says where to change them", async () => {
    const source = await insertSource();
    const mirror = await insertMirroredItem(source);

    for (const patch of [
      { title: "Renamed here" },
      { username: "someone-else@example.com" },
      { secret: "rotated here" },
      { websiteUrl: "https://elsewhere.example.com/" },
      { notes: "a local note" },
      { type: "secure_note" as const },
      { title: "Renamed here", visibility: "company" as const },
    ]) {
      const response = await call<{ error: string }>("PATCH", `/items/${mirror.id}`, {
        ...patch,
        expectedVersion: mirror.version,
      });
      assert.equal(
        response.status,
        409,
        `expected ${JSON.stringify(patch)} to be refused on a mirror`,
      );
      assert.match(response.body.error, /mirrored from an external vault/i);
    }

    const unchanged = await AppDataSource.getRepository(VaultItem).findOneByOrFail({
      id: mirror.id,
    });
    assert.equal(unchanged.version, mirror.version);
    assert.equal(unchanged.encryptedPayload, mirror.encryptedPayload);
  });

  test("a mirror's visibility is Genosyn's own policy and stays editable", async () => {
    const source = await insertSource();
    const mirror = await insertMirroredItem(source);

    const response = await call<{ item: Record<string, unknown> }>("PATCH", `/items/${mirror.id}`, {
      visibility: "company",
      expectedVersion: mirror.version,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.item.visibility, "company");
    assert.equal(response.body.item.vaultSourceId, source.id);
    assert.equal(response.body.item.canEdit, false);
    assert.equal(response.body.item.title, "Mirrored production login");

    const stored = await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: mirror.id });
    assert.equal(stored.visibility, "company");
    assert.equal(stored.vaultSourceId, source.id);
    assert.equal(stored.externalItemId, mirror.externalItemId);
  });

  test("deleting a mirror is refused; disconnecting the source is the way out", async () => {
    const source = await insertSource();
    const mirror = await insertMirroredItem(source);

    const response = await call<{ error: string }>("DELETE", `/items/${mirror.id}`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, /Delete it there, or disconnect the Vault source/i);
    assert.ok(
      await AppDataSource.getRepository(VaultItem).findOneBy({ id: mirror.id }),
      "the mirror must survive a refused delete",
    );
  });
});
