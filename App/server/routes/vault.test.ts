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
import {
  createVaultLoginForEmployee,
  generateVaultPassword,
  getVaultFieldForEmployee,
  listVaultItemsForEmployee,
  updateVaultItem,
  updateVaultLoginMetadataForEmployee,
  VaultError,
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

function assertSafeMetadata(value: Record<string, unknown>): void {
  assert.equal(Object.hasOwn(value, "secret"), false);
  assert.equal(Object.hasOwn(value, "encryptedPayload"), false);
}

describe("Vault human routes", () => {
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
