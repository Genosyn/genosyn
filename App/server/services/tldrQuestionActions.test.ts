import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrQuestionAction } from "../db/entities/TldrQuestionAction.js";
import { TldrQuestionMessage } from "../db/entities/TldrQuestionMessage.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import {
  actionRunnableBy,
  claimAction,
  composeActionInstruction,
  dismissQuestionAction,
  loadRunnableAction,
  MAX_ACTIONS_PER_ANSWER,
  proposeQuestionActions,
  releaseInterruptedTldrQuestionActions,
  serializeTldrQuestionAction,
  settleAction,
  TldrQuestionActionNotFoundError,
  TldrQuestionActionValidationError,
} from "./tldrQuestionActions.js";
import { listTldrQuestions, runTldrQuestionTurn } from "./tldrQuestions.js";
import { EmployeeWorkloadBusyError } from "./workloadLeases.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const NOW = new Date("2026-08-21T09:00:00.000Z");

type Fixture = {
  company: Company;
  employee: AIEmployee;
  owner: User;
  member: User;
  model: AIModel;
  tldr: Tldr;
  question: TldrQuestion;
  message: TldrQuestionMessage;
};

async function fixture(): Promise<Fixture> {
  const owner = await insert(User, {
    email: "owner-qa@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  const member = await insert(User, {
    email: "member-qa@example.test",
    name: "Member",
    passwordHash: "x",
  });
  const company = await insert(Company, {
    name: "Acme Actions",
    slug: "acme-actions",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Chief of staff",
    soulBody: "Be clear.",
  });
  const model = await insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "ciphertext" }),
    connectedAt: NOW,
    contextWindow: null,
    contextWindowSource: null,
  });
  const tldr = await insert(Tldr, {
    companyId: company.id,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeSlug: employee.slug,
    employeeRole: employee.role,
    employeeAvatarKey: null,
    status: "ready",
    triggerKind: "schedule",
    periodStart: new Date(NOW.getTime() - 86_400_000),
    periodEnd: NOW,
    title: "Daily progress",
    summary: "The team shipped.",
    body: "## Done\n\nThe nightly scrape ran and found nothing, again.",
    sourceStatsJson: "{}",
    errorMessage: "",
    finishedAt: NOW,
    standingAnsweredAt: NOW,
  });
  const question = await insert(TldrQuestion, {
    companyId: company.id,
    tldrId: tldr.id,
    employeeId: employee.id,
    prompt: "What should we stop doing?",
    origin: "standing",
    standingQuestionId: null,
    promptMessageId: null,
    createdByUserId: null,
  });
  const message = await insert(TldrQuestionMessage, {
    companyId: company.id,
    tldrId: tldr.id,
    questionId: question.id,
    role: "assistant",
    employeeId: employee.id,
    modelId: model.id,
    content: "Stop the nightly scrape — it has found nothing for three weeks.",
    status: "ok",
    actionsJson: "",
    actionId: null,
    createdByUserId: null,
  });
  return { company, employee, owner, member, model, tldr, question, message };
}

type RestrictedSeam = typeof runRestrictedEmployeeAgent;

/** A model that submits exactly these actions through the sink tool. */
const proposingAgent =
  (
    actions: unknown,
    inspect?: (system: string, prompt: string, toolNames: string[]) => void,
  ): RestrictedSeam =>
  async (params) => {
    inspect?.(
      params.system,
      JSON.stringify(params.messages),
      params.tools.map((tool) => tool.name),
    );
    const tool = params.tools.find((t) => t.name === "submit_actions");
    assert.ok(tool, "the proposal turn must expose submit_actions");
    const result = await tool.run({ actions } as Record<string, unknown>);
    return { status: "ok", finalText: result.isError ? `error: ${result.content}` : "", steps: 1 };
  };

async function propose(f: Fixture, seam: RestrictedSeam): Promise<TldrQuestionAction[]> {
  return proposeQuestionActions({
    companyId: f.company.id,
    tldrId: f.tldr.id,
    question: f.question,
    messageId: f.message.id,
    employee: f.employee,
    model: f.model,
    answer: f.message.content,
    runRestricted: seam,
  });
}

