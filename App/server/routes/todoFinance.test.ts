import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Bill } from "../db/entities/Bill.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeSupportGrant } from "../db/entities/EmployeeSupportGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { SupportInbox } from "../db/entities/SupportInbox.js";
import { SupportTicket } from "../db/entities/SupportTicket.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoLink } from "../db/entities/TodoLink.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { addTodoLink, presentTodoLinks } from "../services/todoLinks.js";
import { setTodoPickupAutoStartForTests, settleTodoPickupsForTests } from "../services/todoPickups.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";
import { projectsRouter } from "./projects.js";

/**
 * Tasks and Finance, joined. The natural sequence is the bar: file a Todo, create the
 * estimate, mark it done, and the two know about each other with no argument naming the
 * link. A link grants nothing, so reading one takes the access its record takes.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
const tokens: string[] = [];

let company: Company;
let finance: User;
let plain: User;
let ada: AIEmployee;
let customer: Customer;
let project: Project;

before(async () => {
  await initTestDb();
  setTodoPickupAutoStartForTests(false);
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/internal/mcp", mcpInternalRouter);
  app.use("/api/companies/:cid", projectsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setTodoPickupAutoStartForTests(true);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  finance = await insert(User, {
    email: "finance@example.com",
    passwordHash: "x",
    name: "Finance",
    sessionVersion: 0,
  });
  plain = await insert(User, {
    email: "plain@example.com",
    passwordHash: "x",
    name: "Plain",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: finance.id });
  await insert(Membership, {
    companyId: company.id,
    userId: finance.id,
    role: "member",
    financeAccess: "full",
  });
  await insert(Membership, {
    companyId: company.id,
    userId: plain.id,
    role: "member",
    financeAccess: "none",
  });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Finance partner",
    soulBody: "",
  });
  await insertEmployeeModel({
    employeeId: ada.id,
    provider: "anthropic",
    model: "claude-test",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: ada.id,
    accessLevel: "full",
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Globex",
    slug: "globex",
    email: "billing@globex.example",
    currency: "USD",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Sales",
    slug: "sales",
    key: "SAL",
    todoCounter: 0,
  });
});

afterEach(async () => {
  await settleTodoPickupsForTests();
  while (tokens.length) revokeMcpToken(tokens.pop()!);
});

function tokenFor(origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" }): string {
  const token = issueMcpToken(ada.id, company.id, origin);
  tokens.push(token);
  return token;
}

async function tool<T = Record<string, unknown>>(token: string, name: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
}

async function as<T = Record<string, unknown>>(
  user: User,
  method: string,
  route: string,
  body?: unknown,
) {
  actingUserId = user.id;
  const res = await fetch(`${baseUrl}/api/companies/${company.id}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T & { error?: string } };
}

const links = () => AppDataSource.getRepository(TodoLink);
const lines = [{ description: "Consulting", quantity: 1, unitPriceCents: 10_000 }];
const quote = (token: string) =>
  tool<{ estimate: { id: string; slug: string } }>(token, "create_estimate", {
    customerSlug: customer.slug,
    lines,
  });

let next = 1;
function todoFor(changes: Partial<Todo> = {}): Promise<Todo> {
  return insert(Todo, {
    projectId: project.id,
    number: next++,
    title: "Quote Globex",
    status: "todo",
    priority: "none",
    assigneeEmployeeId: ada.id,
    ...changes,
  });
}

describe("what a turn creates while working a Todo", () => {
  test("file a Todo, create the estimate, mark it done: it links by itself", async () => {
    const token = tokenFor();
    const filed = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: project.slug,
      title: "Quote Globex",
    });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    const made = await quote(token);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const done = await tool(token, "update_todo", { todoId: filed.body.todo.id, status: "done" });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const [link] = await links().findBy({ todoId: filed.body.todo.id, kind: "estimate" });
    assert.equal(link.targetId, made.body.estimate.id);
    const row = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: filed.body.todo.id });
    assert.equal(row.status, "done");

    const listed = await as<{ todos: Array<{ id: string }> }>(
      finance,
      "GET",
      `/todo-links?kind=estimate&targetId=${link.targetId}`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.todos[0].id, filed.body.todo.id);
  });

  test("a Pickup's turn is working its Todo", async () => {
    const todo = await todoFor({ status: "in_progress" });
    const pickup = await insert(TodoPickup, {
      companyId: company.id,
      todoId: todo.id,
      employeeId: ada.id,
      trigger: "assigned",
      status: "running",
      authority: "employee",
      acceptedAt: new Date(),
    });
    const made = await quote(tokenFor({ authority: "employee", todoPickupId: pickup.id }));
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(await links().countBy({ todoId: todo.id, targetId: made.body.estimate.id }), 1);
  });

  test("so is a turn that moved one of its own to in progress", async () => {
    const todo = await todoFor();
    const token = tokenFor();
    assert.equal(
      (await tool(token, "update_todo", { todoId: todo.id, status: "in_progress" })).status,
      200,
    );
    const made = await quote(token);
    assert.equal(await links().countBy({ todoId: todo.id, targetId: made.body.estimate.id }), 1);
  });

  test("moving someone else's Todo doesn't make it this turn's", async () => {
    const todo = await todoFor({ assigneeEmployeeId: null });
    const token = tokenFor();
    await tool(token, "update_todo", { todoId: todo.id, status: "in_progress" });
    const made = await quote(token);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(await links().count(), 0);
  });

  test("a turn that has filed nothing links nothing", async () => {
    const made = await quote(tokenFor());
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(await links().count(), 0);
  });

  test("the turn's Todo stays with that turn", async () => {
    const token = tokenFor();
    await tool(token, "create_todo", { projectSlug: project.slug, title: "Quote Globex" });
    const made = await quote(tokenFor());
    assert.equal(await links().countBy({ targetId: made.body.estimate.id }), 0);
  });

  test("an invoice, a bill and a customer link the same way", async () => {
    const token = tokenFor();
    const filed = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: project.slug,
      title: "Close out Globex",
    });
    const invoice = await tool<{ invoice: { id: string } }>(token, "create_invoice", {
      customerSlug: customer.slug,
      lines,
    });
    assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
    const vendor = await tool<{ vendor: { slug: string } }>(token, "create_vendor", {
      name: "Figma",
      currency: "USD",
    });
    assert.equal(vendor.status, 200, JSON.stringify(vendor.body));
    const bill = await tool<{ bill: { slug: string } }>(token, "create_bill", {
      vendorSlug: vendor.body.vendor.slug,
      vendorRef: "FIG-1",
      lines: [{ description: "Seats", quantity: 1, unitPriceCents: 1_500 }],
    });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    const made = await tool<{ customer: { id: string } }>(token, "create_customer", {
      name: "Initech",
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const kinds = (await links().findBy({ todoId: filed.body.todo.id })).map((link) => link.kind);
    assert.deepEqual(kinds.sort(), ["bill", "customer", "invoice"]);
  });

  test("a session held to preparing still can't create an estimate", async () => {
    const answer = await quote(
      tokenFor({ authority: "employee", proactiveReview: true, mailDeliveryMode: "review" }),
    );
    assert.equal(answer.status, 403);
    assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
  });
});

describe("a ticket", () => {
  async function ticket(): Promise<SupportTicket> {
    const account = await insert(MailAccount, {
      companyId: company.id,
      provider: "gmail",
      address: "help@acme.test",
      status: "active",
      connectionId: "a-connection",
    });
    const inbox = await insert(SupportInbox, {
      companyId: company.id,
      accountId: account.id,
      name: "Help",
      watchFrom: new Date(),
    });
    return insert(SupportTicket, {
      companyId: company.id,
      number: 12,
      inboxId: inbox.id,
      accountId: account.id,
      subject: "Sign in trouble",
      requesterEmail: "sam@customer.test",
      requesterName: "Sam",
      lastActivityAt: new Date(),
      status: "open",
    });
  }

  test("links when the Todo's turn works it", async () => {
    await insert(EmployeeSupportGrant, {
      companyId: company.id,
      employeeId: ada.id,
      accessLevel: "reply",
    });
    const row = await ticket();
    const token = tokenFor();
    const filed = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: project.slug,
      title: "Help Sam",
    });
    const updated = await tool(token, "update_support_ticket", {
      ticketId: row.id,
      status: "waiting",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(await links().countBy({ todoId: filed.body.todo.id, targetId: row.id }), 1);
  });

  test("reads by Support's own rule, and opens at its page", async () => {
    const row = await ticket();
    const todo = await todoFor();
    await addTodoLink({ companyId: company.id, todoId: todo.id, kind: "ticket", targetId: row.id });
    const asMember = await presentTodoLinks(company.id, [todo.id], {
      kind: "member",
      role: "member",
      financeAccess: "none",
    });
    assert.equal(asMember.get(todo.id)?.[0].label, "#12 Sign in trouble");
    assert.equal(asMember.get(todo.id)?.[0].path, `/support/tickets/${row.id}`);

    const asAda = () =>
      presentTodoLinks(company.id, [todo.id], { kind: "employee", employeeId: ada.id });
    assert.equal((await asAda()).get(todo.id)?.[0].canRead, false);
    await insert(EmployeeSupportGrant, {
      companyId: company.id,
      employeeId: ada.id,
      accessLevel: "read",
    });
    assert.equal((await asAda()).get(todo.id)?.[0].canRead, true);
  });
});

describe("reading a Finance link", () => {
  const records = async () => {
    const dates = { issueDate: new Date(), currency: "USD" };
    const estimate = await insert(Estimate, {
      companyId: company.id,
      customerId: customer.id,
      slug: "est-1",
      number: "EST-0001",
      validUntil: new Date(),
      ...dates,
    });
    const invoice = await insert(Invoice, {
      companyId: company.id,
      customerId: customer.id,
      slug: "inv-1",
      number: "INV-0001",
      dueDate: new Date(),
      ...dates,
    });
    return { estimate, invoice };
  };

  test("takes Finance access, and without it shows only that one exists", async () => {
    const { estimate, invoice } = await records();
    const todo = await todoFor();
    await addTodoLink({
      companyId: company.id,
      todoId: todo.id,
      kind: "estimate",
      targetId: estimate.id,
    });
    await addTodoLink({
      companyId: company.id,
      todoId: todo.id,
      kind: "invoice",
      targetId: invoice.id,
    });
    const present = (financeAccess: "none" | "full") =>
      presentTodoLinks(company.id, [todo.id], { kind: "member", role: "member", financeAccess });

    const withAccess = (await present("full")).get(todo.id) ?? [];
    const quoted = withAccess.find((link) => link.kind === "estimate");
    assert.equal(quoted?.label, "EST-0001");
    assert.equal(quoted?.path, "/finance/estimates/est-1");
    assert.equal(
      withAccess.find((link) => link.kind === "invoice")?.path,
      "/finance/invoices/inv-1",
    );

    const without = (await present("none")).get(todo.id) ?? [];
    assert.equal(without.length, 2);
    for (const link of without) {
      assert.equal(link.canRead, false);
      assert.equal(link.label, null);
      assert.equal(link.path, null);
    }
  });

  test("an AI Employee needs a Finance Grant, and a delegating Member's access", async () => {
    const { estimate } = await records();
    const todo = await todoFor();
    await addTodoLink({
      companyId: company.id,
      todoId: todo.id,
      kind: "estimate",
      targetId: estimate.id,
    });
    const reader = (financeAccessLimit?: "none") =>
      presentTodoLinks(company.id, [todo.id], {
        kind: "employee",
        employeeId: ada.id,
        financeAccessLimit,
      });
    assert.equal((await reader()).get(todo.id)?.[0].canRead, true);
    assert.equal((await reader("none")).get(todo.id)?.[0].canRead, false);
    await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: ada.id });
    assert.equal((await reader()).get(todo.id)?.[0].canRead, false);
  });

  test("a Member without Finance access can't list or link them", async () => {
    const { estimate } = await records();
    const todo = await todoFor();
    assert.equal(
      (await as(plain, "GET", `/todo-links?kind=estimate&targetId=${estimate.id}`)).status,
      403,
    );
    assert.equal(
      (
        await as(plain, "POST", `/todos/${todo.id}/links`, {
          kind: "estimate",
          targetId: estimate.id,
        })
      ).status,
      403,
    );
  });

  test("History doesn't name what a reader can't open", async () => {
    const { estimate } = await records();
    const todo = await todoFor();
    await as(finance, "POST", `/todos/${todo.id}/links`, {
      kind: "estimate",
      targetId: estimate.id,
    });
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "todo.link",
      targetId: todo.id,
    });
    assert.doesNotMatch(audit.metadataJson, /EST-0001/);
  });

  test("a form opened from a Todo links what it saved", async () => {
    const { estimate } = await records();
    const todo = await todoFor();
    const linked = await as(finance, "POST", `/todos/${todo.id}/links`, {
      kind: "estimate",
      targetId: estimate.id,
    });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(await links().countBy({ todoId: todo.id, targetId: estimate.id }), 1);
  });

  test("a record in another company can't be linked", async () => {
    const elsewhere = await insert(Bill, {
      companyId: "another-company",
      vendorId: "a-vendor",
      slug: "bill-1",
      number: "BILL-0001",
      currency: "USD",
      issueDate: new Date(),
      dueDate: new Date(),
    });
    const todo = await todoFor();
    const refused = await as(finance, "POST", `/todos/${todo.id}/links`, {
      kind: "bill",
      targetId: elsewhere.id,
    });
    assert.equal(refused.status, 404);
  });
});
