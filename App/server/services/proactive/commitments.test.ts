import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Decision } from "../../db/entities/Decision.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { Goal } from "../../db/entities/Goal.js";
import { Handoff } from "../../db/entities/Handoff.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { Project } from "../../db/entities/Project.js";
import { ProjectMember } from "../../db/entities/ProjectMember.js";
import { Repository } from "../../db/entities/Repository.js";
import { RepositoryWorkSession } from "../../db/entities/RepositoryWorkSession.js";
import { Todo } from "../../db/entities/Todo.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { getCommitmentOpportunities } from "./commitments.js";

const now = new Date("2026-09-08T12:00:00.000Z");
const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
let companyId: string;
let employee: AIEmployee;
let project: Project;
let number: number;
before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Maya",
    role: "Operations",
    slug: "maya",
  });
  project = await insert(Project, {
    companyId,
    name: "Operations",
    slug: "operations",
    key: "OPS",
  });
  number = 0;
});
const opportunities = () => getCommitmentOpportunities(companyId, employee.id, now);
const addTodo = (patch: Partial<Todo> = {}) =>
  insert(Todo, {
    projectId: project.id,
    number: ++number,
    title: `Todo ${number}`,
    assigneeEmployeeId: employee.id,
    description: "PRIVATE TODO BODY",
    updatedAt: at(-1),
    ...patch,
  });
const addHandoff = (patch: Partial<Handoff> = {}) =>
  insert(Handoff, {
    companyId,
    fromEmployeeId: randomUUID(),
    toEmployeeId: employee.id,
    title: "Delegated commitment",
    body: "PRIVATE HANDOFF BODY",
    updatedAt: at(-1),
    ...patch,
  });
const addDecision = (patch: Partial<Decision> = {}) =>
  insert(Decision, {
    companyId,
    employeeId: employee.id,
    title: "Which next step?",
    body: "PRIVATE DECISION BODY",
    optionsJson: "[]",
    status: "decided",
    pickupStatus: "skipped",
    decidedAt: at(-1),
    createdAt: at(-2),
    ...patch,
  });

test("empty commitments are explicit and stale or cross-company employees fail closed", async () => {
  const result = await opportunities();
  assert.deepEqual(Object.keys(result), [
    "todos",
    "handoffs",
    "decisions",
    "goals",
    "meetings",
    "repositoryWorkSessions",
  ]);
  for (const section of Object.values(result))
    assert.deepEqual(section, { items: [], truncated: false });
  await assert.rejects(getCommitmentOpportunities(randomUUID(), employee.id, now), /not found/);
  await assert.rejects(getCommitmentOpportunities(companyId, "invalid", now), /not found/);
  await assert.rejects(
    getCommitmentOpportunities(companyId, employee.id, new Date("invalid")),
    /Invalid opportunity time/,
  );
});

test("Repository work recovery is owned, currently granted, bounded and limited to actionable recent states", async () => {
  const repository = await insert(Repository, {
    companyId,
    name: "Handbook",
    slug: "handbook",
    gitUrl: "",
    origin: "local",
  });
  const grant = await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "read",
  });
  const addSession = (patch: Partial<RepositoryWorkSession> = {}) =>
    insert(RepositoryWorkSession, {
      companyId,
      employeeId: employee.id,
      repositoryId: repository.id,
      title: "Improve handbook",
      instruction: "PRIVATE WORK INSTRUCTION",
      reply: "PRIVATE WORK RESULT",
      status: "ready",
      updatedAt: at(-1),
      ...patch,
    });
  const visible: RepositoryWorkSession[] = [];
  for (const status of ["ready", "empty", "proposed", "published", "failed"] as const)
    visible.push(await addSession({ status }));
  for (const status of ["running", "discarded"] as const) await addSession({ status });
  await addSession({ employeeId: randomUUID() });
  await addSession({ companyId: randomUUID() });
  await addSession({ updatedAt: at(-8) });
  await addSession({ updatedAt: at(1) });
  const foreign = await insert(Repository, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    gitUrl: "",
    origin: "local",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: foreign.id,
    accessLevel: "write",
  });
  await addSession({ repositoryId: foreign.id });
  const ungranted = await insert(Repository, {
    companyId,
    name: "Hidden",
    slug: "hidden",
    gitUrl: "",
    origin: "local",
  });
  for (let i = 0; i < 8; i++) await addSession({ repositoryId: ungranted.id, updatedAt: now });
  const result = await opportunities();
  assert.deepEqual(
    new Set(result.repositoryWorkSessions.items.map((row) => row.id)),
    new Set(visible.map((session) => session.id)),
  );
  assert.equal(result.repositoryWorkSessions.truncated, false);
  const ready = result.repositoryWorkSessions.items.find((row) => row.id === visible[0].id)!;
  assert.match(ready.reason, /publication still requires the Soul, current Grants/);
  assert.deepEqual(ready.tools, ["get_repository_work_session"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await addSession();
  assert.equal((await opportunities()).repositoryWorkSessions.truncated, true);
  await AppDataSource.getRepository(EmployeeRepositoryGrant).delete(grant.id);
  assert.deepEqual((await opportunities()).repositoryWorkSessions, { items: [], truncated: false });
});

