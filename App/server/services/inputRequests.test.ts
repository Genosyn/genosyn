import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  INPUT_REQUEST_ANSWER_WINDOW_MS,
  INPUT_REQUEST_EXPIRY_MS,
  INPUT_REQUEST_READY_WAIT_MS,
  MAX_CODES_PER_INPUT_REQUEST,
  MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE,
  inputRequestRemindersBy,
} from "../../shared/inputRequests.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { InputRequest } from "../db/entities/InputRequest.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import {
  answerInputRequest,
  awaitPersonAtPage,
  canAnswerInputRequest,
  declineInputRequest,
  inputRequestBriefForRun,
  listOpenInputRequests,
  openAnswerInputRequest,
  openPageInputRequest,
  readyInputRequest,
  settleInputRequestPingsForTests,
  sweepInputRequests,
} from "./inputRequests.js";
import { stopRoutineQueue } from "./routineQueue.js";
import { queuedRunsInStartOrder } from "./routineQueueOrder.js";
import { placeStanddown, stopStanddowns } from "./standdowns.js";

/**
 * People are not there when work needs them, and one-time codes die within seconds.
 * These hold what follows from that: a code is only ever taken while a page is really
 * waiting, nobody coming costs nothing and loses nothing, and however long someone
 * takes the work signs in again and asks them for a code that can still work.
 */

before(async () => {
  await initTestDb();
  // What these hold is which Runs the queue would offer, not starting them.
  stopRoutineQueue();
});
beforeEach(async () => {
  stopStanddowns();
  await settleInputRequestPingsForTests();
  await resetTestDb();
});
after(async () => {
  stopStanddowns();
  await settleInputRequestPingsForTests();
  await closeTestDb();
});

const HOUR_MS = 60 * 60 * 1000;
const FREEAGENT = "https://login.freeagent.test/two-factor?session=abc";

async function fixture() {
  const owner = await insert(User, {
    email: "owner@acme.test",
    passwordHash: "x",
    name: "Ola Owner",
  });
  const member = await insert(User, {
    email: "valeria@acme.test",
    passwordHash: "x",
    name: "Valeria",
  });
  const bystander = await insert(User, {
    email: "bystander@acme.test",
    passwordHash: "x",
    name: "Bo Bystander",
  });
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: company.id, userId: bystander.id, role: "member" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Mira",
    slug: "mira",
    role: "Finance",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "File VAT",
    slug: "file-vat",
    cronExpr: "0 9 1 * *",
    timeoutSec: 3600,
    body: "File the VAT return on FreeAgent.",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    triggerKind: "schedule",
    continuationDeadlineAt: new Date(Date.now() + HOUR_MS),
  });
  const ownerActor = { userId: owner.id, role: "owner" as const };
  const memberActor = { userId: member.id, role: "member" as const };
  const bystanderActor = { userId: bystander.id, role: "member" as const };
  const askInRun = (values: Partial<Parameters<typeof openPageInputRequest>[0]> = {}) =>
    openPageInputRequest({
      companyId: company.id,
      employeeId: employee.id,
      kind: "code",
      title: "FreeAgent sign-in code",
      body: "I'm filing the VAT return and FreeAgent wants the code from your phone.",
      named: member.email,
      work: { runId: run.id, routineId: routine.id, browserSessionId: "session-1" },
      pageUrl: FREEAGENT,
      ...values,
    });
  return {
    owner,
    member,
    bystander,
    company,
    employee,
    routine,
    run,
    ownerActor,
    memberActor,
    bystanderActor,
    askInRun,
  };
}

const requests = () => AppDataSource.getRepository(InputRequest);
const runs = () => AppDataSource.getRepository(Run);

async function pauseAsRunnerDoes(runId: string, requestId: string): Promise<void> {
  await runs().update(
    { id: runId },
    {
      status: "queued",
      pauseReason: "person",
      pauseCount: 1,
      personPauses: 1,
      pausedAt: new Date(),
      pauseRemainingMs: 1_800_000,
      waitingOnInputRequestId: requestId,
    },
  );
}

async function expireWindow(id: string): Promise<void> {
  await requests().update({ id }, { askingUntil: new Date(Date.now() - 1_000) });
}