describe("proposing actions from an answer", () => {
  test("persists what the model submitted, in order", async () => {
    const f = await fixture();
    const rows = await propose(
      f,
      proposingAgent([
        {
          kind: "routine",
          label: "Pause the nightly scrape",
          intent: "Pause the Nightly Scrape Routine so it stops running until we revisit it.",
        },
        {
          kind: "todo",
          label: "Open a Todo to review",
          intent: "Open a Todo to review whether the nightly scrape is worth restarting in a month.",
        },
      ]),
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.label, row.position, row.status]),
      [
        ["routine", "Pause the nightly scrape", 0, "proposed"],
        ["todo", "Open a Todo to review", 1, "proposed"],
      ],
    );
    assert.equal(rows[0].messageId, f.message.id);
    assert.equal(rows[0].questionId, f.question.id);
  });

  test("the proposal turn carries nothing but the submission sink", async () => {
    const f = await fixture();
    let toolNames: string[] = [];
    await propose(
      f,
      proposingAgent([], (_system, _prompt, names) => {
        toolNames = names;
      }),
    );
    assert.deepEqual(
      toolNames,
      ["submit_actions"],
      "a proposal turn must be mechanically incapable of acting",
    );
  });

  test("the answer, not the raw briefing, is what the turn is asked about", async () => {
    const f = await fixture();
    let prompt = "";
    await propose(
      f,
      proposingAgent([], (_system, seenPrompt) => {
        prompt = seenPrompt;
      }),
    );
    assert.match(prompt, /nightly scrape/);
    assert.match(prompt, /untrusted/, "the card's question must still be labelled untrusted");
  });

  test("an empty submission stores nothing", async () => {
    const f = await fixture();
    assert.deepEqual(await propose(f, proposingAgent([])), []);
    assert.equal(await AppDataSource.getRepository(TldrQuestionAction).count(), 0);
  });

  test("duplicate labels collapse to one button", async () => {
    const f = await fixture();
    const rows = await propose(
      f,
      proposingAgent([
        { kind: "routine", label: "Stop it", intent: "Pause the Nightly Scrape Routine." },
        { kind: "todo", label: "STOP IT", intent: "Also pause the Nightly Scrape Routine." },
      ]),
    );
    assert.equal(rows.length, 1);
  });

  test("a malformed submission is refused rather than half-stored", async () => {
    const f = await fixture();
    const rows = await propose(
      f,
      proposingAgent([{ kind: "not-a-kind", label: "Do it", intent: "Something." }]),
    );
    assert.deepEqual(rows, []);
  });

  test("more actions than the ceiling are refused", async () => {
    const f = await fixture();
    const rows = await propose(
      f,
      proposingAgent(
        Array.from({ length: MAX_ACTIONS_PER_ANSWER + 1 }, (_, index) => ({
          kind: "todo",
          label: `Action ${index}`,
          intent: `Do thing number ${index}.`,
        })),
      ),
    );
    assert.deepEqual(rows, []);
  });

  test("a failing proposal turn costs the buttons, never the answer", async () => {
    const f = await fixture();
    const rows = await proposeQuestionActions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      question: f.question,
      messageId: f.message.id,
      employee: f.employee,
      model: f.model,
      answer: f.message.content,
      runRestricted: (async () => {
        throw new Error("model unavailable");
      }) as RestrictedSeam,
    });
    assert.deepEqual(rows, []);
    const answer = await AppDataSource.getRepository(TldrQuestionMessage).findOneBy({
      id: f.message.id,
    });
    assert.equal(answer?.status, "ok", "the answer must survive a failed proposal");
  });

  test("an empty answer never reaches the model at all", async () => {
    const f = await fixture();
    let called = false;
    const rows = await proposeQuestionActions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      question: f.question,
      messageId: f.message.id,
      employee: f.employee,
      model: f.model,
      answer: "   ",
      runRestricted: (async () => {
        called = true;
        return { status: "ok" as const, finalText: "", steps: 0 };
      }) as RestrictedSeam,
    });
    assert.deepEqual(rows, []);
    assert.equal(called, false);
  });
});

describe("authority on a button", () => {
  test("only routine actions are owner/admin gated", () => {
    assert.equal(actionRunnableBy("routine", false), false);
    assert.equal(actionRunnableBy("routine", true), true);
    for (const kind of ["todo", "project", "decision", "other"] as const) {
      assert.equal(actionRunnableBy(kind, false), true, `${kind} is member-level elsewhere too`);
    }
  });

  test("the card list tells an ordinary Member which buttons are theirs", async () => {
    const f = await fixture();
    await propose(
      f,
      proposingAgent([
        { kind: "routine", label: "Pause it", intent: "Pause the Nightly Scrape Routine." },
        { kind: "todo", label: "Open a Todo", intent: "Open a Todo to revisit this in a month." },
      ]),
    );
    const asMember = await listTldrQuestions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      userId: f.member.id,
    });
    assert.deepEqual(
      asMember.questions[0].suggestedActions.map((a) => [a.kind, a.runnable]),
      [
        ["routine", false],
        ["todo", true],
      ],
    );

    const asOwner = await listTldrQuestions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      userId: f.owner.id,
    });
    assert.deepEqual(
      asOwner.questions[0].suggestedActions.map((a) => a.runnable),
      [true, true],
    );
  });
});

