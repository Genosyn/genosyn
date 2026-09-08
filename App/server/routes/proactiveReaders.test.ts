import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { memberToolPolicy } from "../services/memberToolAuthority.js";
import type { getTodoForEmployee } from "../services/proactive/todoReader.js";
import type { serializeEmployeeDecision } from "../services/proactive/decisionInbox.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type TodoReply = Awaited<ReturnType<typeof getTodoForEmployee>>;
type DecisionsReply = { decisions: ReturnType<typeof serializeEmployeeDecision>[] };
let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let member: User;
let project: Project;
let todo: Todo;
let token: string;
const tokens: string[] = [];
before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  for (const value of tokens.splice(0)) revokeMcpToken(value);
  await resetTestDb();
  member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Company", slug: randomUUID(), ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    slug: "maya",
    role: "Operations",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Operations",
    slug: "operations",
    key: "OPS",
  });
  todo = await insert(Todo, {
    projectId: project.id,
    number: 1,
    title: "Prepare report",
    description: "Include the actual baseline.",
    assigneeEmployeeId: employee.id,
    status: "in_progress",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  tokens.push(token);
});
after(async () => {
  for (const value of tokens) revokeMcpToken(value);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});
async function tool<T = Record<string, unknown>>(name: string, args: unknown = {}, auth = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as T };
}
const comment = (body: string, index: number, patch: Partial<TodoComment> = {}) =>
  insert(TodoComment, {
    todoId: todo.id,
    body,
    authorUserId: member.id,
    createdAt: new Date(1_700_000_000_000 + index * 1000),
    ...patch,
  });

test("get_todo is a granular Project reader and returns actual status with newest discussion and pagination", async () => {
  assert.equal(STATIC_TOOLS.find((entry) => entry.name === "get_todo")?.readOnly, true);
  assert.equal(memberToolPolicy("get_todo"), "project");
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(await comment(`Evidence ${i}`, i));
  await insert(Attachment, {
    companyId: company.id,
    messageId: rows[3].id,
    filename: "report.pdf",
    storageKey: "private-path.pdf",
  });
  const reply = await tool<TodoReply>("get_todo", { todoId: todo.id });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.todo.status, "in_progress");
  assert.equal(reply.body.todo.assigneeEmployeeId, employee.id);
  assert.equal(reply.body.todo.description.text, todo.description);
  assert.deepEqual(
    reply.body.comments.items.map((row) => row.id),
    [rows[3].id, rows[2].id, rows[1].id],
  );
  assert.equal(reply.body.comments.items[0].attachmentCount, 1);
  assert.equal(reply.body.comments.nextOffset, 3);
  assert.doesNotMatch(JSON.stringify(reply.body), /private-path/);
  const older = await tool<TodoReply>("get_todo", { todoId: todo.id, commentsOffset: 3 });
  assert.deepEqual(
    older.body.comments.items.map((row) => row.id),
    [rows[0].id],
  );
  assert.equal(older.body.comments.nextOffset, null);
  assert.equal(
    (await AppDataSource.getRepository(Todo).findOneByOrFail({ id: todo.id })).status,
    "in_progress",
  );
});

test("Todo text is transport-bounded, visibly windowed, and pending work is not mistaken for a result", async () => {
  const long = '\\"\n\t🧭'.repeat(2000);
  await AppDataSource.getRepository(Todo).update(todo.id, {
    description: long,
    title: long.slice(0, 200),
    status: "in_review",
    reviewerEmployeeId: employee.id,
  });
  const older = await comment(long, 1);
  await comment(long, 2);
  const pending = await comment("PRIVATE INCOMPLETE RESULT", 3, {
    pending: true,
    authorUserId: null,
    authorEmployeeId: employee.id,
  });
  const reply = await tool<TodoReply>("get_todo", { todoId: todo.id });
  assert.equal(reply.status, 200);
  assert.ok(JSON.stringify(reply.body, null, 2).length <= 7500);
  assert.equal(reply.body.todo.titleTruncated, true);
  assert.ok(reply.body.todo.description.nextOffset);
  assert.equal(reply.body.comments.items[0].id, pending.id);
  assert.equal(reply.body.comments.items[0].pending, true);
  assert.equal(reply.body.comments.items[0].body, null);
  assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE INCOMPLETE/);
  const next = reply.body.comments.items.find((row) => row.id === older.id)!.body!.nextOffset!;
  const continued = await tool<TodoReply>("get_todo", {
    todoId: todo.id,
    descriptionOffset: reply.body.todo.description.nextOffset,
    commentId: older.id,
    commentBodyOffset: next,
  });
  assert.equal(continued.body.comments.items.length, 1);
  assert.equal(continued.body.comments.items[0].body!.offset, next);
  assert.equal(
    continued.body.comments.items[0].body!.text,
    long.slice(next, next + continued.body.comments.items[0].body!.text.length),
  );
  assert.ok(JSON.stringify(continued.body, null, 2).length <= 7500);
});