/** Everything in the database that could hold a value, as one string. */
async function everythingStored(id: string): Promise<string> {
  const [row, audit, bells, emails] = await Promise.all([
    requests().findOneByOrFail({ id }),
    AppDataSource.getRepository(AuditEvent).find(),
    AppDataSource.getRepository(Notification).find(),
    AppDataSource.getRepository(EmailLog).find(),
  ]);
  return JSON.stringify({ row, audit, bells, emails });
}

describe("while the page is waiting", () => {
  test("a code typed for one address doesn't go to another", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await assert.rejects(
      answerInputRequest({
        companyId: f.company.id,
        id: asked.id,
        actor: f.memberActor,
        value: "481516",
        pageOrigin: "https://login.another.test",
      }),
      /The page has moved to https:\/\/login\.freeagent\.test/,
    );
    assert.equal((await requests().findOneByOrFail({ id: asked.id })).encryptedAnswer, null);
    await answerInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      value: "481516",
      pageOrigin: "https://login.freeagent.test",
    });
    assert.ok((await requests().findOneByOrFail({ id: asked.id })).encryptedAnswer);
  });

  test("a person's code reaches the session once, and is never stored in the clear", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    assert.equal(asked.status, "asking");
    assert.equal(asked.pageOrigin, "https://login.freeagent.test");
    assert.ok(asked.askingUntil!.getTime() <= Date.now() + INPUT_REQUEST_ANSWER_WINDOW_MS);
    assert.equal(asked.assigneeUserId, f.member.id);

    await answerInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      value: " 481 516 ",
    });
    const stored = await requests().findOneByOrFail({ id: asked.id });
    assert.ok(stored.encryptedAnswer, "it waits encrypted for the session");
    assert.ok(!(await everythingStored(asked.id)).includes("481 516"));

    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "code");
    assert.equal(answer.outcome === "code" && answer.code, "481 516");

    const after = await requests().findOneByOrFail({ id: asked.id });
    assert.equal(after.status, "submitted");
    assert.equal(after.encryptedAnswer, null, "taken means gone");
    assert.equal(after.codesGiven, 1);
    assert.ok(!(await everythingStored(asked.id)).includes("481 516"));
  });

  test("a second answer can't overwrite a code already on its way", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    const answer = (value: string) =>
      answerInputRequest({ companyId: f.company.id, id: asked.id, actor: f.memberActor, value });
    await answer("111111");
    await assert.rejects(answer("222222"), /already on its way/);
    const taken = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(taken.outcome === "code" && taken.code, "111111");
  });

  test("the first ask pings at once, and sends no email nobody could act on in time", async () => {
    const f = await fixture();
    await f.askInRun();
    await settleInputRequestPingsForTests();
    const bells = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(
      bells.map((bell) => [bell.userId, bell.kind]),
      [[f.member.id, "input_request"]],
    );
    assert.match(bells[0].title, /Mira needs a code from you/);
    assert.match(bells[0].body, /login\.freeagent\.test/, "the real site, read from the browser");
    assert.match(bells[0].link ?? "", /\/c\/acme\/decisions#input-/);
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  });

  test("an action is finished by a person pressing done", async () => {
    const f = await fixture();
    const asked = await f.askInRun({ kind: "action", title: "Approve the sign-in on your phone" });
    await answerInputRequest({ companyId: f.company.id, id: asked.id, actor: f.memberActor });
    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "done");
  });

  test("I can't reaches the session holding the page", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await declineInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      note: "That phone is at home",
    });
    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "declined");
    assert.equal(
      answer.outcome === "declined" && answer.request.answerText,
      "That phone is at home",
    );
  });

  test("a session that goes away stops holding, and the code it never took is gone", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    const gone = new AbortController();
    gone.abort();
    const answer = await awaitPersonAtPage({
      requestId: asked.id,
      companyId: f.company.id,
      signal: gone.signal,
    });
    assert.equal(answer.outcome, "aborted");
    assert.equal((await requests().findOneByOrFail({ id: asked.id })).status, "waiting");
  });

  test("a Run too close to its limit doesn't hold the page at all", async () => {
    const f = await fixture();
    await runs().update(
      { id: f.run.id },
      { continuationDeadlineAt: new Date(Date.now() + 75_000) },
    );
    const asked = await f.askInRun();
    assert.equal(asked.status, "waiting", "it waits for them instead");
    assert.equal(asked.askingUntil, null);
    assert.ok(asked.nextReminderAt);
    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "lapsed", "so the Run pauses, rather than being told it ended");
  });
});

