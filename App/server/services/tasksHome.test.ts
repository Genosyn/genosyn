import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { TASKS_HOME_SECTION_LIMIT } from "../../shared/tasksHome.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { readTasksHome } from "./tasksHome.js";

/**
 * Tasks home answers what's happening without opening a Project. The bar is that each
 * section holds the right Todos, the counts stay truthful, and a Project someone can't
 * open isn't mentioned or counted anywhere on it.
 */

let company: Company;
let ruth: User;
let sam: User;
let ada: AIEmployee;
let open: Project;
let closed: Project;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  ruth = await insert(User, { email: "ruth@home.test", name: "Ruth", passwordHash: "x" });
  sam = await insert(User, { email: "sam@home.test", name: "Sam", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: ruth.id });
  await insert(Membership, { companyId: company.id, userId: ruth.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: sam.id, role: "member" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  open = await insert(Project, {
    companyId: company.id,
    name: "Ops",
    slug: "ops",
    key: "OPS",
    todoCounter: 0,
  });
  closed = await insert(Project, {
    companyId: company.id,
    name: "Secret",
    slug: "secret",
    key: "SEC",
    todoCounter: 0,
    accessMode: "restricted",
  });
});

let next = 1;
function todo(changes: Partial<Todo> = {}): Promise<Todo> {
  return insert(Todo, {
    projectId: open.id,
    number: next++,
    title: "A todo",
    status: "todo",
    priority: "none",
    ...changes,
  });
}

const read = (user: User, now?: Date) =>
  readTasksHome({
    companyId: company.id,
    actor: { kind: "user", id: user.id, role: user.id === ruth.id ? "owner" : "member" },
    userId: user.id,
    now,
  });

describe("Tasks home", () => {
  test("says what needs you: your reviews, and what's waiting on a person", async () => {
    const review = await todo({ status: "in_review", reviewerUserId: sam.id, title: "Review me" });
    const asking = await todo({
      status: "in_progress",
      waitingOn: "member",
      waitingReason: "Which account?\nLong story.",
      waitingSince: new Date(),
    });
    const approval = await todo({ status: "in_progress", waitingOn: "browser_approval" });
    await todo({ status: "in_review", reviewerUserId: ruth.id, title: "Ruth's, not Sam's" });

    const home = await read(sam);
    assert.equal(home.needsYou.count, 3);
    const byId = new Map(home.needsYou.items.map((item) => [item.todoId, item]));
    assert.equal(byId.get(review.id)?.detail, "Needs your review");
    assert.equal(byId.get(asking.id)?.detail, "Which account?");
    assert.equal(byId.get(approval.id)?.detail, "Waiting on browser approval");
    assert.equal(byId.get(review.id)?.ref.startsWith("OPS-"), true);
    assert.equal(byId.get(review.id)?.projectSlug, "ops");
  });

  test("says what AI is doing now, and how many are queued", async () => {
    const working = await todo({ status: "in_progress", assigneeEmployeeId: ada.id });
    const pickup = (todoId: string, status: "running" | "queued", notBeforeAt: Date | null = null) =>
      insert(TodoPickup, {
        companyId: company.id,
        todoId,
        employeeId: ada.id,
        trigger: "assigned",
        status,
        authority: "employee",
        acceptedAt: new Date(),
        notBeforeAt,
      });
    await pickup(working.id, "running");
    await pickup((await todo({ assigneeEmployeeId: ada.id })).id, "queued");
    // A check-back waiting for its time isn't queued: that's the wait.
    await pickup(
      (await todo({ assigneeEmployeeId: ada.id })).id,
      "queued",
      new Date(Date.now() + 86_400_000),
    );

    const home = await read(sam);
    assert.equal(home.working.count, 1);
    assert.equal(home.working.queuedCount, 1);
    assert.equal(home.working.items[0].todoId, working.id);
    assert.equal(home.working.items[0].detail, "Ada is working on this");
    assert.deepEqual(home.working.items[0].assignee, { kind: "ai", name: "Ada" });
  });

  test("says what's waiting on someone else, and when it checks back", async () => {
    const checkAt = new Date(Date.now() + 86_400_000);
    const waiting = await todo({
      status: "in_progress",
      waitingOn: "customer",
      waitingReason: "Asked which order.",
      waitingCheckAt: checkAt,
    });
    const home = await read(sam);
    assert.equal(home.waiting.count, 1);
    assert.equal(home.waiting.items[0].todoId, waiting.id);
    assert.equal(home.waiting.items[0].detail, "Asked which order.");
    assert.equal(home.waiting.items[0].checkAt, checkAt.toISOString());
    assert.equal(home.needsYou.count, 0);
  });

  test("says what finished, with the first line of its report", async () => {
    const finished = await todo({ status: "done", completedAt: new Date() });
    await insert(TodoComment, {
      todoId: finished.id,
      authorEmployeeId: ada.id,
      pickupId: "a-pickup",
      body: "\nAccepted the agreement.\nThe receipt is in Files.",
      pending: false,
      createdAt: new Date(),
    });
    await insert(TodoComment, {
      todoId: finished.id,
      authorUserId: sam.id,
      body: "A person's comment isn't the report.",
      pending: false,
      createdAt: new Date(Date.now() + 1000),
    });
    await todo({ status: "done", completedAt: new Date(Date.now() - 3 * 86_400_000) });

    const home = await read(sam);
    assert.equal(home.doneToday.count, 1);
    assert.equal(home.doneToday.items[0].detail, "Accepted the agreement.");
  });

  test("a Project you can't open isn't mentioned or counted", async () => {
    const secret = await todo({
      projectId: closed.id,
      status: "in_progress",
      waitingOn: "member",
      title: "Acquisition talks",
      assigneeEmployeeId: ada.id,
    });
    await todo({
      projectId: closed.id,
      status: "in_progress",
      waitingOn: "customer",
      title: "Acquisition follow-up",
    });
    await todo({ projectId: closed.id, status: "done", completedAt: new Date(), title: "Signed" });
    await insert(TodoPickup, {
      companyId: company.id,
      todoId: secret.id,
      employeeId: ada.id,
      trigger: "assigned",
      status: "running",
      authority: "employee",
      acceptedAt: new Date(),
    });

    const forSam = await read(sam);
    for (const section of [forSam.needsYou, forSam.working, forSam.waiting, forSam.doneToday]) {
      assert.equal(section.count, 0);
    }
    assert.equal(forSam.working.queuedCount, 0);
    assert.doesNotMatch(JSON.stringify(forSam), /Acquisition|Signed|SEC-/);

    const forRuth = await read(ruth);
    assert.equal(forRuth.working.count, 1);
    assert.equal(forRuth.needsYou.count, 1);
    assert.equal(forRuth.waiting.count, 1);
    assert.equal(forRuth.doneToday.count, 1);
  });

  test("shows so many, and the count stays truthful past them", async () => {
    for (let index = 0; index < TASKS_HOME_SECTION_LIMIT + 3; index += 1) {
      await todo({ status: "in_progress", waitingOn: "member" });
    }
    const home = await read(sam);
    assert.equal(home.needsYou.items.length, TASKS_HOME_SECTION_LIMIT);
    assert.equal(home.needsYou.count, TASKS_HOME_SECTION_LIMIT + 3);
  });

  test("a company with nothing going on is simply quiet", async () => {
    const home = await read(sam);
    assert.deepEqual(home.needsYou, { count: 0, items: [] });
    assert.deepEqual(home.working, { count: 0, queuedCount: 0, items: [] });
  });
});
