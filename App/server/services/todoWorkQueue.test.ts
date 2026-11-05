import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { getCommitmentOpportunities } from "./proactive/commitments.js";
import { employeeTodoQueue, pageMyTodos } from "./todoWorkQueue.js";
import type { ProjectActor } from "./projects.js";

/**
 * What an AI Employee has on its plate. It has to agree with what the heartbeat will
 * do, and a Todo in a Project the reader can't open must not show up, even as a count.
 */

let company: Company;
let member: User;
let ada: AIEmployee;
let ben: AIEmployee;
let open: Project;
let locked: Project;
let viewer: ProjectActor;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@queue.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  member = await insert(User, {
    email: "member@queue.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  viewer = { kind: "user", id: member.id, role: "member" };
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  ben = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ben",
    slug: "ben",
    role: "Support",
    soulBody: "",
  });
  open = await insert(Project, {
    companyId: company.id,
    name: "Ops",
    slug: "ops",
    key: "OPS",
    todoCounter: 0,
  });
  locked = await insert(Project, {
    companyId: company.id,
    name: "Payroll",
    slug: "payroll",
    key: "PAY",
    todoCounter: 0,
    accessMode: "restricted",
  });
  await insert(ProjectMember, {
    projectId: locked.id,
    memberKind: "ai",
    employeeId: ada.id,
    accessLevel: "write",
  });
});

let next = 1;
const todo = (changes: Partial<Todo> = {}) =>
  insert(Todo, {
    projectId: open.id,
    number: next++,
    title: "A task",
    status: "todo",
    priority: "none",
    assigneeEmployeeId: ada.id,
    ...changes,
  });

const pickup = (row: Todo, changes: Partial<TodoPickup> = {}) =>
  insert(TodoPickup, {
    companyId: company.id,
    todoId: row.id,
    employeeId: ada.id,
    trigger: "assigned",
    status: "queued",
    authority: "employee",
    acceptedAt: new Date(Date.now() - 60_000),
    notBeforeAt: new Date(Date.now() - 60_000),
    ...changes,
  });

const titles = (items: Array<{ title: string }>) => items.map((item) => item.title);

describe("a Member reading an AI Employee's queue", () => {
  test("running, queued in the order they'll start, and why it hasn't", async () => {
    await pickup(await todo({ title: "Doing now", status: "in_progress" }), { status: "running" });
    await pickup(await todo({ title: "Low", priority: "low" }), { hold: "employee_busy" });
    await pickup(await todo({ title: "Urgent", priority: "urgent" }), { hold: "standdown" });
    await pickup(await todo({ title: "Medium", priority: "medium" }));

    const queue = await employeeTodoQueue(company.id, ada.id, viewer);
    assert.deepEqual(titles(queue.running), ["Doing now"]);
    assert.deepEqual(titles(queue.queued), ["Urgent", "Medium", "Low"]);
    assert.equal(queue.queuedCount, 3);
    assert.equal(queue.queued[0].pickup?.hold, "standdown");
    assert.equal(queue.queued[0].pickup?.position, 1);
    assert.equal(queue.queued[2].pickup?.position, 3);
    assert.equal(queue.queued[0].ref.startsWith("OPS-"), true);
  });

  test("waiting says on what, and counts as queued once its check-back is due", async () => {
    const asleep = await todo({
      title: "Asleep",
      status: "in_progress",
      waitingOn: "customer",
      waitingReason: "Asked which order it was.",
      waitingSince: new Date(),
      waitingCheckAt: new Date(Date.now() + 86_400_000),
    });
    await pickup(asleep, {
      trigger: "wait_over",
      notBeforeAt: new Date(Date.now() + 86_400_000),
    });
    const due = await todo({
      title: "Due",
      status: "in_progress",
      waitingOn: "customer",
      waitingSince: new Date(),
    });
    await pickup(due, { trigger: "wait_over" });

    const queue = await employeeTodoQueue(company.id, ada.id, viewer);
    assert.deepEqual(titles(queue.waiting), ["Asleep"]);
    assert.equal(queue.waitingCount, 1);
    assert.equal(queue.waiting[0].waiting?.on, "customer");
    assert.match(queue.waiting[0].waiting?.reason ?? "", /which order/);
    assert.deepEqual(titles(queue.queued), ["Due"]);
  });

  test("a failed try waiting to retry is still on the queue", async () => {
    await pickup(await todo({ title: "Retrying" }), {
      hold: "retrying",
      notBeforeAt: new Date(Date.now() + 300_000),
    });
    assert.deepEqual(titles((await employeeTodoQueue(company.id, ada.id, viewer)).queued), [
      "Retrying",
    ]);
  });

  test("a Project they can't open isn't listed or counted", async () => {
    await pickup(await todo({ title: "Payroll run", projectId: locked.id }));
    await todo({
      title: "Payroll wait",
      projectId: locked.id,
      status: "in_progress",
      waitingOn: "member",
      waitingSince: new Date(),
    });
    const queue = await employeeTodoQueue(company.id, ada.id, viewer);
    assert.deepEqual(queue.queued, []);
    assert.equal(queue.queuedCount, 0);
    assert.deepEqual(queue.waiting, []);
    assert.equal(queue.waitingCount, 0);

    const asOwner = await employeeTodoQueue(company.id, ada.id, {
      kind: "ai",
      id: ada.id,
    });
    assert.equal(asOwner.queuedCount, 1, "the employee itself can open it");
  });

  test("a place in line counts only what the reader can see", async () => {
    await pickup(await todo({ title: "Locked first", priority: "urgent", projectId: locked.id }));
    await pickup(await todo({ title: "Open second", priority: "low" }));
    const asMember = await employeeTodoQueue(company.id, ada.id, viewer);
    assert.deepEqual(titles(asMember.queued), ["Open second"]);
    assert.equal(asMember.queued[0].pickup?.position, 1, "no gap to say something's hidden");
    const asEmployee = await employeeTodoQueue(company.id, ada.id, { kind: "ai", id: ada.id });
    assert.equal(asEmployee.queued[1].pickup?.position, 2);
  });

  test("somebody else's queue isn't mixed in", async () => {
    await pickup(await todo({ title: "Ben's", assigneeEmployeeId: ben.id }), {
      employeeId: ben.id,
    });
    assert.equal((await employeeTodoQueue(company.id, ada.id, viewer)).queuedCount, 0);
    assert.equal((await employeeTodoQueue(company.id, ben.id, viewer)).queuedCount, 1);
  });
});