describe("nobody came", () => {
  test("the Run waits for them, with nothing to do and nothing to spend", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await expireWindow(asked.id);
    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "lapsed");
    const row = await requests().findOneByOrFail({ id: asked.id });
    assert.equal(row.status, "waiting");
    assert.equal(row.askingUntil, null);
    const inAnHour = row.nextReminderAt!.getTime() - Date.now();
    assert.ok(inAnHour > 0.9 * HOUR_MS && inAnHour <= HOUR_MS, "the first reminder is an hour off");

    await pauseAsRunnerDoes(f.run.id, asked.id);
    assert.deepEqual(await queuedRunsInStartOrder(), [], "the queue passes over it");

    await settleInputRequestPingsForTests();
    const emails = await AppDataSource.getRepository(EmailLog).find();
    assert.equal(emails.length, 1, "now it is worth an email");
    assert.match(emails[0].bodyPreview, /press I'm ready/);
    assert.match(emails[0].bodyPreview, /never asks for a code by email/);
  });

  test("a code typed now is refused: it could only ever be a dead one", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await expireWindow(asked.id);
    await assert.rejects(
      answerInputRequest({
        companyId: f.company.id,
        id: asked.id,
        actor: f.memberActor,
        value: "123456",
      }),
      /isn't waiting/,
    );
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    await assert.rejects(
      answerInputRequest({
        companyId: f.company.id,
        id: asked.id,
        actor: f.memberActor,
        value: "123456",
      }),
      /isn't waiting/,
    );
    assert.equal((await requests().findOneByOrFail({ id: asked.id })).encryptedAnswer, null);
  });

  test("a turn nothing can resume ends the request instead of stranding it", async () => {
    const f = await fixture();
    const asked = await openPageInputRequest({
      companyId: f.company.id,
      employeeId: f.employee.id,
      kind: "code",
      title: "A code",
      work: { conversationId: "conversation-1", browserSessionId: "session-2" },
      requesterUserId: f.member.id,
      pageUrl: FREEAGENT,
    });
    assert.equal(asked.assigneeUserId, f.member.id, "the person in the chat");
    await expireWindow(asked.id);
    const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    assert.equal(answer.outcome, "lapsed");
    assert.equal(answer.outcome === "lapsed" && answer.request.status, "closed");
  });
});