describe("pressing a button", () => {
  async function proposed(f: Fixture): Promise<TldrQuestionAction> {
    const [action] = await propose(
      f,
      proposingAgent([
        {
          kind: "routine",
          label: "Pause the nightly scrape",
          intent: "Pause the Nightly Scrape Routine so it stops running until we revisit it.",
        },
      ]),
    );
    return action;
  }

  test("the instruction is composed from exactly what the Member was shown", async () => {
    const f = await fixture();
    const action = await proposed(f);
    const instruction = composeActionInstruction(action);
    assert.match(instruction, /Pause the nightly scrape/);
    assert.match(instruction, /Pause the Nightly Scrape Routine/);
    assert.match(instruction, /what you changed/);
  });

  test("only the first press of two claims the action", async () => {
    const f = await fixture();
    const action = await proposed(f);
    assert.equal(await claimAction(action.id), true);
    assert.equal(await claimAction(action.id), false, "a second press must not run the work twice");
    const claimed = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({
      id: action.id,
    });
    assert.equal(claimed?.status, "running");
  });

  test("a completed turn marks the button done and credits the presser", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await claimAction(action.id);
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      message: composeActionInstruction(action),
      actionId: action.id,
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      runChat: (async (_c, _e, _m, _h, onChunk) => {
        onChunk("Paused it.");
        return { status: "ok", reply: "Paused it.", attachmentIds: [], sidecars: {} };
      }) as Parameters<typeof runTldrQuestionTurn>[0]["runChat"],
    });

    const settled = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({
      id: action.id,
    });
    assert.equal(settled?.status, "done");
    assert.equal(settled?.completedByUserId, f.owner.id);
    assert.ok(settled?.runMessageId, "the button must point at the turn it created");

    const run = await AppDataSource.getRepository(TldrQuestionMessage).findOneBy({
      id: settled!.runMessageId!,
    });
    assert.equal(run?.role, "user");
    assert.equal(run?.actionId, action.id, "the thread must badge this turn as a button press");
  });

  test("a disconnected model puts the button back on the shelf, not on a spinner", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await claimAction(action.id);
    await AppDataSource.getRepository(AIModel).update(
      { id: f.model.id },
      { connectedAt: null, configJson: "{}" },
    );
    const settled: Array<{ id: string; status: string }> = [];
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      message: composeActionInstruction(action),
      actionId: action.id,
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      callbacks: { onAction: (a) => settled.push(a) },
    });
    const row = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({ id: action.id });
    assert.equal(row?.status, "proposed", "a turn that never ran must not strand the button");
    assert.deepEqual(settled, [{ id: action.id, status: "proposed" }]);
  });

  test("an employee busy for the whole wait releases the button too", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await claimAction(action.id);
    const settled: Array<{ id: string; status: string }> = [];
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      message: composeActionInstruction(action),
      actionId: action.id,
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      busyRetryDelayMs: 1,
      busyMaxWaitMs: 5,
      callbacks: { onAction: (a) => settled.push(a) },
      runChat: (async () => {
        throw new EmployeeWorkloadBusyError();
      }) as Parameters<typeof runTldrQuestionTurn>[0]["runChat"],
    });
    const row = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({ id: action.id });
    assert.equal(row?.status, "proposed");
    assert.deepEqual(settled, [{ id: action.id, status: "proposed" }]);
  });

  test("every press reports a terminal status, so a button never spins forever", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await claimAction(action.id);
    const settled: Array<{ id: string; status: string }> = [];
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      message: composeActionInstruction(action),
      actionId: action.id,
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      callbacks: { onAction: (a) => settled.push(a) },
      runChat: (async (_c, _e, _m, _h, onChunk) => {
        onChunk("Paused it.");
        return { status: "ok", reply: "Paused it.", attachmentIds: [], sidecars: {} };
      }) as Parameters<typeof runTldrQuestionTurn>[0]["runChat"],
    });
    assert.deepEqual(settled, [{ id: action.id, status: "done" }]);
  });

  test("a failed turn puts the button back on the shelf", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await claimAction(action.id);
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      message: composeActionInstruction(action),
      actionId: action.id,
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      runChat: (async () => {
        throw new Error("model unavailable");
      }) as Parameters<typeof runTldrQuestionTurn>[0]["runChat"],
    });
    const settled = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({
      id: action.id,
    });
    assert.equal(settled?.status, "proposed", "work that did not happen must stay offerable");
    assert.equal(settled?.completedByUserId, null);
  });

  test("the answer is streamed before the buttons are worked out, never behind them", async () => {
    const f = await fixture();
    const order: string[] = [];
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      prompt: "What should we stop doing?",
      userId: f.owner.id,
      requesterSessionVersion: f.owner.sessionVersion,
      callbacks: {
        onAssistant: () => order.push("assistant"),
        onSuggestedActions: () => order.push("actions"),
      },
      runRestricted: (async (params) => {
        const sink = params.tools.find((t) => t.name === "submit_actions");
        if (!sink) {
          // Turn one: the answer.
          params.callbacks?.onText?.("Stop the nightly scrape.");
          return { status: "ok" as const, finalText: "Stop the nightly scrape.", steps: 1 };
        }
        // Turn two proposes the buttons. The answer must already be out.
        order.push("propose");
        await sink.run({
          actions: [
            { kind: "routine", label: "Pause it", intent: "Pause the Nightly Scrape Routine." },
          ],
        } as Record<string, unknown>);
        return { status: "ok" as const, finalText: "", steps: 1 };
      }) as RestrictedSeam,
    });
    assert.deepEqual(
      order,
      ["assistant", "propose", "actions"],
      "a finished reply must not wait on a second model turn",
    );
  });

  test("a done or dismissed action refuses to run again", async () => {
    const f = await fixture();
    const action = await proposed(f);
    const target = {
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      actionId: action.id,
    };
    await settleAction(action.id, { status: "done" });
    await assert.rejects(loadRunnableAction(target), TldrQuestionActionValidationError);

    await settleAction(action.id, { status: "dismissed" });
    await assert.rejects(loadRunnableAction(target), TldrQuestionActionValidationError);

    await settleAction(action.id, { status: "proposed" });
    assert.equal((await loadRunnableAction(target)).id, action.id);
  });

  test("an action on another briefing's card is not found", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await assert.rejects(
      loadRunnableAction({
        companyId: f.company.id,
        tldrId: f.tldr.id,
        questionId: crypto.randomUUID(),
        actionId: action.id,
      }),
      TldrQuestionActionNotFoundError,
    );
  });
});

