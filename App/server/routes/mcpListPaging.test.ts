import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeCalendarGrant } from "../db/entities/EmployeeCalendarGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { Handoff } from "../db/entities/Handoff.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Meeting } from "../db/entities/Meeting.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { errorHandler } from "../middleware/error.js";
import { CURSOR_OTHER_FILTERS } from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The everyday lists beyond Finance page the same way: a mailbox search, the
 * handoff inbox, a Project's Todos and the Meetings section. Each used to stop
 * at a fixed count (50 threads, 200 handoffs, 200 meetings) or return
 * everything in one answer a tool result could not hold (a project's Todos).
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let colleague: AIEmployee;

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

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operator",
    soulBody: "",
  });
  colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Kim",
    slug: "kim",
    role: "Operator",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function callTool(name: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & {
      error?: string;
      total?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
      note?: string;
    },
  };
}

async function readEveryPage(tool: string, rowsKey: string, args: Record<string, unknown>) {
  const ids: string[] = [];
  const pages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await callTool(tool, { ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(
      ...(page.body[rowsKey] as Array<{ id?: string; threadId?: string }>).map(
        (row) => row.id ?? row.threadId ?? "",
      ),
    );
    if (!page.body.hasMore) return { ids, pages };
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

describe("search_mail", () => {
  test("reaches every matching thread past 50, threads sharing a timestamp included", async () => {
    const account = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "ops@example.com",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    // 130 threads, five to a timestamp: the old `lastMessageAt <` cursor would
    // skip the rest of a timestamp's threads at every page boundary.
    for (let i = 0; i < 130; i++) {
      await insert(MailThread, {
        companyId: company.id,
        accountId: account.id,
        gmailThreadId: `thread-${i}`,
        subject: i % 2 ? `Invoice ${i}` : `Hello ${i}`,
        snippet: "",
        labelIds: " INBOX ",
        lastMessageAt: new Date(Date.UTC(2024, 0, 1) + Math.floor(i / 5) * 60_000),
      });
    }
    const all = await readEveryPage("search_mail", "threads", { limit: 50 });
    assert.equal(all.ids.length, 130);
    assert.equal(new Set(all.ids).size, 130);
    assert.ok(all.pages.every((page) => !("total" in page)), "a mailbox search is not counted");
    assert.match(String(all.pages[0].note), /more match/);

    const first = await callTool("search_mail", { query: "invoice", limit: 10 });
    const otherQuery = await callTool("search_mail", { query: "hello", cursor: first.body.nextCursor });
    assert.equal(otherQuery.status, 400);
    assert.equal(otherQuery.body.error, CURSOR_OTHER_FILTERS);
    const sixth = await callTool("search_mail", { limit: 500 });
    assert.equal((sixth.body.threads as unknown[]).length, 50, "a larger limit is cut to 50");
  });
});

describe("list_handoffs", () => {
  test("defaults to pending, as it always said, and pages through the rest", async () => {
    for (let i = 0; i < 260; i++) {
      await insert(Handoff, {
        companyId: company.id,
        fromEmployeeId: colleague.id,
        toEmployeeId: employee.id,
        title: `Handoff ${i}`,
        body: "",
        // Newer completed ones used to bury an older pending one.
        status: i < 10 ? "pending" : "completed",
      });
    }
    const pending = await callTool("list_handoffs");
    assert.equal(pending.status, 200, pending.body.error);
    assert.equal(pending.body.total, 10);
    assert.ok(
      (pending.body.handoffs as Array<{ status: string }>).every((row) => row.status === "pending"),
      "only pending by default",
    );
    const everything = await readEveryPage("list_handoffs", "handoffs", { status: "all", limit: 100 });
    assert.equal(everything.ids.length, 260, "past the old cap of 200");
    assert.equal(new Set(everything.ids).size, 260);
    const outgoing = await callTool("list_handoffs", { direction: "outgoing", status: "all" });
    assert.equal(outgoing.body.total, 0);
  });
});

describe("list_todos", () => {
  test("pages a project of hundreds, filters open work, and redacts what get_todo redacts", async () => {
    const project = await insert(Project, {
      companyId: company.id,
      name: "Launch",
      slug: "launch",
      description: "",
      key: "LA",
      createdById: null,
      todoCounter: 1,
      accessMode: "restricted",
    });
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "ai",
      userId: null,
      employeeId: employee.id,
      accessLevel: "read",
    });
    for (let i = 0; i < 230; i++) {
      await insert(Todo, {
        projectId: project.id,
        number: i + 1,
        title: `Todo ${i}`,
        description:
          i === 0 ? "Log in with password: hunter2-very-secret then rotate it." : "x".repeat(1_000),
        status: i % 3 === 0 ? "done" : "todo",
        priority: "none",
        // Many share a sort key: the board's order still pages exactly.
        sortOrder: i % 4,
        assigneeEmployeeId: i % 5 === 0 ? employee.id : null,
      });
    }
    const all = await readEveryPage("list_todos", "todos", { projectSlug: "launch", limit: 200 });
    assert.equal(all.ids.length, 230);
    assert.equal(new Set(all.ids).size, 230);
    const firstRows = all.pages[0].todos as Array<{ description: string; descriptionTruncated: boolean }>;
    assert.ok(firstRows.every((row) => row.description.length <= 300), "descriptions are previews");
    assert.equal(JSON.stringify(all.pages).includes("hunter2-very-secret"), false, "redacted like get_todo");
    const open = await callTool("list_todos", { projectSlug: "launch", status: "open" });
    assert.equal(open.body.total, 230 - 77);
    const mine = await callTool("list_todos", { projectSlug: "launch", assignedToMe: true });
    assert.equal(mine.body.total, 46);
  });
});

describe("list_meetings", () => {
  test("pages past 200 within the employee's calendars, says how many are hidden, and honours from with to", async () => {
    const granted = await insert(CalendarAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      calendarId: "primary",
      address: "sales@example.test",
      displayName: "Sales",
      status: "active",
    });
    const other = await insert(CalendarAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      calendarId: "primary",
      address: "board@example.test",
      displayName: "Board",
      status: "active",
    });
    await insert(EmployeeCalendarGrant, { employeeId: employee.id, accountId: granted.id, accessLevel: "read" });
    const meeting = (accountId: string | null, at: Date | null, title: string) =>
      insert(Meeting, {
        companyId: company.id,
        accountId,
        title,
        scheduledStartAt: at,
        conferenceProvider: "meet",
        conferenceUrl: "https://meet.google.com/abc-defg-hij",
        status: "ready",
      });
    for (let i = 0; i < 220; i++) {
      await meeting(granted.id, new Date(Date.UTC(2024, 0, 1 + Math.floor(i / 2))), `Sales ${i}`);
    }
    for (let i = 0; i < 7; i++) await meeting(other.id, new Date(Date.UTC(2024, 0, 1 + i)), `Board ${i}`);
    await meeting(null, null, "Ad-hoc call");

    const all = await readEveryPage("list_meetings", "meetings", { limit: 200 });
    assert.equal(all.ids.length, 221, "every Sales meeting and the ad-hoc one");
    assert.equal(new Set(all.ids).size, 221);
    assert.match(String(all.pages[0].note), /7 more matching meetings are on calendars you have no Grant to/);
    const window = await callTool("list_meetings", { from: "2024-01-01", to: "2024-01-10" });
    assert.equal(window.body.total, 20, "both bounds apply in the query");
  });
});