describe("twelve hours later", () => {
  async function waitingRun() {
    const f = await fixture();
    const asked = await f.askInRun();
    await expireWindow(asked.id);
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    await pauseAsRunnerDoes(f.run.id, asked.id);
    await settleInputRequestPingsForTests();
    return { ...f, asked };
  }

  test("I'm ready lets the same Run go, and takes no code", async () => {
    const f = await waitingRun();
    const ready = await readyInputRequest({
      companyId: f.company.id,
      id: f.asked.id,
      actor: f.memberActor,
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.readyByUserId, f.member.id);
    assert.equal(ready.nextReminderAt, null, "no more reminders while it comes back");

    const run = await runs().findOneByOrFail({ id: f.run.id });
    assert.equal(run.waitingOnInputRequestId, null);
    assert.equal(run.status, "queued");
    assert.deepEqual(
      (await queuedRunsInStartOrder()).map((queued) => queued.id),
      [f.run.id],
      "and the queue starts it, first",
    );
  });

  test("the resumed Run is told to sign in again and ask on the new prompt", async () => {
    const f = await waitingRun();
    await readyInputRequest({ companyId: f.company.id, id: f.asked.id, actor: f.memberActor });
    const brief = await inputRequestBriefForRun(f.run.id);
    assert.match(brief, /Valeria has just said they're ready/);
    assert.match(brief, /sign in again from the start/);
    assert.match(brief, /https:\/\/login\.freeagent\.test/);
    assert.match(brief, /browser_ask_person/);
    assert.match(brief, /would be dead/);
  });

  test("asking again finds the same request, and now they get a box and a push", async () => {
    const f = await waitingRun();
    await readyInputRequest({ companyId: f.company.id, id: f.asked.id, actor: f.memberActor });
    await AppDataSource.getRepository(Notification).clear();
    const again = await f.askInRun({
      work: { runId: f.run.id, routineId: f.routine.id, browserSessionId: "session-after-resume" },
    });
    assert.equal(again.id, f.asked.id, "one person, one request");
    assert.equal(again.status, "asking");
    assert.equal(again.attempts, 2);
    assert.equal(again.browserSessionId, "session-after-resume");
    await settleInputRequestPingsForTests();
    const [bell] = await AppDataSource.getRepository(Notification).find();
    assert.match(bell.title, /login\.freeagent\.test is asking now/);

    await answerInputRequest({
      companyId: f.company.id,
      id: again.id,
      actor: f.memberActor,
      value: "654321",
    });
    const taken = await awaitPersonAtPage({ requestId: again.id, companyId: f.company.id });
    assert.equal(taken.outcome === "code" && taken.code, "654321");
  });

  test("gone again goes back to waiting, as many times as it takes", async () => {
    const f = await waitingRun();
    for (let i = 0; i < 3; i += 1) {
      await readyInputRequest({ companyId: f.company.id, id: f.asked.id, actor: f.memberActor });
      const again = await f.askInRun();
      assert.equal(again.status, "asking");
      await expireWindow(again.id);
      const answer = await awaitPersonAtPage({ requestId: again.id, companyId: f.company.id });
      assert.equal(answer.outcome, "lapsed");
      const row = await requests().findOneByOrFail({ id: again.id });
      assert.equal(row.status, "waiting");
      assert.equal(row.reminders, 0, "they came, so the reminders start over");
    }
    assert.equal(await requests().count(), 1);
  });

  test("a press landing while the pause lands doesn't strand the Run", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await expireWindow(asked.id);
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    // The person is quick: the Run is still stopping its turn.
    await readyInputRequest({ companyId: f.company.id, id: asked.id, actor: f.memberActor });
    await pauseAsRunnerDoes(f.run.id, asked.id);
    const { releaseRunIfAlreadyAnswered } = await import("./inputRequests.js");
    await releaseRunIfAlreadyAnswered(f.run.id, asked.id);
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
  });

  test("I can't, while it waits, lets the Run go and tells it", async () => {
    const f = await waitingRun();
    await declineInputRequest({
      companyId: f.company.id,
      id: f.asked.id,
      actor: f.memberActor,
      note: "I've lost that phone",
    });
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
    const brief = await inputRequestBriefForRun(f.run.id);
    assert.match(brief, /said they can't help/);
    assert.match(brief, /I've lost that phone/);
    assert.match(brief, /Don't ask again/);
    await assert.rejects(f.askInRun(), /already said they can't/, "the Run doesn't ask twice");
  });
});

describe("a code the page refused", () => {
  test("asking again reopens it and says so, until wrong codes would lock the account", async () => {
    const f = await fixture();
    let asked = await f.askInRun();
    for (let given = 1; given <= MAX_CODES_PER_INPUT_REQUEST; given += 1) {
      await answerInputRequest({
        companyId: f.company.id,
        id: asked.id,
        actor: f.memberActor,
        value: `00000${given}`,
      });
      const taken = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
      assert.equal(taken.outcome, "code");
      if (given === MAX_CODES_PER_INPUT_REQUEST) break;
      asked = await f.askInRun();
      assert.equal(asked.status, "asking");
      assert.equal(asked.lastCodeRefused, true);
      assert.equal(asked.codesGiven, given);
    }
    await assert.rejects(f.askInRun(), /lock accounts/);
    assert.equal(await requests().count(), 1);
  });

  test("the next site in the same Run isn't told the last code was refused", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await answerInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      value: "111111",
    });
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    const next = await f.askInRun({
      title: "HMRC access code",
      pageUrl: "https://www.tax.service.gov.test/login",
    });
    assert.equal(next.id, asked.id, "still one request for this piece of work");
    assert.equal(next.pageOrigin, "https://www.tax.service.gov.test");
    assert.equal(next.title, "HMRC access code");
    assert.equal(next.lastCodeRefused, false);
    assert.equal(next.codesGiven, 0);
  });

  test("a sign-in days later in the same Todo is a fresh ask, not a refusal", async () => {
    const f = await fixture();
    const work = { todoId: "todo-1", browserSessionId: "s" };
    const asked = await f.askInRun({ work });
    await answerInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      value: "111111",
    });
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    await requests().update({ id: asked.id }, { answeredAt: new Date(Date.now() - 2 * HOUR_MS) });
    const later = await f.askInRun({ work });
    assert.equal(later.lastCodeRefused, false);
    assert.equal(later.codesGiven, 0);
  });
});