test("Todo cues include own work and reviews while enforcing live Project access before limits", async () => {
  const hidden = await insert(Project, {
    companyId,
    name: "Restricted",
    slug: "restricted",
    key: "SEC",
    accessMode: "restricted",
  });
  for (let i = 0; i < 8; i++) await addTodo({ projectId: hidden.id, priority: "urgent" });
  const own = await addTodo({ priority: "high", dueAt: at(-1) });
  const review = await addTodo({
    assigneeEmployeeId: randomUUID(),
    reviewerEmployeeId: employee.id,
    status: "in_review",
  });
  await addTodo({ assigneeEmployeeId: randomUUID() });
  await addTodo({ status: "done" });
  await addTodo({ status: "in_review", reviewerEmployeeId: randomUUID() });
  const foreignProject = await insert(Project, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    key: "EXT",
  });
  await addTodo({ projectId: foreignProject.id, priority: "urgent" });
  const result = await opportunities();
  assert.deepEqual(
    result.todos.items.map((row) => row.id),
    [own.id, review.id],
  );
  assert.equal(result.todos.truncated, false);
  assert.equal(result.todos.items[0].locator, project.slug);
  assert.match(result.todos.items[1].reason, /for review/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(
    (await AppDataSource.getRepository(Todo).findOneByOrFail({ id: own.id })).status,
    "todo",
  );

  const grant = await insert(ProjectMember, {
    projectId: hidden.id,
    memberKind: "ai",
    employeeId: employee.id,
    accessLevel: "read",
  });
  const granted = await opportunities();
  assert.equal(granted.todos.items.length, 5);
  assert.equal(granted.todos.truncated, true);
  assert.ok(granted.todos.items.every((row) => row.locator === hidden.slug));
  await AppDataSource.getRepository(ProjectMember).delete(grant.id);
  assert.deepEqual(
    (await opportunities()).todos.items.map((row) => row.id),
    [own.id, review.id],
  );
});