describe("clearing and recovering buttons", () => {
  async function proposed(f: Fixture): Promise<TldrQuestionAction> {
    const [action] = await propose(
      f,
      proposingAgent([
        { kind: "todo", label: "Open a Todo", intent: "Open a Todo to revisit this in a month." },
      ]),
    );
    return action;
  }

  test("dismissing keeps the row and hides it from the card", async () => {
    const f = await fixture();
    const action = await proposed(f);
    const dismissed = await dismissQuestionAction({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      actionId: action.id,
    });
    assert.equal(dismissed.status, "dismissed");
    assert.ok(
      await AppDataSource.getRepository(TldrQuestionAction).findOneBy({ id: action.id }),
      "the record that it was suggested survives the dismissal",
    );
  });

  test("dismissing is idempotent, and refuses mid-press or after the work landed", async () => {
    const f = await fixture();
    const action = await proposed(f);
    const target = {
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      actionId: action.id,
    };
    await dismissQuestionAction(target);
    assert.equal((await dismissQuestionAction(target)).status, "dismissed");

    await settleAction(action.id, { status: "running" });
    await assert.rejects(dismissQuestionAction(target), TldrQuestionActionValidationError);

    await settleAction(action.id, { status: "done" });
    await assert.rejects(dismissQuestionAction(target), TldrQuestionActionValidationError);
  });

  test("a button stuck mid-press by a restart is offered again", async () => {
    const f = await fixture();
    const action = await proposed(f);
    await settleAction(action.id, { status: "running" });
    assert.equal(await releaseInterruptedTldrQuestionActions(), 1);
    const released = await AppDataSource.getRepository(TldrQuestionAction).findOneBy({
      id: action.id,
    });
    assert.equal(released?.status, "proposed");
    assert.equal(await releaseInterruptedTldrQuestionActions(), 0);
  });

  test("removing a card takes its buttons with it", async () => {
    const f = await fixture();
    await proposed(f);
    const { deleteTldrQuestion } = await import("./tldrQuestions.js");
    await deleteTldrQuestion({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: f.question.id,
      userId: f.owner.id,
      isAdmin: true,
    });
    assert.equal(await AppDataSource.getRepository(TldrQuestionAction).count(), 0);
  });

  test("serialization carries the sentence the Member has to read", async () => {
    const f = await fixture();
    const action = await proposed(f);
    const dto = serializeTldrQuestionAction(action, false);
    assert.equal(dto.label, "Open a Todo");
    assert.equal(dto.intent, "Open a Todo to revisit this in a month.");
    assert.equal(dto.status, "proposed");
    assert.equal(dto.runnable, true);
  });
});