test("Todo reads intersect live employee and delegated Member Project access and reject foreign comments", async () => {
  await AppDataSource.getRepository(Project).update(project.id, { accessMode: "restricted" });
  assert.equal((await tool("get_todo", { todoId: todo.id })).status, 403);
  const employeeGrant = await insert(ProjectMember, {
    projectId: project.id,
    memberKind: "ai",
    employeeId: employee.id,
    accessLevel: "read",
  });
  assert.equal((await tool("get_todo", { todoId: todo.id })).status, 200);
  const delegated = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: member.id,
    requesterSessionVersion: 0,
  });
  tokens.push(delegated);
  assert.equal((await tool("get_todo", { todoId: todo.id }, delegated)).status, 403);
  await insert(ProjectMember, {
    projectId: project.id,
    memberKind: "user",
    userId: member.id,
    accessLevel: "read",
  });
  assert.equal((await tool("get_todo", { todoId: todo.id }, delegated)).status, 200);
  const otherProject = await insert(Project, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    key: "EXT",
  });
  const otherTodo = await insert(Todo, {
    projectId: otherProject.id,
    number: 1,
    title: "PRIVATE OTHER TODO",
  });
  const otherComment = await insert(TodoComment, {
    todoId: otherTodo.id,
    body: "PRIVATE OTHER COMMENT",
  });
  assert.equal((await tool("get_todo", { todoId: otherTodo.id })).status, 404);
  assert.equal(
    (await tool("get_todo", { todoId: todo.id, commentId: otherComment.id })).status,
    404,
  );
  assert.equal((await tool("get_todo", { todoId: "invalid" })).status, 400);
  assert.equal((await tool("get_todo", { todoId: todo.id, commentBodyOffset: -1 })).status, 400);
  await AppDataSource.getRepository(ProjectMember).delete(employeeGrant.id);
  assert.equal((await tool("get_todo", { todoId: todo.id }, delegated)).status, 403);
});

test("Decision directions preserve raised default, add only current assignments, and never duplicate both", async () => {
  const addDecision = (patch: Partial<Decision> = {}) =>
    insert(Decision, {
      companyId: company.id,
      employeeId: employee.id,
      title: "Choose the next step",
      body: "Inspect the customer requirements.",
      optionsJson: JSON.stringify([
        { id: "proceed", label: "Proceed", detail: "Use the existing scope", tone: "neutral" },
      ]),
      ...patch,
    });
  const raised = await addDecision();
  const both = await addDecision({ routedToEmployeeId: employee.id });
  const assigned = await addDecision({
    employeeId: randomUUID(),
    routedToEmployeeId: employee.id,
    body: "Long exact context. ".repeat(100),
  });
  await addDecision({
    employeeId: randomUUID(),
    routedToEmployeeId: employee.id,
    status: "decided",
  });
  await addDecision({ employeeId: randomUUID(), routedToEmployeeId: randomUUID() });
  await addDecision({ companyId: randomUUID(), routedToEmployeeId: employee.id });
  await addDecision({
    employeeId: randomUUID(),
    routedToEmployeeId: employee.id,
    expiresAt: new Date(Date.now() - 1000),
  });
  const own = await tool<DecisionsReply>("list_decisions");
  assert.deepEqual(new Set(own.body.decisions.map((row) => row.id)), new Set([raised.id, both.id]));
  const inbox = await tool<DecisionsReply>("list_decisions", { direction: "assigned" });
  assert.equal(inbox.status, 200);
  assert.deepEqual(
    new Set(inbox.body.decisions.map((row) => row.id)),
    new Set([both.id, assigned.id]),
  );
  const context = inbox.body.decisions.find((row) => row.id === assigned.id)!;
  assert.equal(context.contextTruncated, true);
  assert.ok(context.contextExcerpt.length <= 500);
  assert.equal(context.options[0].detailExcerpt, "Use the existing scope");
  const combined = await tool<DecisionsReply>("list_decisions", { direction: "both" });
  assert.deepEqual(
    new Set(combined.body.decisions.map((row) => row.id)),
    new Set([raised.id, both.id, assigned.id]),
  );
  assert.equal(combined.body.decisions.length, 3);
  assert.deepEqual(
    (await tool<DecisionsReply>("list_decisions", { direction: "assigned", status: "decided" }))
      .body.decisions,
    [],
  );
  assert.equal((await tool("list_decisions", { direction: "all" })).status, 400);
  await AppDataSource.getRepository(Decision).update(assigned.id, { routedToEmployeeId: null });
  assert.deepEqual(
    (await tool<DecisionsReply>("list_decisions", { direction: "assigned" })).body.decisions.map(
      (row) => row.id,
    ),
    [both.id],
  );
});