describe("answers in words", () => {
  test("the Run stops at once, and the answer comes back in its brief", async () => {
    const f = await fixture();
    const { request, alreadyWaiting } = await openAnswerInputRequest({
      companyId: f.company.id,
      employeeId: f.employee.id,
      title: "Which VAT quarter should this cover?",
      named: f.member.email,
      work: { runId: f.run.id, routineId: f.routine.id },
    });
    assert.equal(alreadyWaiting, false);
    assert.equal(request.kind, "answer");
    assert.equal(request.status, "waiting");
    await pauseAsRunnerDoes(f.run.id, request.id);

    await assert.rejects(
      readyInputRequest({ companyId: f.company.id, id: request.id, actor: f.memberActor }),
      /nothing to get ready for/,
    );
    await answerInputRequest({
      companyId: f.company.id,
      id: request.id,
      actor: f.memberActor,
      value: "Q3, July to September",
    });
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
    const brief = await inputRequestBriefForRun(f.run.id);
    assert.match(brief, /Valeria answered/);
    assert.match(brief, /Q3, July to September/);
  });

  test("asking the same work again doesn't page anyone twice", async () => {
    const f = await fixture();
    const ask = () =>
      openAnswerInputRequest({
        companyId: f.company.id,
        employeeId: f.employee.id,
        title: "Which quarter?",
        work: { runId: f.run.id, routineId: f.routine.id },
      });
    const first = await ask();
    const second = await ask();
    assert.equal(second.alreadyWaiting, true);
    assert.equal(second.request.id, first.request.id);
  });

  test("a chat just asks", async () => {
    const f = await fixture();
    await assert.rejects(
      openAnswerInputRequest({
        companyId: f.company.id,
        employeeId: f.employee.id,
        title: "Which quarter?",
        work: { conversationId: "c1" },
      }),
      /In a chat, just ask them/,
    );
  });
});

describe("a Todo", () => {
  async function todoFixture() {
    const f = await fixture();
    await insertEmployeeModel({
      employeeId: f.employee.id,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      authMode: "apikey",
      isActive: true,
      connectedAt: new Date(),
      configJson: "{}",
    });
    const project = await insert(Project, {
      companyId: f.company.id,
      name: "Ops",
      slug: "ops",
      key: "OPS",
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "File VAT",
      status: "in_progress",
      assigneeEmployeeId: f.employee.id,
      createdById: f.member.id,
    });
    const pickup = await insert(TodoPickup, {
      companyId: f.company.id,
      todoId: todo.id,
      employeeId: f.employee.id,
      trigger: "assigned",
      status: "running",
      authority: "employee",
      acceptedAt: new Date(),
      attempt: 1,
    });
    return { ...f, project, todo, pickup };
  }

  test("nobody came, so it waits; I'm ready starts its next session on the same Todo", async () => {
    const f = await todoFixture();
    const asked = await f.askInRun({
      named: null,
      work: { todoId: f.todo.id, browserSessionId: "s" },
    });
    assert.equal(asked.assigneeUserId, f.member.id, "whoever filed the Todo");
    await expireWindow(asked.id);
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    const waiting = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: f.todo.id });
    assert.equal(waiting.status, "in_progress", "a state of in progress, not a status");
    assert.equal(waiting.waitingOn, "input_request");
    assert.equal(waiting.waitingRefId, asked.id);

    // The session that asked ends as sessions do.
    await AppDataSource.getRepository(TodoPickup).update(
      { id: f.pickup.id },
      { status: "done", endedAt: new Date() },
    );
    await readyInputRequest({ companyId: f.company.id, id: asked.id, actor: f.memberActor });
    const woken = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: f.todo.id });
    assert.equal(woken.waitingOn, null);
    const next = await AppDataSource.getRepository(TodoPickup).findOneByOrFail({
      todoId: f.todo.id,
      status: "queued",
    });
    assert.equal(next.trigger, "person_input");
    assert.equal(next.authority, "employee", "pressing a button lends nothing");
    assert.match(next.note, /just said they're ready/);
    assert.match(next.note, /sign in again from the start/);
  });

  test("it closes itself once the Todo stops waiting and nothing is working it", async () => {
    const f = await todoFixture();
    const asked = await f.askInRun({ work: { todoId: f.todo.id, browserSessionId: "s" } });
    await expireWindow(asked.id);
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    await AppDataSource.getRepository(TodoPickup).update(
      { id: f.pickup.id },
      { status: "done", endedAt: new Date() },
    );
    await AppDataSource.getRepository(Todo).update(
      { id: f.todo.id },
      { status: "done", waitingOn: null, waitingRefId: null },
    );
    await sweepInputRequests();
    const closed = await requests().findOneByOrFail({ id: asked.id });
    assert.equal(closed.status, "closed");
    assert.match(closed.closeReason, /closed/);
  });
});