describe("an AI Employee reading its own list", () => {
  const self = (): ProjectActor[] => [{ kind: "ai", id: ada.id }];

  test("open work assigned to it, or up for its review, across Projects, page by page", async () => {
    await todo({ title: "First" });
    await todo({ title: "Locked but mine", projectId: locked.id });
    await todo({
      title: "To review",
      assigneeEmployeeId: ben.id,
      reviewerEmployeeId: ada.id,
      status: "in_review",
    });
    await todo({ title: "Finished", status: "done" });
    await todo({ title: "Ben's", assigneeEmployeeId: ben.id });

    const first = await pageMyTodos(company.id, ada.id, self(), { limit: 2 });
    assert.equal(first.total, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.rows.length, 2);
    const second = await pageMyTodos(company.id, ada.id, self(), {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    assert.equal(second.hasMore, false);
    const all = [...first.rows, ...second.rows];
    assert.deepEqual(titles(all).sort(), ["First", "Locked but mine", "To review"]);
    assert.equal(all.find((row) => row.title === "To review")?.role, "reviewer");
    assert.equal(all.find((row) => row.title === "First")?.role, "assignee");
  });

  test("only what it and a delegating Member can both open", async () => {
    await todo({ title: "Open" });
    await todo({ title: "Locked", projectId: locked.id });
    const delegated = await pageMyTodos(
      company.id,
      ada.id,
      [{ kind: "ai", id: ada.id }, viewer],
      {},
    );
    assert.deepEqual(titles(delegated.rows), ["Open"]);
  });

  test("says what's queued and what's waiting", async () => {
    await pickup(await todo({ title: "Queued" }));
    await todo({
      title: "Waiting",
      status: "in_progress",
      waitingOn: "decision",
      waitingSince: new Date(),
    });
    const { rows } = await pageMyTodos(company.id, ada.id, self(), {});
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    assert.equal(byTitle.get("Queued")?.pickup?.status, "queued");
    assert.equal(byTitle.get("Queued")?.pickup?.position, 1);
    assert.equal(byTitle.get("Waiting")?.waiting?.on, "decision");
    assert.equal(byTitle.get("Waiting")?.pickup, null);
  });

  test("marks text nobody at the company wrote", async () => {
    await todo({ title: "From an email", untrustedText: true });
    const { rows } = await pageMyTodos(company.id, ada.id, self(), {});
    assert.equal(rows[0].untrustedText, true);
  });
});

describe("the daily starter's commitments", () => {
  const commitmentTitles = async () => {
    const sections = await getCommitmentOpportunities(company.id, ada.id);
    return Object.values(sections).flatMap((section) => section.items.map((item) => item.title));
  };

  test("leave out what the queue already owns, so it isn't started twice", async () => {
    await todo({ title: "Nobody on it" });
    await pickup(await todo({ title: "Queued" }));
    await pickup(await todo({ title: "Running", status: "in_progress" }), { status: "running" });
    await todo({
      title: "Waiting",
      status: "in_progress",
      waitingOn: "customer",
      waitingSince: new Date(),
    });
    const finished = await todo({ title: "Picked up before" });
    await pickup(finished, { status: "done" });

    const titles = await commitmentTitles();
    assert.ok(titles.some((title) => title.includes("Nobody on it")));
    assert.ok(titles.some((title) => title.includes("Picked up before")), "that session ended");
    for (const owned of ["Queued", "Running", "Waiting"]) {
      assert.ok(!titles.some((title) => title.includes(owned)), owned);
    }
  });
});
