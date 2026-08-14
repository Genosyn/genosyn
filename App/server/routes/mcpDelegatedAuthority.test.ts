import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let membership: Membership;
let requester: User;
let project: Project;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Delegation Co",
    slug: "delegation-co",
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Project partner",
    slug: "project-partner",
    role: "Operations",
    soulBody: "",
  });
  requester = await insert(User, {
    email: "member@delegation.example",
    passwordHash: "hash",
    name: "Delegating Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  membership = await insert(Membership, {
    companyId: company.id,
    userId: requester.id,
    role: "member",
    financeAccess: "none",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Restricted launch",
    slug: "restricted-launch",
    description: "",
    key: "RL",
    createdById: "owner-1",
    todoCounter: 0,
    accessMode: "restricted",
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: membership.userId,
    requesterSessionVersion: requester.sessionVersion,
  });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function call(tool: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { error?: string },
  };
}

async function internalRequest(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${path}`, {
    method: options.method ?? "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: options.method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { error?: string },
  };
}

async function approvedBrowserAction(): Promise<Approval> {
  return insert(Approval, {
    companyId: company.id,
    kind: "browser_action",
    routineId: "",
    employeeId: employee.id,
    title: "Submit checkout",
    summary: "Place the reviewed order",
    payloadJson: JSON.stringify({
      selector: "aria-ref=e12",
      key: null,
      pageUrl: "https://shop.example.test/checkout",
    }),
    resultJson: null,
    errorMessage: null,
    status: "approved",
    decidedAt: new Date(),
    decidedByUserId: "owner-1",
  });
}

async function grantProject(
  kind: "ai" | "user",
  accessLevel: "read" | "write",
): Promise<ProjectMember> {
  return insert(ProjectMember, {
    projectId: project.id,
    memberKind: kind,
    userId: kind === "user" ? membership.userId : null,
    employeeId: kind === "ai" ? employee.id : null,
    accessLevel,
  });
}

async function createWorkspaceChannel(params: {
  name: string;
  kind: "public" | "private" | "dm";
  companyId?: string;
  userIds?: string[];
  employeeIds?: string[];
}): Promise<Channel> {
  const channel = await insert(Channel, {
    companyId: params.companyId ?? company.id,
    kind: params.kind,
    name: params.kind === "dm" ? null : params.name,
    slug: params.kind === "dm" ? null : params.name,
    topic: `${params.name} topic`,
    webhookToken: null,
    createdByUserId: requester.id,
    archivedAt: null,
    lastMessageAt: null,
  });
  for (const userId of params.userIds ?? []) {
    await insert(ChannelMember, {
      channelId: channel.id,
      memberKind: "user",
      userId,
      employeeId: null,
      lastReadAt: null,
    });
  }
  for (const employeeId of params.employeeIds ?? []) {
    await insert(ChannelMember, {
      channelId: channel.id,
      memberKind: "ai",
      userId: null,
      employeeId,
      lastReadAt: null,
    });
  }
  return channel;
}

async function addWorkspaceMember(
  channelId: string,
  member: { userId: string } | { employeeId: string },
): Promise<ChannelMember> {
  return insert(ChannelMember, {
    channelId,
    memberKind: "userId" in member ? "user" : "ai",
    userId: "userId" in member ? member.userId : null,
    employeeId: "employeeId" in member ? member.employeeId : null,
    lastReadAt: null,
  });
}

function useEmployeeAuthority(): void {
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
}

describe("interactive MCP authority", () => {
  test("filters a restricted Project unless both principals can read it", async () => {
    await grantProject("ai", "write");
    let response = await call("list_projects");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.projects, []);

    await grantProject("user", "read");
    response = await call("list_projects");
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body.projects as Array<{ id: string }>).map((row) => row.id),
      [project.id],
    );
  });

  test("requires both the Member and AI Employee to write a restricted Project", async () => {
    await grantProject("ai", "write");
    const memberGrant = await grantProject("user", "read");

    const denied = await call("create_todo", {
      projectSlug: project.slug,
      title: "Prepare launch",
    });
    assert.equal(denied.status, 403);
    assert.equal(await todoCount(), 0);

    memberGrant.accessLevel = "write";
    // Use the repository directly to prove a change takes effect with the
    // already-issued token; delegated access is never snapshotted.
    await AppDataSource.getRepository(ProjectMember).save(memberGrant);
    const allowed = await call("create_todo", {
      projectSlug: project.slug,
      title: "Prepare launch",
    });
    assert.equal(allowed.status, 200, allowed.body.error);
    assert.equal(await todoCount(), 1);
  });

  test("regular Members cannot delegate administrative Skill or Connection access", async () => {
    const skill = await call("create_skill", {
      employeeSlug: employee.slug,
      name: "Escalated playbook",
      body: "Do privileged work",
    });
    assert.equal(skill.status, 403);
    assert.match(skill.body.error ?? "", /owner or admin/);

    const response = await fetch(`${baseUrl}/internal/mcp/integrations/_list`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
  });

  test("owner/admin Member authority keeps administrative delegation available", async () => {
    membership.role = "admin";
    await AppDataSource.getRepository(Membership).save(membership);
    const response = await call("create_skill", {
      employeeSlug: employee.slug,
      name: "Approved playbook",
      body: "Work approved by an admin",
    });
    assert.equal(response.status, 200, response.body.error);
  });

  test("revokes an already-issued delegated token when the Member auth epoch changes", async () => {
    requester.sessionVersion += 1;
    await AppDataSource.getRepository(User).save(requester);

    const denied = await call("list_projects");
    assert.equal(denied.status, 403);
    assert.match(denied.body.error ?? "", /authentication changed/);

    // The mismatch destroys the token, so even an impossible epoch rollback
    // cannot resurrect authority delegated by the old browser session.
    requester.sessionVersion -= 1;
    await AppDataSource.getRepository(User).save(requester);
    const replay = await call("list_projects");
    assert.equal(replay.status, 401);
  });

  test("attachment tools cannot cross another Member's private transcript", async () => {
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: "other-member",
      title: "Private",
      source: "web",
    });
    const message = await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "user",
      content: "Private attachment",
      status: null,
    });
    const attachment = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "private.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("not a pdf"),
      uploadedByUserId: null,
    });
    attachment.messageId = message.id;
    await AppDataSource.getRepository(Attachment).save(attachment);

    const denied = await call("read_pdf_fields", { attachmentId: attachment.id });
    assert.equal(denied.status, 404);

    membership.role = "admin";
    await AppDataSource.getRepository(Membership).save(membership);
    const deniedAdmin = await call("read_pdf_fields", { attachmentId: attachment.id });
    assert.equal(deniedAdmin.status, 404);

    attachment.uploadedByUserId = membership.userId;
    await AppDataSource.getRepository(Attachment).save(attachment);
    const owned = await call("read_pdf_fields", { attachmentId: attachment.id });
    assert.equal(owned.status, 400);
    assert.match(owned.body.error ?? "", /not a PDF/);
  });

  test("lists only channels visible to both the Member and AI Employee", async () => {
    const publicChannel = await createWorkspaceChannel({ name: "public-room", kind: "public" });
    await createWorkspaceChannel({
      name: "employee-only",
      kind: "private",
      employeeIds: [employee.id],
    });
    await createWorkspaceChannel({
      name: "member-only",
      kind: "private",
      userIds: [requester.id],
    });
    const sharedPrivate = await createWorkspaceChannel({
      name: "shared-private",
      kind: "private",
      userIds: [requester.id],
      employeeIds: [employee.id],
    });
    await createWorkspaceChannel({
      name: "shared-dm",
      kind: "dm",
      userIds: [requester.id],
      employeeIds: [employee.id],
    });

    const response = await call("list_workspace_channels");
    assert.equal(response.status, 200, response.body.error);
    assert.deepEqual(
      (response.body.channels as Array<{ id: string }>).map((row) => row.id).sort(),
      [publicChannel.id, sharedPrivate.id].sort(),
    );
  });

  test("requires both principals for every private channel mutation and post", async () => {
    const employeeOnly = await createWorkspaceChannel({
      name: "employee-only",
      kind: "private",
      employeeIds: [employee.id],
    });
    const memberOnly = await createWorkspaceChannel({
      name: "member-only",
      kind: "private",
      userIds: [requester.id],
    });

    for (const channel of [employeeOnly, memberOnly]) {
      const rename = await call("rename_workspace_channel", {
        channel: channel.id,
        topic: "should not change",
      });
      assert.equal(rename.status, 404);
      const post = await call("send_workspace_message", {
        channel: channel.id,
        content: "should not send",
      });
      assert.equal(post.status, 404);
      const archive = await call("archive_workspace_channel", { channel: channel.id });
      assert.equal(archive.status, 404);
    }
    assert.equal(await AppDataSource.getRepository(ChannelMessage).count(), 0);

    await addWorkspaceMember(employeeOnly.id, { userId: requester.id });
    const renamed = await call("rename_workspace_channel", {
      channel: employeeOnly.id,
      name: "shared-room",
    });
    assert.equal(renamed.status, 200, renamed.body.error);
    const posted = await call("send_workspace_message", {
      channel: employeeOnly.id,
      content: "Visible to both principals",
    });
    assert.equal(posted.status, 200, posted.body.error);
    const archived = await call("archive_workspace_channel", { channel: employeeOnly.id });
    assert.equal(archived.status, 200, archived.body.error);
    assert.equal(await AppDataSource.getRepository(ChannelMessage).count(), 1);
  });

  test("lets a delegated Member use public channels without weakening private membership", async () => {
    const publicChannel = await createWorkspaceChannel({ name: "company-room", kind: "public" });
    const posted = await call("send_workspace_message", {
      channel: publicChannel.id,
      content: "Company-visible update",
    });
    assert.equal(posted.status, 200, posted.body.error);
    assert.ok(
      await AppDataSource.getRepository(ChannelMember).findOneBy({
        channelId: publicChannel.id,
        memberKind: "ai",
        employeeId: employee.id,
      }),
    );

    const created = await call("create_workspace_channel", {
      name: "delegated-private",
      kind: "private",
    });
    assert.equal(created.status, 200, created.body.error);
    const createdId = (created.body.channel as { id: string }).id;
    const stored = await AppDataSource.getRepository(Channel).findOneByOrFail({ id: createdId });
    assert.equal(stored.createdByUserId, requester.id);
    const participants = await AppDataSource.getRepository(ChannelMember).find({
      where: { channelId: createdId },
    });
    assert.deepEqual(
      participants
        .map((row) => (row.userId ? `user:${row.userId}` : `ai:${row.employeeId}`))
        .sort(),
      [`ai:${employee.id}`, `user:${requester.id}`].sort(),
    );
  });

  test("does not treat owner/admin status as membership in a private channel", async () => {
    membership.role = "admin";
    await AppDataSource.getRepository(Membership).save(membership);
    const privateChannel = await createWorkspaceChannel({
      name: "board-private",
      kind: "private",
      employeeIds: [employee.id],
    });

    let listed = await call("list_workspace_channels");
    assert.deepEqual(listed.body.channels, []);
    const denied = await call("send_workspace_message", {
      channel: privateChannel.id,
      content: "Admin is not a participant",
    });
    assert.equal(denied.status, 404);

    await addWorkspaceMember(privateChannel.id, { userId: requester.id });
    listed = await call("list_workspace_channels");
    assert.deepEqual(
      (listed.body.channels as Array<{ id: string }>).map((row) => row.id),
      [privateChannel.id],
    );
    const allowed = await call("send_workspace_message", {
      channel: privateChannel.id,
      content: "Admin is now a participant",
    });
    assert.equal(allowed.status, 200, allowed.body.error);
  });

  test("allows only a requester-visible human DM during Member delegation", async () => {
    const otherEmployee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Private peer",
      slug: "private-peer",
      role: "Operations",
      soulBody: "",
    });
    const otherUser = await insert(User, {
      email: "other@delegation.example",
      passwordHash: "hash",
      name: "Other Member",
      emailVerifiedAt: new Date(),
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: otherUser.id,
      role: "member",
      financeAccess: "none",
    });
    const hiddenDm = await createWorkspaceChannel({
      name: "hidden-dm",
      kind: "dm",
      userIds: [otherUser.id],
      employeeIds: [employee.id],
    });

    const employeeDm = await call("send_workspace_message", {
      dmEmployee: otherEmployee.id,
      content: "Hidden AI-to-AI DM",
    });
    assert.equal(employeeDm.status, 403);
    const unknownEmployeeDm = await call("send_workspace_message", {
      dmEmployee: "unknown-private-peer",
      content: "Do not disclose whether this target exists",
    });
    assert.equal(unknownEmployeeDm.status, 403);
    const otherMemberDm = await call("send_workspace_message", {
      dmUser: otherUser.id,
      content: "Hidden third-party DM",
    });
    assert.equal(otherMemberDm.status, 403);
    const unknownMemberDm = await call("send_workspace_message", {
      dmUser: "00000000-0000-4000-8000-000000000000",
      content: "Do not disclose whether this target exists",
    });
    assert.equal(unknownMemberDm.status, 403);
    const hiddenDmById = await call("send_workspace_message", {
      channel: hiddenDm.id,
      content: "Do not disclose the private channel kind",
    });
    assert.equal(hiddenDmById.status, 404);
    assert.equal(await AppDataSource.getRepository(ChannelMessage).count(), 0);

    const requesterDm = await call("send_workspace_message", {
      dmUser: requester.id,
      content: "Private reply to the requester",
    });
    assert.equal(requesterDm.status, 200, requesterDm.body.error);
    const dmChannel = requesterDm.body.channel as { id: string; kind: string };
    assert.equal(dmChannel.kind, "dm");
    const participants = await AppDataSource.getRepository(ChannelMember).find({
      where: { channelId: dmChannel.id },
    });
    assert.deepEqual(
      participants
        .map((row) => (row.userId ? `user:${row.userId}` : `ai:${row.employeeId}`))
        .sort(),
      [`ai:${employee.id}`, `user:${requester.id}`].sort(),
    );
  });

  test("keeps cross-company channels hidden and preserves employee-authority behaviour", async () => {
    const otherCompany = await insert(Company, {
      name: "Other Co",
      slug: "other-co",
      ownerId: "other-owner",
    });
    const foreign = await createWorkspaceChannel({
      companyId: otherCompany.id,
      name: "foreign-public",
      kind: "public",
    });
    for (const [tool, body] of [
      ["rename_workspace_channel", { channel: foreign.id, name: "stolen" }],
      ["archive_workspace_channel", { channel: foreign.id }],
      ["send_workspace_message", { channel: foreign.id, content: "cross-company" }],
    ] as const) {
      const denied = await call(tool, body);
      assert.equal(denied.status, 404, tool);
    }

    const privateChannel = await createWorkspaceChannel({
      name: "automation-private",
      kind: "private",
    });
    useEmployeeAuthority();
    const renamed = await call("rename_workspace_channel", {
      channel: privateChannel.id,
      topic: "Routine-compatible update",
    });
    assert.equal(renamed.status, 200, renamed.body.error);
    const created = await call("create_workspace_channel", {
      name: "automation-created",
      kind: "private",
    });
    assert.equal(created.status, 200, created.body.error);
    const createdId = (created.body.channel as { id: string }).id;
    const stored = await AppDataSource.getRepository(Channel).findOneByOrFail({ id: createdId });
    assert.equal(stored.createdByUserId, company.ownerId);
    const automationParticipants = await AppDataSource.getRepository(ChannelMember).find({
      where: { channelId: createdId },
    });
    assert.deepEqual(
      automationParticipants
        .map((row) => (row.userId ? `user:${row.userId}` : `ai:${row.employeeId}`))
        .sort(),
      [`ai:${employee.id}`, `user:${company.ownerId}`].sort(),
    );
  });
});

describe("browser approval MCP callbacks", () => {
  test("concurrent resume callbacks issue one claim and one durable completion receipt", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const approval = await approvedBrowserAction();

    const checked = await internalRequest(`check_browser_approval/${approval.id}`, {
      method: "GET",
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.status, "approved");
    assert.equal(checked.body.executed, false);

    const claims = await Promise.all(
      Array.from({ length: 16 }, () => internalRequest(`claim_browser_approval/${approval.id}`)),
    );
    assert.equal(claims.filter((response) => response.status === 200).length, 1);
    assert.equal(claims.filter((response) => response.status === 409).length, 15);
    const winner = claims.find((response) => response.status === 200);
    assert.ok(winner);
    assert.equal(winner.body.status, "executing");
    assert.equal(winner.body.selector, "aria-ref=e12");
    assert.equal(typeof winner.body.claimToken, "string");

    const wrongReceipt = await internalRequest(`finish_browser_approval/${approval.id}`, {
      body: { claimToken: "x".repeat(43), outcome: "executed" },
    });
    assert.equal(wrongReceipt.status, 409);

    const completed = await internalRequest(`finish_browser_approval/${approval.id}`, {
      body: { claimToken: winner.body.claimToken, outcome: "executed" },
    });
    assert.equal(completed.status, 200, completed.body.error);
    assert.equal(completed.body.status, "approved");
    assert.equal(completed.body.alreadyCompleted, false);

    const repeated = await internalRequest(`finish_browser_approval/${approval.id}`, {
      body: { claimToken: winner.body.claimToken, outcome: "executed" },
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyCompleted, true);

    const replay = await internalRequest(`claim_browser_approval/${approval.id}`);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.executed, true);
    const finalCheck = await internalRequest(`check_browser_approval/${approval.id}`, {
      method: "GET",
    });
    assert.equal(finalCheck.body.status, "approved");
    assert.equal(finalCheck.body.executed, true);
  });

  test("a reported browser failure is terminal and cannot be claimed again", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const approval = await approvedBrowserAction();
    const claim = await internalRequest(`claim_browser_approval/${approval.id}`);
    assert.equal(claim.status, 200);

    const failed = await internalRequest(`finish_browser_approval/${approval.id}`, {
      body: {
        claimToken: claim.body.claimToken,
        outcome: "failed",
        errorMessage: "Browser RPC timed out after dispatch",
      },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "execution_failed");

    const replay = await internalRequest(`claim_browser_approval/${approval.id}`);
    assert.equal(replay.status, 409);
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "execution_failed");
    assert.equal(stored.errorMessage, "Browser RPC timed out after dispatch");
  });

  test("a lost child after claim leaves a non-replayable ambiguous state", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const approval = await approvedBrowserAction();
    const claim = await internalRequest(`claim_browser_approval/${approval.id}`);
    assert.equal(claim.status, 200);

    // No finish callback: this is the exact state left by a process crash.
    const laterResume = await internalRequest(`claim_browser_approval/${approval.id}`);
    assert.equal(laterResume.status, 409);
    assert.equal(laterResume.body.status, "executing");
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "executing");
    assert.match(stored.resultJson ?? "", /"state":"claimed"/);
  });
});

async function todoCount(): Promise<number> {
  return AppDataSource.getRepository(Todo).count();
}