describe("the sweep", () => {
  async function waitingRun() {
    const f = await fixture();
    const asked = await f.askInRun();
    await expireWindow(asked.id);
    await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
    await pauseAsRunnerDoes(f.run.id, asked.id);
    await settleInputRequestPingsForTests();
    await AppDataSource.getRepository(Notification).clear();
    await AppDataSource.getRepository(EmailLog).clear();
    return { ...f, asked };
  }

  test("reminders back off, exactly once each, and bring in the admins after a day", async () => {
    const f = await waitingRun();
    const bells = AppDataSource.getRepository(Notification);
    const row = () => requests().findOneByOrFail({ id: f.asked.id });
    const sweepAt = async (hours: number) => {
      await sweepInputRequests(new Date(f.asked.createdAt.getTime() + hours * HOUR_MS));
      await settleInputRequestPingsForTests();
    };
    await sweepAt(0.5);
    assert.equal(await bells.count(), 0, "not yet");
    await sweepAt(1.1);
    assert.equal(await bells.count(), 1);
    await sweepAt(1.2);
    assert.equal(await bells.count(), 1, "exactly once");
    assert.equal((await row()).reminders, 1);

    const until = async (reminders: number) => {
      let hours = 1.2;
      while ((await row()).reminders < reminders) {
        hours =
          ((await row()).nextReminderAt!.getTime() - f.asked.createdAt.getTime()) / HOUR_MS + 0.1;
        await sweepAt(hours);
      }
      return hours;
    };
    await until(3);
    const named = (await bells.find()).map((bell) => bell.userId);
    assert.ok(
      named.every((id) => id === f.member.id),
      "only the person named, so far",
    );
    await bells.clear();
    await until(4);
    assert.deepEqual(
      new Set((await bells.find()).map((bell) => bell.userId)),
      new Set([f.member.id, f.owner.id]),
      "a day in, the owner hears too",
    );
    assert.ok(!(await everythingStored(f.asked.id)).includes("Bo Bystander"));
  });

  test("the schedule is an hour, then four, then twelve, then every day", () => {
    assert.equal(inputRequestRemindersBy(0.5 * HOUR_MS), 0);
    assert.equal(inputRequestRemindersBy(1 * HOUR_MS), 1);
    assert.equal(inputRequestRemindersBy(4 * HOUR_MS), 2);
    assert.equal(inputRequestRemindersBy(12 * HOUR_MS), 3);
    assert.equal(inputRequestRemindersBy(24 * HOUR_MS), 4);
    assert.equal(inputRequestRemindersBy(7 * 24 * HOUR_MS), 10);
  });

  test("after a week it gives up, and the Run goes on, told so", async () => {
    const f = await waitingRun();
    const at = new Date(f.asked.createdAt.getTime() + INPUT_REQUEST_EXPIRY_MS + 1_000);
    await sweepInputRequests(at);
    await settleInputRequestPingsForTests();
    const row = await requests().findOneByOrFail({ id: f.asked.id });
    assert.equal(row.status, "expired");
    assert.equal(row.nextReminderAt, null);
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
    assert.match(await inputRequestBriefForRun(f.run.id), /Nobody answered, after a week/);
    await assert.rejects(f.askInRun(), /Nobody answered this in time/);
    const [bell] = await AppDataSource.getRepository(Notification).find({
      order: { createdAt: "DESC" },
    });
    assert.match(bell.title, /stopped waiting/);
  });

  test("a session that died holding a page leaves no code behind", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await answerInputRequest({
      companyId: f.company.id,
      id: asked.id,
      actor: f.memberActor,
      value: "999999",
    });
    assert.ok((await requests().findOneByOrFail({ id: asked.id })).encryptedAnswer);
    await requests().update({ id: asked.id }, { askingUntil: new Date(Date.now() - 2 * 60_000) });
    await sweepInputRequests();
    const row = await requests().findOneByOrFail({ id: asked.id });
    assert.equal(row.encryptedAnswer, null);
    assert.equal(row.status, "waiting");
  });

  test("someone said they were ready and nothing came of it, so it waits for them again", async () => {
    const f = await waitingRun();
    await readyInputRequest({ companyId: f.company.id, id: f.asked.id, actor: f.memberActor });
    // A queue that hasn't got to it yet is no reason to give up on it.
    await sweepInputRequests(new Date(Date.now() + 60_000));
    assert.equal((await requests().findOneByOrFail({ id: f.asked.id })).status, "ready");
    await sweepInputRequests(new Date(Date.now() + INPUT_REQUEST_READY_WAIT_MS + 60_000));
    assert.equal((await requests().findOneByOrFail({ id: f.asked.id })).status, "waiting");
  });

  test("the Run ending without it closes it, and clears the bell", async () => {
    const f = await waitingRun();
    await runs().update({ id: f.run.id }, { status: "error", waitingOnInputRequestId: null });
    await sweepInputRequests();
    const row = await requests().findOneByOrFail({ id: f.asked.id });
    assert.equal(row.status, "closed");
    assert.match(row.closeReason, /finished without it/);
  });

  test("the Routine turned off while it waited lets the queue end the Run", async () => {
    const f = await waitingRun();
    await AppDataSource.getRepository(Routine).update({ id: f.routine.id }, { enabled: false });
    await sweepInputRequests();
    assert.equal((await requests().findOneByOrFail({ id: f.asked.id })).status, "closed");
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
  });

  test("a Standdown holds the reminders, and the week", async () => {
    const f = await waitingRun();
    await placeStanddown({
      companyId: f.company.id,
      scope: "company",
      reason: "Pausing everything",
      placedByUserId: f.owner.id,
    });
    await sweepInputRequests(new Date(f.asked.createdAt.getTime() + 2 * HOUR_MS));
    await sweepInputRequests(
      new Date(f.asked.createdAt.getTime() + INPUT_REQUEST_EXPIRY_MS + HOUR_MS),
    );
    await settleInputRequestPingsForTests();
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
    assert.equal((await requests().findOneByOrFail({ id: f.asked.id })).status, "waiting");
    const [view] = await listOpenInputRequests({ companyId: f.company.id, actor: f.memberActor });
    assert.equal(view.heldByStanddown, true);
  });
});

