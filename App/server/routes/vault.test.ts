import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeVaultGrant } from "../db/entities/EmployeeVaultGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultItemMemberAccess } from "../db/entities/VaultItemMemberAccess.js";
import { errorHandler } from "../middleware/error.js";
import { hashApiToken } from "../middleware/auth.js";
import { encryptSecret } from "../lib/secret.js";
import {
  beginVaultPasskeyRegistrationForEmployee,
  createVaultLoginForEmployee,
  finalizeVaultPasskeyRegistrationForEmployee,
  generateVaultPassword,
  getVaultPasskeyForEmployee,
  getVaultFieldForEmployee,
  getVaultTotpCode,
  getVaultTotpCodeForEmployee,
  listVaultItemsForEmployee,
  recordVaultPasskeyUseForEmployee,
  releaseVaultPasskeyRegistrationForEmployee,
  releaseVaultPasskeyUseForEmployee,
  setVaultTotpForEmployee,
  updateVaultItem,
  updateVaultLoginMetadataForEmployee,
  VaultError,
  type VaultPasskeyCredentialInput,
} from "../services/vault.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import { deleteUserCascade } from "../services/userDelete.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import {
  BrowserApprovalError,
  claimBrowserActionApproval,
  createBrowserActionApproval,
  readBrowserActionPayload,
  settleBrowserActionApproval,
  type BrowserApprovalTargetDescriptor,
} from "../services/approvals.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { approvalsRouter } from "./approvals.js";
import { vaultRouter } from "./vault.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let admin: User;
let member: User;
let secondMember: User;
let employee: AIEmployee;
let secondEmployee: AIEmployee;

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
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use("/api/companies/:cid", approvalsRouter);
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
  [owner, admin, member, secondMember] = await Promise.all([
    insert(User, {
      email: "vault-owner@example.com",
      name: "Vault Owner",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: "vault-admin@example.com",
      name: "Vault Admin",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: "vault-member@example.com",
      name: "Vault Member",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: "vault-second@example.com",
      name: "Second Member",
      passwordHash: "x",
      sessionVersion: 0,
    }),
  ]);
  company = await insert(Company, {
    name: "Vault Test Company",
    slug: `vault-test-${randomUUID()}`,
    ownerId: owner.id,
  });
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role }),
    insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role }),
    insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role }),
    insert(Membership, {
      companyId: company.id,
      userId: secondMember.id,
      role: "member" as Role,
    }),
  ]);
  [employee, secondEmployee] = await Promise.all([
    insert(AIEmployee, {
      companyId: company.id,
      name: "Vault Operator",
      slug: "vault-operator",
      role: "Operations",
    }),
    insert(AIEmployee, {
      companyId: company.id,
      name: "Untrusted Employee",
      slug: "untrusted-employee",
      role: "Research",
    }),
  ]);
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = {
  status: number;
  body: T;
  headers: Headers;
};

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/vault${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

async function createItem(
  overrides: Partial<{
    type: "login" | "api_key" | "secure_note";
    visibility: "company" | "restricted";
    title: string;
    username: string;
    secret: string;
    websiteUrl: string;
    notes: string;
    totpSetupKey: string;
  }> = {},
): Promise<Record<string, unknown> & { id: string }> {
  const response = await call<{ item: Record<string, unknown> & { id: string } }>(
    "POST",
    "/items",
    {
      type: "login",
      visibility: "restricted",
      title: "Production login",
      username: "ops@example.com",
      secret: "correct horse battery staple",
      websiteUrl: "https://accounts.example.com/login",
      notes: "Production account",
      ...overrides,
    },
  );
  assert.equal(response.status, 201);
  return response.body.item;
}

function passkeyCredential(
  overrides: Partial<VaultPasskeyCredentialInput> = {},
): VaultPasskeyCredentialInput {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  return {
    credentialId: Buffer.from(randomUUID()).toString("base64"),
    isResidentCredential: true,
    rpId: "example.com",
    privateKey: privateKey.toString("base64"),
    userHandle: Buffer.from("vault-user").toString("base64"),
    signCount: 0,
    backupEligibility: false,
    backupState: false,
    userName: "ops@example.com",
    userDisplayName: "Vault Operator",
    ...overrides,
  };
}

async function registerPasskeyForEmployee(itemId: string, credential: VaultPasskeyCredentialInput) {
  const registration = await beginVaultPasskeyRegistrationForEmployee({
    companyId: company.id,
    employeeId: employee.id,
    itemId,
  });
  return finalizeVaultPasskeyRegistrationForEmployee({
    companyId: company.id,
    employeeId: employee.id,
    itemId,
    registrationLeaseId: registration.registrationLeaseId,
    credential,
  });
}

function assertSafeMetadata(value: Record<string, unknown>): void {
  assert.equal(Object.hasOwn(value, "secret"), false);
  assert.equal(Object.hasOwn(value, "encryptedPayload"), false);
}

describe("Vault human routes", () => {
  test("loads pre-authenticator ciphertext with safe empty defaults", async () => {
    const legacy = await insert(VaultItem, {
      companyId: company.id,
      type: "login",
      visibility: "restricted",
      encryptedPayload: encryptSecret(
        JSON.stringify({
          title: "Legacy login",
          username: "legacy@example.com",
          secret: "legacy-password",
          websiteUrl: "https://legacy.example.com/login",
          notes: "Created before authenticators",
        }),
        `company:${company.id}:vault`,
      ),
      createdByUserId: owner.id,
      createdByEmployeeId: null,
    });
    const response = await call<{ item: Record<string, unknown> }>("GET", `/items/${legacy.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.item.hasTotp, false);
    assert.deepEqual(response.body.item.passkeys, []);
    assertSafeMetadata(response.body.item);
  });

  test("encrypts the full payload and only returns a secret from audited no-store endpoints", async () => {
    const created = await createItem();
    assertSafeMetadata(created);
    assert.equal(created.createdByUserId, owner.id);
    assert.equal(created.createdByEmployeeId, null);

    const stored = await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: created.id });
    assert.doesNotMatch(stored.encryptedPayload, /Production login|ops@example|correct horse/);

    const list = await call<{ items: Array<Record<string, unknown>> }>("GET", "/items");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assertSafeMetadata(list.body.items[0]);
    const detail = await call<{ item: Record<string, unknown> }>("GET", `/items/${created.id}`);
    assert.equal(detail.status, 200);
    assertSafeMetadata(detail.body.item);

    const reveal = await call<{ secret: string }>("POST", `/items/${created.id}/reveal`, {
      purpose: "reveal",
    });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.body.secret, "correct horse battery staple");
    assert.match(reveal.headers.get("cache-control") ?? "", /no-store/);

    const copy = await call<{ secret: string }>("POST", `/items/${created.id}/reveal`, {
      purpose: "copy",
    });
    assert.equal(copy.status, 200);

    const rotated = await call<{ item: Record<string, unknown> }>("PATCH", `/items/${created.id}`, {
      secret: "rotated-never-audited",
      expectedVersion: created.version,
    });
    assert.equal(rotated.status, 200);
    assertSafeMetadata(rotated.body.item);

    const auditRows = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id },
    });
    assert.deepEqual(
      new Set(auditRows.map((row) => row.action)),
      new Set(["vault.item.create", "vault.item.reveal", "vault.item.copy", "vault.item.rotate"]),
    );
    assert.equal(
      auditRows.some((row) => row.metadataJson.includes("rotated-never-audited")),
      false,
    );
  });

  test("locks a passkey login to its normalized exact website origin", async () => {
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Origin-bound login",
      username: "before@example.com",
      secret: "before-password",
      websiteUrl: "https://accounts.example.com/signup",
      notes: "Before",
    });
    const passkey = await registerPasskeyForEmployee(generated.id, passkeyCredential());
    const current = await call<{ item: { version: number } }>("GET", `/items/${generated.id}`);
    assert.equal(current.status, 200);

    const sameOrigin = await call<{
      item: {
        version: number;
        title: string;
        username: string;
        websiteUrl: string;
        notes: string;
      };
    }>("PATCH", `/items/${generated.id}`, {
      expectedVersion: current.body.item.version,
      title: "Updated title",
      username: "after@example.com",
      secret: "after-password",
      websiteUrl: "HTTPS://ACCOUNTS.EXAMPLE.COM:443/security/passkeys?view=all#saved",
      notes: "After",
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.body.item.title, "Updated title");
    assert.equal(sameOrigin.body.item.username, "after@example.com");
    assert.equal(
      sameOrigin.body.item.websiteUrl,
      "https://accounts.example.com/security/passkeys?view=all#saved",
    );
    assert.equal(sameOrigin.body.item.notes, "After");
    const reveal = await call<{ secret: string }>("POST", `/items/${generated.id}/reveal`, {
      purpose: "reveal",
    });
    assert.equal(reveal.body.secret, "after-password");

    for (const websiteUrl of [
      "",
      "http://accounts.example.com/login",
      "https://example.com/login",
      "https://accounts.example.com:444/login",
    ]) {
      const rejected = await call<{ error: string }>("PATCH", `/items/${generated.id}`, {
        expectedVersion: sameOrigin.body.item.version,
        websiteUrl,
      });
      assert.equal(rejected.status, 409);
      assert.match(rejected.body.error, /saved passkeys.*website origin/i);
      assert.doesNotMatch(
        JSON.stringify(rejected.body),
        new RegExp(`${passkey.id}|${generated.id}|after-password`),
      );
    }

    const unchanged = await call<{ item: { version: number; websiteUrl: string } }>(
      "GET",
      `/items/${generated.id}`,
    );
    assert.equal(unchanged.body.item.version, sameOrigin.body.item.version);
    assert.equal(
      unchanged.body.item.websiteUrl,
      "https://accounts.example.com/security/passkeys?view=all#saved",
    );

    const ordinary = await createItem({ websiteUrl: "https://one.example.com/login" });
    const moved = await call<{ item: { websiteUrl: string } }>("PATCH", `/items/${ordinary.id}`, {
      expectedVersion: ordinary.version,
      websiteUrl: "https://two.example.com/login",
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.item.websiteUrl, "https://two.example.com/login");
  });

  test("enforces company visibility, restricted Access, and manager-only sharing/deletion", async () => {
    const restricted = await createItem();
    const companyVisible = await createItem({
      title: "Shared login",
      visibility: "company",
      secret: "shared-secret",
    });

    actingUserId = member.id;
    assert.equal((await call("GET", `/items/${restricted.id}`)).status, 404);
    assert.equal((await call("GET", `/items/${companyVisible.id}`)).status, 200);

    actingUserId = owner.id;
    const shared = await call<{
      access: { id: string; accessLevel: string };
    }>("POST", `/items/${restricted.id}/member-access`, {
      userId: member.id,
      accessLevel: "view",
    });
    assert.equal(shared.status, 200);

    actingUserId = member.id;
    const viewed = await call<{ item: { canEdit: boolean; canShare: boolean } }>(
      "GET",
      `/items/${restricted.id}`,
    );
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.item.canEdit, false);
    assert.equal(viewed.body.item.canShare, false);
    assert.equal(
      (
        await call("PATCH", `/items/${restricted.id}`, {
          title: "Denied",
          expectedVersion: restricted.version,
        })
      ).status,
      403,
    );

    actingUserId = owner.id;
    assert.equal(
      (
        await call("PATCH", `/items/${restricted.id}/member-access/${shared.body.access.id}`, {
          accessLevel: "edit",
        })
      ).status,
      200,
    );

    actingUserId = member.id;
    const edited = await call<{ item: { title: string; canEdit: boolean; canShare: boolean } }>(
      "PATCH",
      `/items/${restricted.id}`,
      { title: "Edited by Member", expectedVersion: restricted.version },
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.item.canEdit, true);
    assert.equal(edited.body.item.canShare, false);
    assert.equal(
      (
        await call("POST", `/items/${restricted.id}/member-access`, {
          userId: secondMember.id,
          accessLevel: "view",
        })
      ).status,
      403,
    );
    assert.equal((await call("DELETE", `/items/${restricted.id}`)).status, 403);

    actingUserId = admin.id;
    const adminView = await call<{ item: { canShare: boolean; canDelete: boolean } }>(
      "GET",
      `/items/${restricted.id}`,
    );
    assert.equal(adminView.status, 200);
    assert.equal(adminView.body.item.canShare, true);
    assert.equal(adminView.body.item.canDelete, true);

    actingUserId = member.id;
    const memberCreated = await createItem({ title: "Member-owned" });
    assert.equal(memberCreated.canShare, true);
    assert.equal(memberCreated.canDelete, true);
  });

  test("rejects a valid general REST API key even when its Member owns the item", async () => {
    await createItem();
    const tokenBody = crypto.randomBytes(32).toString("base64url");
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Leaked key",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
    });
    actingUserId = null;
    const response = await call("GET", "/items", undefined, {
      authorization: `Bearer gen_${tokenBody}`,
    });
    assert.equal(response.status, 403);
    assert.match(String(response.body.error), /logged-in browser session/);
  });

  test("rejects the human Vault API inside an App-owned AI Browser", async () => {
    const created = await createItem({ secret: "must-never-reach-the-ai-browser" });
    const headers = { [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE };

    const list = await call("GET", "/items", undefined, headers);
    const reveal = await call(
      "POST",
      `/items/${created.id}/reveal`,
      { purpose: "reveal" },
      headers,
    );

    assert.equal(list.status, 403);
    assert.equal(reveal.status, 403);
    assert.match(String(reveal.body.error), /AI Browser/);
    assert.doesNotMatch(JSON.stringify([list.body, reveal.body]), /must-never-reach/);
  });

  test("rejects stale whole-payload updates without restoring an older password", async () => {
    const created = await createItem();
    const originalVersion = Number(created.version);
    const rotated = await call<{ item: { version: number } }>("PATCH", `/items/${created.id}`, {
      secret: "newly-rotated-password",
      expectedVersion: originalVersion,
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.item.version, originalVersion + 1);

    const stale = await call("PATCH", `/items/${created.id}`, {
      title: "Stale metadata edit",
      expectedVersion: originalVersion,
    });
    assert.equal(stale.status, 409);

    const reveal = await call<{ secret: string }>("POST", `/items/${created.id}/reveal`, {
      purpose: "reveal",
    });
    assert.equal(reveal.body.secret, "newly-rotated-password");
  });

  test("rejects website URLs that embed credentials", async () => {
    const response = await call("POST", "/items", {
      type: "login",
      visibility: "restricted",
      title: "Unsafe URL",
      username: "owner@example.com",
      secret: "not-in-the-url",
      websiteUrl: "https://embedded:credential@example.com/login",
      notes: "",
    });
    assert.equal(response.status, 400);
    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 0);
  });

  test("creates, reveals, replaces, and removes TOTP without exposing its setup key", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const setupKey =
      `otpauth://totp/Example%3Aops%40example.com?secret=${secret}` +
      "&issuer=Example&algorithm=SHA1&digits=8&period=30";
    const created = await createItem({ totpSetupKey: setupKey });
    assert.equal(created.hasTotp, true);
    assert.deepEqual(created.passkeys, []);
    assert.doesNotMatch(JSON.stringify(created), new RegExp(secret));

    const stored = await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: created.id });
    assert.doesNotMatch(stored.encryptedPayload, new RegExp(secret));
    const fixed = await getVaultTotpCode({
      companyId: company.id,
      itemId: created.id,
      actor: { userId: owner.id, role: "owner" },
      at: new Date(59_000),
    });
    assert.equal(fixed.code, "94287082");
    assert.equal(fixed.expiresAt.toISOString(), "1970-01-01T00:01:00.000Z");

    const current = await call<{ code: string; expiresAt: string }>(
      "POST",
      `/items/${created.id}/totp/code`,
      { purpose: "copy" },
    );
    assert.equal(current.status, 200);
    assert.match(current.body.code, /^\d{8}$/);
    assert.ok(Number.isFinite(Date.parse(current.body.expiresAt)));
    assert.match(current.headers.get("cache-control") ?? "", /no-store/);

    const metadataUpdate = await call<{ item: { hasTotp: boolean; version: number } }>(
      "PATCH",
      `/items/${created.id}`,
      { title: "Renamed login", expectedVersion: Number(created.version) },
    );
    assert.equal(metadataUpdate.status, 200);
    assert.equal(metadataUpdate.body.item.hasTotp, true);
    assert.equal(
      (
        await call("PATCH", `/items/${created.id}`, {
          type: "secure_note",
          expectedVersion: metadataUpdate.body.item.version,
        })
      ).status,
      409,
    );

    const removed = await call<{ item: { hasTotp: boolean } }>(
      "DELETE",
      `/items/${created.id}/totp`,
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.item.hasTotp, false);
    assert.equal(
      (await call("POST", `/items/${created.id}/totp/code`, { purpose: "reveal" })).status,
      404,
    );

    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id },
    });
    assert.ok(audits.some((row) => row.action === "vault.totp.copy"));
    assert.ok(audits.some((row) => row.action === "vault.totp.delete"));
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${secret}|${fixed.code}`));
  });

  test("validates TOTP setup before atomic create and preserves an existing factor on failure", async () => {
    const invalidSetups = [
      "NOT-BASE32-1",
      "otpauth://hotp/Example:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1",
      "otpauth://totp/Example:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5",
      "otpauth://totp/Example:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=9",
      "otpauth://totp/Example:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=5",
    ];
    for (const totpSetupKey of invalidSetups) {
      const response = await call("POST", "/items", {
        type: "login",
        visibility: "restricted",
        title: "Invalid authenticator",
        username: "",
        secret: "password-stays-private",
        websiteUrl: "https://example.com/login",
        notes: "",
        totpSetupKey,
      });
      assert.equal(response.status, 400);
      assert.doesNotMatch(JSON.stringify(response.body), /GEZDGNBV|NOT-BASE32/);
    }
    assert.equal(await AppDataSource.getRepository(VaultItem).count(), 0);

    const created = await createItem({
      totpSetupKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
    const replaced = await call<{ item: { hasTotp: boolean } }>(
      "POST",
      `/items/${created.id}/totp`,
      { setupKey: "JBSWY3DPEHPK3PXP" },
    );
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.item.hasTotp, true);
    const failedReplacement = await call("POST", `/items/${created.id}/totp`, {
      setupKey: "INVALID-SETUP-1",
    });
    assert.equal(failedReplacement.status, 400);
    const stillPresent = await call<{ item: { hasTotp: boolean } }>("GET", `/items/${created.id}`);
    assert.equal(stillPresent.body.item.hasTotp, true);

    const wrongType = await call("POST", "/items", {
      type: "secure_note",
      visibility: "restricted",
      title: "Not a login",
      username: "",
      secret: "note-body",
      websiteUrl: "",
      notes: "",
      totpSetupKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
    assert.equal(wrongType.status, 400);
  });
});

describe("Vault capture approvals", () => {
  const targetFingerprint = "a".repeat(64);
  const targetDescriptor: BrowserApprovalTargetDescriptor = {
    tagName: "input",
    inputType: "password",
    frameUrl: "https://example.com/signup",
    formAction: "https://example.com/accounts",
    formMethod: "POST",
    submitsForm: false,
  };

  test("keeps capture details admin-only and rejects API-key decisions", async () => {
    const browserSessionId = randomUUID();
    const approval = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      action: "vault_capture",
      selector: "aria-ref=e7",
      key: null,
      pageUrl: "https://example.com/reset?token=QUERY_SECRET#FRAGMENT_SECRET",
      browserSessionId,
      targetFingerprint,
      targetDescriptor,
      summary: "Save a hidden password",
      vaultTitle: "Private login title",
      vaultUsername: "private@example.com",
      vaultNotes: "Private notes",
    });

    actingUserId = member.id;
    const memberList = await fetch(`${baseUrl}/api/companies/${company.id}/approvals`).then(
      async (response) => ({ status: response.status, body: await response.json() }),
    );
    assert.equal(memberList.status, 403);
    assert.equal(memberList.body.error, "admin company role required");

    const memberReject = await fetch(
      `${baseUrl}/api/companies/${company.id}/approvals/${approval.id}/reject`,
      { method: "POST" },
    );
    assert.equal(memberReject.status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
      "pending",
    );

    actingUserId = owner.id;
    const ownerList = (await fetch(`${baseUrl}/api/companies/${company.id}/approvals`).then(
      (response) => response.json(),
    )) as Array<Record<string, unknown>>;
    assert.equal(ownerList.length, 1);
    assert.equal(Object.hasOwn(ownerList[0], "payloadJson"), false);
    assert.equal(Object.hasOwn(ownerList[0], "resultJson"), false);
    assert.doesNotMatch(
      JSON.stringify(ownerList),
      /QUERY_SECRET|FRAGMENT_SECRET|private@example.com|Private notes/,
    );
    const storedApproval = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.doesNotMatch(
      storedApproval.payloadJson || "",
      /QUERY_SECRET|FRAGMENT_SECRET|private@example.com|Private notes|Private login title/,
    );
    assert.match(storedApproval.payloadJson || "", /encryptedVaultCapture/);

    const tokenBody = crypto.randomBytes(32).toString("base64url");
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Non-human approval key",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
    });
    actingUserId = null;
    const denied = await fetch(
      `${baseUrl}/api/companies/${company.id}/approvals/${approval.id}/approve`,
      { method: "POST", headers: { authorization: `Bearer gen_${tokenBody}` } },
    );
    assert.equal(denied.status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
      "pending",
    );
  });

  test("claims capture approval once and binds it to employee, session, page, and action", async () => {
    const browserSessionId = randomUUID();
    const approval = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      action: "vault_capture",
      selector: "aria-ref=e9",
      key: null,
      pageUrl: "https://example.com/signup?invite=hidden",
      browserSessionId,
      targetFingerprint,
      targetDescriptor,
      summary: "Save a hidden password",
      vaultTitle: "Approved title",
      vaultUsername: "approved@example.com",
      vaultNotes: "Approved note",
    });
    approval.status = "approved";
    approval.decidedAt = new Date();
    approval.decidedByUserId = owner.id;
    await AppDataSource.getRepository(Approval).save(approval);

    await assert.rejects(
      claimBrowserActionApproval({
        approvalId: approval.id,
        companyId: company.id,
        employeeId: employee.id,
        browserSessionId: randomUUID(),
        action: "vault_capture",
        selector: "aria-ref=e9",
        key: null,
        targetFingerprint,
        targetDescriptor,
        vaultTitle: "Approved title",
        vaultUsername: "approved@example.com",
        vaultNotes: "Approved note",
      }),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );

    const exact = {
      approvalId: approval.id,
      companyId: company.id,
      employeeId: employee.id,
      browserSessionId,
      action: "vault_capture" as const,
      selector: "aria-ref=e9",
      key: null,
      targetFingerprint,
      targetDescriptor,
      vaultTitle: "Approved title",
      vaultUsername: "approved@example.com",
      vaultNotes: "Approved note",
    };
    const claimed = await claimBrowserActionApproval(exact);
    const persisted = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(
      (JSON.parse(persisted.payloadJson || "{}") as { execution?: { state?: unknown } }).execution
        ?.state,
      "claimed",
    );
    await settleBrowserActionApproval({
      approvalId: approval.id,
      claimId: claimed.claimId,
      succeeded: true,
    });
    await assert.rejects(
      claimBrowserActionApproval(exact),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );
  });

  test("claims browser approvals atomically and permits only pre-dispatch failure recovery", async () => {
    const browserSessionId = randomUUID();
    const submitDescriptor: BrowserApprovalTargetDescriptor = {
      ...targetDescriptor,
      tagName: "button",
      inputType: "submit",
      submitsForm: true,
    };
    const approval = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      action: "submit",
      selector: "aria-ref=e12",
      key: null,
      pageUrl: "https://example.com/signup",
      browserSessionId,
      targetFingerprint,
      targetDescriptor: submitDescriptor,
      summary: "Create account",
    });
    approval.status = "approved";
    approval.decidedAt = new Date();
    approval.decidedByUserId = owner.id;
    await AppDataSource.getRepository(Approval).save(approval);

    const exact = {
      approvalId: approval.id,
      companyId: company.id,
      employeeId: employee.id,
      browserSessionId,
      action: "submit" as const,
      selector: "aria-ref=e12",
      key: null,
      targetFingerprint,
      targetDescriptor: submitDescriptor,
    };
    const raced = await Promise.allSettled([
      claimBrowserActionApproval(exact),
      claimBrowserActionApproval(exact),
    ]);
    const fulfilled = raced.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimBrowserActionApproval>>> =>
        result.status === "fulfilled",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);

    await settleBrowserActionApproval({
      approvalId: approval.id,
      claimId: fulfilled[0].value.claimId,
      succeeded: false,
    });
    const retried = await claimBrowserActionApproval(exact);
    await settleBrowserActionApproval({
      approvalId: approval.id,
      claimId: retried.claimId,
      succeeded: true,
    });
    await assert.rejects(
      claimBrowserActionApproval(exact),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );
  });

  test("encrypts and claim-binds the Vault item and TOTP field for delayed submission", async () => {
    const browserSessionId = randomUUID();
    const itemId = randomUUID();
    const itemVersion = 7;
    const totpSelector = "aria-ref=e11";
    const submitDescriptor: BrowserApprovalTargetDescriptor = {
      ...targetDescriptor,
      tagName: "button",
      inputType: "submit",
      submitsForm: true,
    };
    const approval = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      action: "vault_totp_submit",
      selector: "aria-ref=e12",
      key: null,
      pageUrl: "https://example.com/login?challenge=private",
      browserSessionId,
      targetFingerprint,
      targetDescriptor: submitDescriptor,
      summary: "Sign in with a current one-time code",
      vaultItemId: itemId,
      vaultItemVersion: itemVersion,
      vaultTotpSelector: totpSelector,
    });
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.match(stored.payloadJson ?? "", /encryptedVaultTotpSubmit/);
    assert.doesNotMatch(stored.payloadJson ?? "", /vaultItemVersion/);
    assert.doesNotMatch(
      stored.payloadJson ?? "",
      new RegExp(`${itemId}|${totpSelector}|challenge`),
    );
    const decoded = readBrowserActionPayload(stored);
    assert.equal(decoded.action, "vault_totp_submit");
    assert.equal(decoded.vaultItemId, itemId);
    assert.equal(decoded.vaultItemVersion, itemVersion);
    assert.equal(decoded.vaultTotpSelector, totpSelector);

    stored.status = "approved";
    stored.decidedAt = new Date();
    stored.decidedByUserId = owner.id;
    await AppDataSource.getRepository(Approval).save(stored);
    await assert.rejects(
      claimBrowserActionApproval({
        approvalId: approval.id,
        companyId: company.id,
        employeeId: employee.id,
        browserSessionId,
        action: "vault_totp_submit",
        selector: "aria-ref=e12",
        key: null,
        targetFingerprint,
        targetDescriptor: submitDescriptor,
        vaultItemId: randomUUID(),
        vaultItemVersion: itemVersion,
        vaultTotpSelector: totpSelector,
      }),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );
    await assert.rejects(
      claimBrowserActionApproval({
        approvalId: approval.id,
        companyId: company.id,
        employeeId: employee.id,
        browserSessionId,
        action: "vault_totp_submit",
        selector: "aria-ref=e12",
        key: null,
        targetFingerprint,
        targetDescriptor: submitDescriptor,
        vaultItemId: itemId,
        vaultItemVersion: itemVersion + 1,
        vaultTotpSelector: totpSelector,
      }),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );
    const claimed = await claimBrowserActionApproval({
      approvalId: approval.id,
      companyId: company.id,
      employeeId: employee.id,
      browserSessionId,
      action: "vault_totp_submit",
      selector: "aria-ref=e12",
      key: null,
      targetFingerprint,
      targetDescriptor: submitDescriptor,
      vaultItemId: itemId,
      vaultItemVersion: itemVersion,
      vaultTotpSelector: totpSelector,
    });
    await settleBrowserActionApproval({
      approvalId: approval.id,
      claimId: claimed.claimId,
      succeeded: true,
    });
  });

  test("encrypts and claim-binds one-shot Vault passkey actions", async () => {
    const browserSessionId = randomUUID();
    const itemId = randomUUID();
    const itemVersion = 11;
    const passkeyId = randomUUID();
    const selector = "aria-ref=e20";
    const passkeyDescriptor: BrowserApprovalTargetDescriptor = {
      ...targetDescriptor,
      tagName: "button",
      inputType: "button",
      submitsForm: true,
    };
    const approval = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      action: "vault_passkey_use",
      selector,
      key: null,
      pageUrl: "https://example.com/login",
      browserSessionId,
      targetFingerprint,
      targetDescriptor: passkeyDescriptor,
      summary: "Sign in with a software passkey",
      vaultItemId: itemId,
      vaultItemVersion: itemVersion,
      vaultPasskeyId: passkeyId,
    });
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.match(stored.payloadJson ?? "", /encryptedVaultPasskeyAction/);
    assert.doesNotMatch(stored.payloadJson ?? "", /vaultItemVersion/);
    assert.doesNotMatch(stored.payloadJson ?? "", new RegExp(`${itemId}|${passkeyId}|${selector}`));
    const decoded = readBrowserActionPayload(stored);
    assert.equal(decoded.action, "vault_passkey_use");
    assert.equal(decoded.vaultItemId, itemId);
    assert.equal(decoded.vaultItemVersion, itemVersion);
    assert.equal(decoded.vaultPasskeyId, passkeyId);
    assert.equal(decoded.selector, selector);
    stored.status = "approved";
    stored.decidedAt = new Date();
    stored.decidedByUserId = owner.id;
    await AppDataSource.getRepository(Approval).save(stored);
    await assert.rejects(
      claimBrowserActionApproval({
        approvalId: approval.id,
        companyId: company.id,
        employeeId: employee.id,
        browserSessionId,
        action: "vault_passkey_use",
        selector,
        key: null,
        targetFingerprint,
        targetDescriptor: passkeyDescriptor,
        vaultItemId: itemId,
        vaultItemVersion: itemVersion + 1,
        vaultPasskeyId: passkeyId,
      }),
      (error) => error instanceof BrowserApprovalError && error.statusCode === 409,
    );
    // Approval notifications are deliberately fire-and-forget in production;
    // let this test's notification query drain before the next suite rebuilds
    // the shared in-memory schema.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

describe("Vault AI service boundary", () => {
  test("defaults to no Grant, returns safe metadata, and makes manage distinct from use", async () => {
    const item = await createItem({ notes: "Do not expose this context" });
    assert.deepEqual(await listVaultItemsForEmployee(company.id, employee.id), []);

    const grantResponse = await call<{ grant: { id: string } }>(
      "POST",
      `/items/${item.id}/employee-grants`,
      { employeeId: employee.id, accessLevel: "use" },
    );
    assert.equal(grantResponse.status, 200);
    const listed = await listVaultItemsForEmployee(company.id, employee.id);
    assert.equal(listed.length, 1);
    assertSafeMetadata(listed[0] as unknown as Record<string, unknown>);
    assert.equal(Object.hasOwn(listed[0], "notes"), false);
    assert.equal(
      await getVaultFieldForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: item.id,
        field: "secret",
      }),
      "correct horse battery staple",
    );
    await assert.rejects(
      updateVaultLoginMetadataForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: item.id,
        patch: { title: "Use cannot manage" },
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );

    const upgraded = await call(
      "PATCH",
      `/items/${item.id}/employee-grants/${grantResponse.body.grant.id}`,
      { accessLevel: "manage" },
    );
    assert.equal(upgraded.status, 200);
    const updated = await updateVaultLoginMetadataForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: item.id,
      patch: {
        title: "Managed metadata",
        notes: "Preserved internally but not returned",
      },
    });
    assertSafeMetadata(updated as unknown as Record<string, unknown>);
    assert.equal(Object.hasOwn(updated, "notes"), false);
    assert.equal(updated.title, "Managed metadata");
    await assert.rejects(
      updateVaultLoginMetadataForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: item.id,
        patch: {
          websiteUrl: "https://attacker.example",
        } as unknown as { title?: string; username?: string; notes?: string },
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );
    assert.equal(
      await getVaultFieldForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: item.id,
        field: "secret",
      }),
      "correct horse battery staple",
    );

    await assert.rejects(
      getVaultFieldForEmployee({
        companyId: company.id,
        employeeId: secondEmployee.id,
        itemId: item.id,
        field: "secret",
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );
    const otherCompany = await insert(Company, {
      name: "Other Company",
      slug: `other-${randomUUID()}`,
      ownerId: owner.id,
    });
    await assert.rejects(
      listVaultItemsForEmployee(otherCompany.id, employee.id),
      (error) => error instanceof VaultError && error.statusCode === 404,
    );
  });

  test("generates exact-length strong passwords and stores AI logins without returning plaintext", async () => {
    for (const length of [16, 24, 37, 128]) {
      const password = generateVaultPassword(length);
      assert.equal(password.length, length);
      assert.match(password, /[A-Z]/);
      assert.match(password, /[a-z]/);
      assert.match(password, /[0-9]/);
      assert.match(password, /[^A-Za-z0-9]/);
    }
    assert.throws(() => generateVaultPassword(15), VaultError);
    assert.throws(() => generateVaultPassword(129), VaultError);

    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Generated login",
      username: "generated@example.com",
      websiteUrl: "https://generated.example.com",
      notes: "Internal context",
      passwordLength: 37,
    });
    assert.equal(generated.visibility, "company");
    assert.equal(generated.grantAccessLevel, "manage");
    assertSafeMetadata(generated as unknown as Record<string, unknown>);
    assert.equal(Object.hasOwn(generated, "notes"), false);

    actingUserId = member.id;
    const reveal = await call<{ secret: string }>("POST", `/items/${generated.id}/reveal`, {
      purpose: "reveal",
    });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.body.secret.length, 37);

    const captured = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Captured login",
      secret: "captured-without-model-exposure",
      websiteUrl: "https://captured.example.com",
      visibility: "restricted",
    });
    assert.equal(captured.visibility, "restricted");
    actingUserId = owner.id;
    const capturedReveal = await call<{ secret: string }>("POST", `/items/${captured.id}/reveal`, {
      purpose: "reveal",
    });
    assert.equal(capturedReveal.status, 200);
    assert.equal(capturedReveal.body.secret, "captured-without-model-exposure");
  });

  test("lets an AI Employee store and use TOTP only through live Vault Grants", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "TOTP signup",
      websiteUrl: "https://accounts.example.com/signup",
    });
    const stored = await setVaultTotpForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      setupKey: `${secret}`,
    });
    assert.deepEqual(stored, { id: generated.id, title: "TOTP signup", hasTotp: true });
    const boundTotpVersion = (
      await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: generated.id })
    ).version;
    const code = await getVaultTotpCodeForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      expectedVersion: boundTotpVersion,
      at: new Date(59_000),
    });
    assert.equal(code.code, "287082");
    assert.equal(code.expiresAt.toISOString(), "1970-01-01T00:01:00.000Z");
    assert.equal(code.itemVersion, boundTotpVersion);
    await assert.rejects(
      setVaultTotpForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        setupKey: secret,
        expectedVersion: boundTotpVersion - 1,
        expectedOrigin: "https://accounts.example.com",
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    await assert.rejects(
      setVaultTotpForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        setupKey: secret,
        expectedVersion: boundTotpVersion,
        expectedOrigin: "https://different.example.com",
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );

    const listed = await listVaultItemsForEmployee(company.id, employee.id);
    assert.equal(listed[0].hasTotp, true);
    assert.deepEqual(listed[0].passkeys, []);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(`${secret}|${code.code}`));
    const ciphertext = (
      await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: generated.id })
    ).encryptedPayload;
    assert.doesNotMatch(ciphertext, new RegExp(secret));
    await updateVaultLoginMetadataForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      patch: { notes: "Changed after delayed TOTP approval" },
    });
    await assert.rejects(
      getVaultTotpCodeForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        expectedVersion: boundTotpVersion,
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );

    const humanCreated = await createItem({ title: "Human-owned factor" });
    await call("POST", `/items/${humanCreated.id}/employee-grants`, {
      employeeId: employee.id,
      accessLevel: "manage",
    });
    await assert.rejects(
      setVaultTotpForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: humanCreated.id,
        setupKey: secret,
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );

    await AppDataSource.getRepository(EmployeeVaultGrant).delete({
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: generated.id,
    });
    await assert.rejects(
      getVaultTotpCodeForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );
  });

  test("reserves passkey registration across processes and finalizes by token after revocation", async () => {
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Reserved passkey signup",
      username: "ops@example.com",
      websiteUrl: "https://accounts.example.com/signup",
    });
    await setVaultTotpForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      setupKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
    const beforeRegistration = await AppDataSource.getRepository(VaultItem).findOneByOrFail({
      id: generated.id,
    });
    await assert.rejects(
      beginVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        expectedVersion: beforeRegistration.version - 1,
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );

    const raced = await Promise.allSettled([
      beginVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        expectedVersion: beforeRegistration.version,
      }),
      beginVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        expectedVersion: beforeRegistration.version,
      }),
    ]);
    const acquired = raced.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof beginVaultPasskeyRegistrationForEmployee>>
      > => result.status === "fulfilled",
    );
    assert.equal(acquired.length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const firstRegistration = acquired[0].value;
    assert.deepEqual(Object.keys(firstRegistration.item).sort(), [
      "companyId",
      "createdByEmployeeId",
      "id",
      "title",
      "type",
      "username",
      "version",
      "websiteUrl",
    ]);
    assertSafeMetadata(firstRegistration.item);
    const safeDuringRegistration = await call<{ item: Record<string, unknown> }>(
      "GET",
      `/items/${generated.id}`,
    );
    assert.equal(
      JSON.stringify(safeDuringRegistration.body).includes(firstRegistration.registrationLeaseId),
      false,
    );
    const encryptedDuringRegistration = await AppDataSource.getRepository(
      VaultItem,
    ).findOneByOrFail({ id: generated.id });
    assert.equal(
      encryptedDuringRegistration.encryptedPayload.includes(firstRegistration.registrationLeaseId),
      false,
    );

    await AppDataSource.getRepository(EmployeeVaultGrant).delete({
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: generated.id,
    });
    const firstCredential = passkeyCredential();
    const firstPasskey = await finalizeVaultPasskeyRegistrationForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      registrationLeaseId: firstRegistration.registrationLeaseId,
      credential: firstCredential,
    });
    assert.equal(firstPasskey.rpId, "example.com");
    assert.equal(Object.hasOwn(firstPasskey, "privateKey"), false);
    await insert(EmployeeVaultGrant, {
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: generated.id,
      accessLevel: "manage",
    });

    const secondRegistration = await beginVaultPasskeyRegistrationForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
    });
    const concurrentUse = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: firstPasskey.id,
    });
    const current = await call<{ item: { version: number } }>("GET", `/items/${generated.id}`);
    const blockedUpdate = await call<{ error: string }>("PATCH", `/items/${generated.id}`, {
      expectedVersion: current.body.item.version,
      title: "Must not change during registration",
    });
    assert.equal(blockedUpdate.status, 409);
    assert.match(blockedUpdate.body.error, /completing a software passkey registration/i);
    assert.equal((await call("DELETE", `/items/${generated.id}`)).status, 409);
    assert.equal(
      (await call("DELETE", `/items/${generated.id}/passkeys/${firstPasskey.id}`)).status,
      409,
    );
    assert.equal(
      (
        await call("POST", `/items/${generated.id}/totp`, {
          setupKey: "JBSWY3DPEHPK3PXP",
        })
      ).status,
      409,
    );
    await assert.rejects(
      updateVaultLoginMetadataForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        patch: { notes: "Must not change during registration" },
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    await assert.rejects(
      setVaultTotpForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        setupKey: "JBSWY3DPEHPK3PXP",
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    assert.equal(
      (
        await call("POST", `/items/${generated.id}/totp/code`, {
          purpose: "reveal",
        })
      ).status,
      200,
    );

    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 31_000;
    const newerRegistration = await (async () => {
      try {
        return await beginVaultPasskeyRegistrationForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
        });
      } finally {
        Date.now = originalDateNow;
      }
    })();
    await releaseVaultPasskeyRegistrationForEmployee({
      companyId: company.id,
      itemId: generated.id,
      registrationLeaseId: secondRegistration.registrationLeaseId,
    });
    await assert.rejects(
      beginVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    await assert.rejects(
      finalizeVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        registrationLeaseId: secondRegistration.registrationLeaseId,
        credential: passkeyCredential(),
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    const secondPasskey = await finalizeVaultPasskeyRegistrationForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      registrationLeaseId: newerRegistration.registrationLeaseId,
      credential: passkeyCredential(),
    });
    assert.notEqual(secondPasskey.id, firstPasskey.id);
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: firstPasskey.id,
      leaseId: concurrentUse.leaseId,
    });
    const after = await call<{ item: { hasTotp: boolean; passkeys: unknown[] } }>(
      "GET",
      `/items/${generated.id}`,
    );
    assert.equal(after.body.item.hasTotp, true);
    assert.equal(after.body.item.passkeys.length, 2);
  });

  test("leases software passkey use, persists counters, and exposes metadata only", async () => {
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Passkey signup",
      username: "ops@example.com",
      websiteUrl: "https://accounts.example.com/signup",
    });
    const credential = passkeyCredential();
    const saved = await registerPasskeyForEmployee(generated.id, credential);
    assert.equal(saved.rpId, "example.com");
    assert.equal(Object.hasOwn(saved, "privateKey"), false);
    assert.equal(Object.hasOwn(saved, "credentialId"), false);

    const listed = await listVaultItemsForEmployee(company.id, employee.id);
    assert.equal(listed[0].passkeys.length, 1);
    assert.equal(listed[0].passkeys[0].id, saved.id);
    assert.equal(JSON.stringify(listed).includes(credential.privateKey), false);
    assert.equal(JSON.stringify(listed).includes(credential.credentialId), false);
    const ciphertext = (
      await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: generated.id })
    ).encryptedPayload;
    assert.equal(ciphertext.includes(credential.privateKey), false);

    const approvalBoundVersion = (
      await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: generated.id })
    ).version;
    await updateVaultLoginMetadataForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      patch: { notes: "Changed after delayed passkey approval" },
    });
    await assert.rejects(
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
        expectedVersion: approvalBoundVersion,
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    const currentUseVersion = (
      await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: generated.id })
    ).version;
    const versionBoundLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
      expectedVersion: currentUseVersion,
    });
    assert.equal(versionBoundLease.item.version, currentUseVersion + 1);
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: versionBoundLease.leaseId,
    });

    const leaseRepo = AppDataSource.getRepository(VaultItem);
    const leaseOriginalUpdate = leaseRepo.update.bind(leaseRepo);
    let injectAcquireConflict = true;
    leaseRepo.update = (async (criteria, partial) => {
      if (injectAcquireConflict) {
        injectAcquireConflict = false;
        leaseRepo.update = leaseOriginalUpdate as typeof leaseRepo.update;
        await updateVaultLoginMetadataForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          patch: { notes: "Concurrent with lease acquire" },
        });
      }
      return leaseOriginalUpdate(criteria, partial);
    }) as typeof leaseRepo.update;
    const conflictLease = await (async () => {
      try {
        return await getVaultPasskeyForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          passkeyId: saved.id,
        });
      } finally {
        leaseRepo.update = leaseOriginalUpdate as typeof leaseRepo.update;
      }
    })();

    let injectReleaseConflict = true;
    leaseRepo.update = (async (criteria, partial) => {
      if (injectReleaseConflict) {
        injectReleaseConflict = false;
        leaseRepo.update = leaseOriginalUpdate as typeof leaseRepo.update;
        await updateVaultLoginMetadataForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          patch: { notes: "Concurrent with lease release" },
        });
      }
      return leaseOriginalUpdate(criteria, partial);
    }) as typeof leaseRepo.update;
    try {
      await releaseVaultPasskeyUseForEmployee({
        companyId: company.id,
        itemId: generated.id,
        passkeyId: saved.id,
        leaseId: conflictLease.leaseId,
      });
    } finally {
      leaseRepo.update = leaseOriginalUpdate as typeof leaseRepo.update;
    }

    const racedLeases = await Promise.allSettled([
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
      }),
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
      }),
    ]);
    const acquired = racedLeases.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof getVaultPasskeyForEmployee>>> =>
        result.status === "fulfilled",
    );
    assert.equal(acquired.length, 1);
    assert.equal(racedLeases.filter((result) => result.status === "rejected").length, 1);
    const firstLease = acquired[0].value;
    assert.equal((await call("DELETE", `/items/${generated.id}`)).status, 409);
    assert.equal((await call("DELETE", `/items/${generated.id}/passkeys/${saved.id}`)).status, 409);
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: firstLease.leaseId,
    });

    const newerLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: firstLease.leaseId,
    });
    await assert.rejects(
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: newerLease.leaseId,
    });

    const assertionLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    const assertionCount = assertionLease.passkey.signCount + 1;
    const itemRepo = AppDataSource.getRepository(VaultItem);
    const originalUpdate = itemRepo.update.bind(itemRepo);
    let injectedMetadataWrite = false;
    itemRepo.update = (async (criteria, partial) => {
      if (!injectedMetadataWrite) {
        injectedMetadataWrite = true;
        itemRepo.update = originalUpdate as typeof itemRepo.update;
        await updateVaultLoginMetadataForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          patch: { notes: "Concurrent metadata survives assertion persistence" },
        });
      }
      return originalUpdate(criteria, partial);
    }) as typeof itemRepo.update;
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 121_000;
    const recorded = await (async () => {
      try {
        return await recordVaultPasskeyUseForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          passkeyId: saved.id,
          leaseId: assertionLease.leaseId,
          credential: { ...credential, signCount: assertionCount },
        });
      } finally {
        Date.now = originalDateNow;
        itemRepo.update = originalUpdate as typeof itemRepo.update;
      }
    })();
    assert.equal(recorded.passkey.lastUsedAt instanceof Date, true);
    actingUserId = owner.id;
    const afterConcurrentWrite = await call<{ item: { notes: string } }>(
      "GET",
      `/items/${generated.id}`,
    );
    assert.equal(
      afterConcurrentWrite.body.item.notes,
      "Concurrent metadata survives assertion persistence",
    );

    const rollbackLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    assert.equal(rollbackLease.passkey.signCount, assertionCount);
    await assert.rejects(
      recordVaultPasskeyUseForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
        leaseId: rollbackLease.leaseId,
        credential: { ...credential, signCount: rollbackLease.passkey.signCount },
      }),
      (error) => error instanceof VaultError && error.statusCode === 409,
    );
    const afterFailedAssertion = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: afterFailedAssertion.leaseId,
    });

    const revokedLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    const assertedBeforeRevocation = {
      ...credential,
      signCount: revokedLease.passkey.signCount + 1,
    };
    await AppDataSource.getRepository(EmployeeVaultGrant).delete({
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: generated.id,
    });
    const persistedAfterRevocation = await recordVaultPasskeyUseForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: revokedLease.leaseId,
      credential: assertedBeforeRevocation,
    });
    assert.equal(persistedAfterRevocation.passkey.lastUsedAt instanceof Date, true);
    await assert.rejects(
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );
    await insert(EmployeeVaultGrant, {
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: generated.id,
      accessLevel: "manage",
    });
    const afterRegrant = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    assert.equal(afterRegrant.passkey.signCount, assertedBeforeRevocation.signCount);
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: afterRegrant.leaseId,
    });

    actingUserId = owner.id;
    const deleted = await call<{ item: { passkeys: unknown[] } }>(
      "DELETE",
      `/items/${generated.id}/passkeys/${saved.id}`,
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.item.passkeys, []);
    await assert.rejects(
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: saved.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 404,
    );
  });

  test("durably reserves a new passkey counter before every Browser assertion", async () => {
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Durable passkey counter",
      websiteUrl: "https://accounts.example.com/login",
    });
    const credential = passkeyCredential();
    const saved = await registerPasskeyForEmployee(generated.id, credential);

    const abandonedLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    const abandonedAssertionCount = abandonedLease.passkey.signCount + 1;
    await releaseVaultPasskeyUseForEmployee({
      companyId: company.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: abandonedLease.leaseId,
    });

    const failedPersistenceLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    assert.equal(failedPersistenceLease.passkey.signCount, abandonedAssertionCount);
    const failedAssertionCount = failedPersistenceLease.passkey.signCount + 1;
    assert.ok(failedAssertionCount > abandonedAssertionCount);

    const itemRepo = AppDataSource.getRepository(VaultItem);
    const originalUpdate = itemRepo.update.bind(itemRepo);
    let forcedRecordConflicts = 0;
    itemRepo.update = (async (criteria, partial) => {
      if (forcedRecordConflicts < 5) {
        forcedRecordConflicts += 1;
        return { generatedMaps: [], raw: [], affected: 0 };
      }
      return originalUpdate(criteria, partial);
    }) as typeof itemRepo.update;
    try {
      await assert.rejects(
        recordVaultPasskeyUseForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: generated.id,
          passkeyId: saved.id,
          leaseId: failedPersistenceLease.leaseId,
          credential: { ...credential, signCount: failedAssertionCount },
        }),
        (error) => error instanceof VaultError && error.statusCode === 409,
      );
    } finally {
      itemRepo.update = originalUpdate as typeof itemRepo.update;
    }
    assert.equal(forcedRecordConflicts, 5);

    const recoveredLease = await getVaultPasskeyForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
    });
    assert.equal(recoveredLease.passkey.signCount, failedAssertionCount);
    const recoveredAssertionCount = recoveredLease.passkey.signCount + 1;
    assert.ok(recoveredAssertionCount > failedAssertionCount);
    await recordVaultPasskeyUseForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: generated.id,
      passkeyId: saved.id,
      leaseId: recoveredLease.leaseId,
      credential: { ...credential, signCount: recoveredAssertionCount },
    });
  });

  test("rejects passkeys for the wrong RP, invalid key material, and Member-created logins", async () => {
    const generated = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Bound passkey",
      websiteUrl: "https://accounts.example.com/signup",
    });
    await assert.rejects(
      registerPasskeyForEmployee(generated.id, passkeyCredential({ rpId: "attacker.example" })),
      (error) => error instanceof VaultError && error.statusCode === 400,
    );
    await assert.rejects(
      registerPasskeyForEmployee(
        generated.id,
        passkeyCredential({ privateKey: Buffer.from("not-pkcs8").toString("base64") }),
      ),
      (error) => error instanceof VaultError && error.statusCode === 400,
    );
    const exhausted = await registerPasskeyForEmployee(
      generated.id,
      passkeyCredential({ signCount: 0xffffffff }),
    );
    await assert.rejects(
      getVaultPasskeyForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: generated.id,
        passkeyId: exhausted.id,
      }),
      (error) =>
        error instanceof VaultError && error.statusCode === 409 && /exhausted/i.test(error.message),
    );

    const humanCreated = await createItem({ title: "Human-owned passkey" });
    await call("POST", `/items/${humanCreated.id}/employee-grants`, {
      employeeId: employee.id,
      accessLevel: "manage",
    });
    await assert.rejects(
      beginVaultPasskeyRegistrationForEmployee({
        companyId: company.id,
        employeeId: employee.id,
        itemId: humanCreated.id,
      }),
      (error) => error instanceof VaultError && error.statusCode === 403,
    );
  });

  test("an AI metadata race cannot restore the password a Member just rotated", async () => {
    const item = await createItem();
    await call("POST", `/items/${item.id}/employee-grants`, {
      employeeId: employee.id,
      accessLevel: "manage",
    });

    const repo = AppDataSource.getRepository(VaultItem);
    const originalUpdate = repo.update.bind(repo);
    let injectedRotation = false;
    repo.update = (async (criteria, partial) => {
      if (!injectedRotation) {
        injectedRotation = true;
        repo.update = originalUpdate as typeof repo.update;
        await updateVaultItem({
          companyId: company.id,
          itemId: item.id,
          actor: { userId: owner.id, role: "owner" },
          expectedVersion: Number(item.version),
          patch: { secret: "human-rotation-wins" },
        });
      }
      return originalUpdate(criteria, partial);
    }) as typeof repo.update;

    try {
      await assert.rejects(
        updateVaultLoginMetadataForEmployee({
          companyId: company.id,
          employeeId: employee.id,
          itemId: item.id,
          patch: { title: "Racing AI metadata" },
        }),
        (error) => error instanceof VaultError && error.statusCode === 409,
      );
    } finally {
      repo.update = originalUpdate as typeof repo.update;
    }

    const secret = await getVaultFieldForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      itemId: item.id,
      field: "secret",
    });
    assert.equal(secret, "human-rotation-wins");
  });

  test("employee deletion removes Grants and clears AI provenance", async () => {
    const created = await createVaultLoginForEmployee({
      companyId: company.id,
      employeeId: employee.id,
      title: "Durable human recovery",
      websiteUrl: "https://durable.example.com",
    });
    actingUserId = owner.id;
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/${employee.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      await AppDataSource.getRepository(EmployeeVaultGrant).countBy({ employeeId: employee.id }),
      0,
    );
    const remaining = await AppDataSource.getRepository(VaultItem).findOneByOrFail({
      id: created.id,
    });
    assert.equal(remaining.createdByEmployeeId, null);
    assert.equal(remaining.visibility, "company");
  });

  test("Member deletion removes explicit Access while preserving items and creator history", async () => {
    const ownerItem = await createItem({ title: "Owner item" });
    const shared = await call<{ access: { id: string } }>(
      "POST",
      `/items/${ownerItem.id}/member-access`,
      { userId: member.id, accessLevel: "view" },
    );
    assert.equal(shared.status, 200);

    actingUserId = member.id;
    const memberItem = await createItem({ title: "Former Member item", visibility: "company" });
    await deleteUserCascade({ userId: member.id });

    assert.equal(
      await AppDataSource.getRepository(VaultItemMemberAccess).countBy({ userId: member.id }),
      0,
    );
    assert.equal(
      (await AppDataSource.getRepository(VaultItem).findOneByOrFail({ id: memberItem.id }))
        .createdByUserId,
      null,
    );
    assert.ok(await AppDataSource.getRepository(VaultItem).findOneBy({ id: ownerItem.id }));
    assert.equal(await AppDataSource.getRepository(User).findOneBy({ id: member.id }), null);
  });

  test("company deletion clears Vault items, Member Access, and AI Employee Grants", async () => {
    const item = await createItem();
    await call("POST", `/items/${item.id}/member-access`, {
      userId: member.id,
      accessLevel: "view",
    });
    await call("POST", `/items/${item.id}/employee-grants`, {
      employeeId: employee.id,
      accessLevel: "use",
    });

    await deleteCompanyCascade({ companyId: company.id, companySlug: company.slug });
    assert.equal(
      await AppDataSource.getRepository(VaultItem).countBy({ companyId: company.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(VaultItemMemberAccess).countBy({ companyId: company.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(EmployeeVaultGrant).countBy({ companyId: company.id }),
      0,
    );
    assert.equal(await AppDataSource.getRepository(Company).findOneBy({ id: company.id }), null);
  });
});