test("Handoffs surface pending incoming and recent outgoing resolutions without unrelated history", async () => {
  const incoming = await addHandoff({ dueAt: at(-1) });
  const completed = await addHandoff({
    fromEmployeeId: employee.id,
    toEmployeeId: randomUUID(),
    status: "completed",
  });
  const declined = await addHandoff({
    fromEmployeeId: employee.id,
    toEmployeeId: randomUUID(),
    status: "declined",
  });
  await addHandoff({ fromEmployeeId: employee.id, toEmployeeId: randomUUID(), status: "pending" });
  await addHandoff({
    fromEmployeeId: employee.id,
    toEmployeeId: randomUUID(),
    status: "completed",
    updatedAt: at(-8),
  });
  await addHandoff({ toEmployeeId: randomUUID() });
  await addHandoff({ companyId: randomUUID() });
  const result = await opportunities();
  assert.equal(result.handoffs.items[0].id, incoming.id);
  assert.deepEqual(
    new Set(result.handoffs.items.map((row) => row.id)),
    new Set([incoming.id, completed.id, declined.id]),
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("Decisions recover skipped answers and routed questions but never duplicate a running or completed pickup", async () => {
  const skipped = await addDecision();
  const failed = await addDecision({ pickupStatus: "failed" });
  const routed = await addDecision({
    employeeId: randomUUID(),
    routedToEmployeeId: employee.id,
    status: "pending",
    decidedAt: null,
    expiresAt: at(1),
  });
  await addDecision({ pickupStatus: "running" });
  await addDecision({ pickupStatus: "done" });
  await addDecision({ decidedAt: at(-8) });
  await addDecision({ employeeId: randomUUID() });
  await addDecision({ companyId: randomUUID() });
  await addDecision({
    employeeId: randomUUID(),
    routedToEmployeeId: employee.id,
    status: "pending",
    expiresAt: at(-1),
  });
  const result = await opportunities();
  assert.deepEqual(
    new Set(result.decisions.items.map((row) => row.id)),
    new Set([skipped.id, failed.id, routed.id]),
  );
  assert.match(result.decisions.items.find((row) => row.id === routed.id)!.reason, /routed to you/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("Goals use explicit ownership and measurement/deadline signals without updating metrics", async () => {
  const addGoal = (patch: Partial<Goal> = {}) =>
    insert(Goal, {
      companyId,
      title: "Customer response",
      slug: randomUUID(),
      ownerEmployeeId: employee.id,
      targetValue: 100,
      updatedAt: at(-1),
      ...patch,
    });
  const missing = await addGoal();
  const stale = await addGoal({ currentValue: 20, currentValueUpdatedAt: at(-8) });
  const deadline = await addGoal({
    metricKind: "chart",
    chartId: randomUUID(),
    dueAt: at(2),
    currentValue: 50,
  });
  await addGoal({ currentValueUpdatedAt: at(-1) });
  await addGoal({ ownerEmployeeId: randomUUID() });
  await addGoal({ companyId: randomUUID() });
  await addGoal({ status: "achieved" });
  await addGoal({ metricKind: "chart", chartId: randomUUID(), dueAt: at(8) });
  const result = await opportunities();
  assert.deepEqual(
    new Set(result.goals.items.map((row) => row.id)),
    new Set([missing.id, stale.id, deadline.id]),
  );
  assert.equal(result.goals.items[0].id, deadline.id);
  assert.equal(
    (await AppDataSource.getRepository(Goal).findOneByOrFail({ id: stale.id })).currentValue,
    20,
  );
});

test("Meeting cues respect notetaker ownership, current calendar Grants and useful time windows", async () => {
  const calendar = await insert(CalendarAccount, {
    companyId,
    connectionId: randomUUID(),
    calendarId: "primary",
    address: "ops@example.test",
  });
  const grant = await insert(EmployeeCalendarGrant, {
    employeeId: employee.id,
    accountId: calendar.id,
    accessLevel: "read",
  });
  const addMeeting = (patch: Partial<Meeting> = {}) =>
    insert(Meeting, {
      companyId,
      accountId: calendar.id,
      notetakerEmployeeId: employee.id,
      title: "Customer meeting",
      status: "ready",
      updatedAt: at(-1),
      transcriptText: "PRIVATE TRANSCRIPT",
      actionItemsJson: "PRIVATE ACTIONS",
      ...patch,
    });
  const ready = await addMeeting();
  const upcoming = await addMeeting({ status: "scheduled", scheduledStartAt: at(0.5) });
  const manual = await addMeeting({ accountId: null });
  await addMeeting({ notetakerEmployeeId: randomUUID() });
  await addMeeting({ updatedAt: at(-8) });
  await addMeeting({ status: "scheduled", scheduledStartAt: at(2) });
  await addMeeting({ status: "failed" });
  await addMeeting({ companyId: randomUUID() });
  const foreignCalendar = await insert(CalendarAccount, {
    companyId: randomUUID(),
    connectionId: randomUUID(),
    calendarId: "primary",
    address: "other@example.test",
  });
  await insert(EmployeeCalendarGrant, {
    employeeId: employee.id,
    accountId: foreignCalendar.id,
    accessLevel: "read",
  });
  await addMeeting({ accountId: foreignCalendar.id });
  const result = await opportunities();
  assert.deepEqual(
    new Set(result.meetings.items.map((row) => row.id)),
    new Set([ready.id, upcoming.id, manual.id]),
  );
  assert.equal(result.meetings.items[0].id, upcoming.id);
  assert.match(
    result.meetings.items.find((row) => row.id === ready.id)!.reason,
    /existing action items/,
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await AppDataSource.getRepository(EmployeeCalendarGrant).delete(grant.id);
  assert.deepEqual(
    (await opportunities()).meetings.items.map((row) => row.id),
    [manual.id],
  );
});