describe("a process dying between a person's answer and the work being let go", () => {
  test("a Run held for a request that has ended is freed by the next sweep", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await requests().update(
      { id: asked.id },
      { status: "ready", askingUntil: null, readyAt: new Date() },
    );
    await pauseAsRunnerDoes(f.run.id, asked.id);
    await sweepInputRequests();
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
  });

  test("a Run held for a request that no longer exists is freed too", async () => {
    const f = await fixture();
    await pauseAsRunnerDoes(f.run.id, "00000000-0000-4000-8000-00000000dead");
    await sweepInputRequests();
    assert.equal((await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId, null);
  });

  test("a Run still rightly waiting is left alone", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    await requests().update(
      { id: asked.id },
      { status: "waiting", askingUntil: null, nextReminderAt: new Date(Date.now() + HOUR_MS) },
    );
    await pauseAsRunnerDoes(f.run.id, asked.id);
    await sweepInputRequests();
    assert.equal(
      (await runs().findOneByOrFail({ id: f.run.id })).waitingOnInputRequestId,
      asked.id,
    );
  });

  test("a Todo waiting on a request that's gone stops waiting", async () => {
    const f = await fixture();
    const project = await insert(Project, {
      companyId: f.company.id,
      name: "Ops",
      slug: "ops",
      key: "OPS",
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "File VAT",
      status: "in_progress",
      assigneeEmployeeId: f.employee.id,
      waitingOn: "input_request",
      waitingRefId: "00000000-0000-4000-8000-00000000dead",
    });
    await sweepInputRequests();
    const after = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: todo.id });
    assert.equal(after.waitingOn, null);
  });
});

describe("who can answer", () => {
  test("whoever was asked and the owners and admins, and it reads as nothing to anyone else", async () => {
    const f = await fixture();
    const asked = await f.askInRun();
    assert.equal(canAnswerInputRequest(asked, f.memberActor), true);
    assert.equal(canAnswerInputRequest(asked, f.ownerActor), true);
    assert.equal(canAnswerInputRequest(asked, f.bystanderActor), false);

    assert.equal(
      (await listOpenInputRequests({ companyId: f.company.id, actor: f.bystanderActor })).length,
      0,
    );
    const [view] = await listOpenInputRequests({ companyId: f.company.id, actor: f.memberActor });
    assert.equal(view.id, asked.id);
    assert.equal(view.canAnswer, true);
    assert.equal(view.work.kind, "run");
    assert.equal(view.work.link, `/c/acme/routines/mira/file-vat?run=${f.run.id}`);
    assert.equal(JSON.stringify(view).includes("encryptedAnswer"), false);
    assert.equal(view.browserSessionId, null, "watching the browser is an owner's or admin's");
    const [ownersView] = await listOpenInputRequests({
      companyId: f.company.id,
      actor: f.ownerActor,
    });
    assert.equal(ownersView.browserSessionId, "session-1");

    await assert.rejects(
      answerInputRequest({
        companyId: f.company.id,
        id: asked.id,
        actor: f.bystanderActor,
        value: "123456",
      }),
      /not found/,
    );
  });

  test("nobody named goes to the owners and admins alone", async () => {
    const f = await fixture();
    const asked = await f.askInRun({ named: null });
    assert.equal(asked.assigneeUserId, null);
    assert.equal(canAnswerInputRequest(asked, f.memberActor), false);
    assert.equal(canAnswerInputRequest(asked, f.ownerActor), true);
    await settleInputRequestPingsForTests();
    const bells = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(
      bells.map((bell) => bell.userId),
      [f.owner.id],
    );
  });

  test("a browser that needs Approval to submit takes an owner or admin to answer", async () => {
    const f = await fixture();
    const asked = await f.askInRun({ adminOnly: true });
    assert.equal(canAnswerInputRequest(asked, f.memberActor), false);
    assert.equal(canAnswerInputRequest(asked, f.ownerActor), true);
    assert.equal(
      (await listOpenInputRequests({ companyId: f.company.id, actor: f.memberActor })).length,
      0,
    );
    await settleInputRequestPingsForTests();
    const bells = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(
      bells.map((bell) => bell.userId),
      [f.owner.id],
      "so that's who hears",
    );
  });

  test("a name that isn't a Member is refused rather than silently dropped", async () => {
    const f = await fixture();
    await assert.rejects(f.askInRun({ named: "stranger@elsewhere.test" }), /No Member matches/);
    assert.equal(await requests().count(), 0);
  });
});

describe("limits", () => {
  test("an AI Employee holds only a few open requests at once", async () => {
    const f = await fixture();
    for (let i = 0; i < MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE; i += 1) {
      await f.askInRun({ work: { browserSessionId: `session-${i}` } });
    }
    await assert.rejects(
      f.askInRun({ work: { browserSessionId: "one-more" } }),
      /may hold 3 at once/,
    );
    assert.equal(await requests().count(), MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE);
  });

  test("the AI Employee's words are redacted and bounded before a person reads them", async () => {
    const f = await fixture();
    const asked = await f.askInRun({
      title: `Sign in with password=hunter2hunter2 ${"x".repeat(400)}`,
      body: "y".repeat(5_000),
    });
    assert.ok(asked.title.length <= 160);
    assert.ok(asked.body.length <= 1_000);
    assert.ok(!asked.title.includes("hunter2hunter2"));
  });

  test("only a page on a real site can be asked about", async () => {
    const f = await fixture();
    await assert.rejects(f.askInRun({ pageUrl: "about:blank" }), /http\(s\) site/);
    await assert.rejects(f.askInRun({ pageUrl: "file:///etc/passwd" }), /http\(s\) site/);
  });
});
