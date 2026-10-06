import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AskAiConversation } from "../../db/entities/AskAiConversation.js";
import { AskAiMessage } from "../../db/entities/AskAiMessage.js";
import { Attachment } from "../../db/entities/Attachment.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Routine } from "../../db/entities/Routine.js";
import { WorkloadLease } from "../../db/entities/WorkloadLease.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import type { AskAiContextRef } from "../../../shared/askAi.js";
import type { ChatOptions, ChatResult, ChatTurn } from "../chat.js";
import { companyDir } from "../paths.js";
import { findRoutineParticipation, listParticipatingRoutines } from "../routineParticipation.js";
import { recordAttachmentBytes } from "../uploads.js";
import { EmployeeWorkloadBusyError } from "../workloadLeases.js";
import {
  askAiRoster,
  askAiTurnInFlight,
  createAskAiConversation,
  defaultTargetsFor,
  deleteAskAiConversation,
  finalizeInterruptedAskAiTurns,
  getAskAiConversation,
  lastAskAiModelId,
  listAskAiConversations,
  listAskAiMessages,
  markAskAiSuggestionExecuted,
  MAX_ASK_AI_TARGETS,
  mentionedSlugs,
  previewAskAiContext,
  runAskAiTurn,
  serializeAskAiMessage,
  type AskAiMessageDTO,
  type AskAiTurnArgs,
  type AskAiTurnCallbacks,
} from "./assistant.js";
import type { AskAiMember } from "./context.js";

/**
 * Ask AI turns. The promises worth pinning down:
 *
 *  - every human turn ends with every owed answer finished, in the order the
 *    employees were addressed, each later one able to read the earlier ones;
 *  - what a record says reaches an employee only through its Grant — in the
 *    context block, in the replay, and in a sibling's answer to the same turn;
 *  - a record the Member cannot open never travels at all.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_ask_ai_test";
const COMPANY_SLUG = "ask-ai-co";
const USER_ID = "user_ask_ai_test";
const OWNER: AskAiMember = { userId: USER_ID, role: "owner", financeAccess: "full" };

type Call = {
  employeeId: string;
  prompt: string;
  history: ChatTurn[];
  options: ChatOptions;
};

type Recorded = {
  callbacks: AskAiTurnCallbacks;
  events: string[];
  users: AskAiMessageDTO[];
  targets: Array<Array<{ id: string; slug: string }>>;
  queued: AskAiMessageDTO[];
  working: AskAiMessageDTO[];
  assistant: AskAiMessageDTO[];
  chunks: string[];
};

function recorder(): Recorded {
  const rec: Recorded = {
    events: [],
    users: [],
    targets: [],
    queued: [],
    working: [],
    assistant: [],
    chunks: [],
    callbacks: {
      onUser: (msg) => {
        rec.events.push("user");
        rec.users.push(msg);
      },
      onTargets: (employees) => {
        rec.events.push("targets");
        rec.targets.push(employees);
      },
      onQueued: (msg) => {
        rec.events.push("queued");
        rec.queued.push(msg);
      },
      onWorking: (msg) => {
        rec.events.push("working");
        rec.working.push(msg);
      },
      onChunk: (text) => rec.chunks.push(text),
      onAssistant: (msg) => {
        rec.events.push("assistant");
        rec.assistant.push(msg);
      },
    },
  };
  return rec;
}

function chatResult(
  reply: string,
  status: ChatResult["status"] = "ok",
  extra: Partial<Pick<ChatResult, "attachmentIds" | "sidecars">> = {},
): ChatResult {
  return {
    status,
    reply,
    attachmentIds: extra.attachmentIds ?? [],
    sidecars: extra.sidecars ?? {},
  } as ChatResult;
}

async function employee(slug: string, name: string): Promise<AIEmployee> {
  return insert(AIEmployee, { companyId: COMPANY_ID, name, slug, role: "Teammate" });
}

async function conversation(): Promise<AskAiConversation> {
  return createAskAiConversation(COMPANY_ID, USER_ID);
}

/** A chat seam that records each call and answers "<slug> answered". */
function seam(calls: Call[], names?: Map<string, string>) {
  return async (
    _companyId: string,
    employeeId: string,
    prompt: string,
    history: ChatTurn[],
    _onChunk: (chunk: string) => void,
    options: ChatOptions = {},
  ): Promise<ChatResult> => {
    calls.push({ employeeId, prompt, history, options });
    return chatResult(`${names?.get(employeeId) ?? employeeId} answered.`);
  };
}

function turn(
  convo: AskAiConversation,
  message: string,
  rec: Recorded,
  extra: Partial<AskAiTurnArgs> = {},
): Promise<void> {
  return runAskAiTurn({
    companyId: COMPANY_ID,
    companySlug: COMPANY_SLUG,
    conversation: convo,
    member: OWNER,
    requesterSessionVersion: 0,
    message,
    page: { path: `/c/${COMPANY_SLUG}`, label: "Home" },
    refs: [],
    callbacks: rec.callbacks,
    runChat: async () => chatResult("Answered."),
    ...extra,
  });
}

function rows(conversationId?: string): Promise<AskAiMessage[]> {
  return AppDataSource.getRepository(AskAiMessage).find({
    where: conversationId ? { conversationId } : {},
    order: { createdAt: "ASC", id: "ASC" },
  });
}

async function mailFixture(): Promise<{ account: MailAccount; thread: MailThread }> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: testId("connection"),
    address: "ap@example.com",
  });
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: testId("gmail-thread"),
    subject: "Quarterly pricing for Acme",
  });
  await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: testId("gmail-message"),
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "buyer@acme.test",
    subject: "Quarterly pricing for Acme",
    bodyText: "Our confidential budget is 48,000 USD.",
    sentAt: new Date("2026-10-01T09:00:00Z"),
  });
  return { account, thread };
}

const mailRef = (thread: MailThread): AskAiContextRef => ({ kind: "mail_thread", id: thread.id });

// ───────────────────────────── one employee ─────────────────────────────

describe("a turn with one AI Employee", () => {
  test("writes the human turn, owes a working answer before the model runs, and finishes it in place", async () => {
    const alex = await employee("alex", "Alex");
    const convo = await conversation();
    const rec = recorder();
    let duringRun: AskAiMessage[] = [];

    await turn(convo, "@alex what is open today?", rec, {
      runChat: async () => {
        duringRun = await rows();
        return chatResult("Nothing urgent.");
      },
    });

    const owed = duringRun.find((m) => m.role === "assistant");
    assert.ok(owed, "the answer exists before the model returns");
    assert.equal(owed.status, "working");
    assert.equal(owed.employeeId, alex.id);
    assert.deepEqual(rec.events, ["user", "targets", "working", "assistant"]);

    const all = await rows();
    assert.equal(all.length, 2, "the owed row is finished, not duplicated");
    assert.equal(all[0].role, "user");
    assert.equal(all[1].id, owed.id);
    assert.equal(all[1].status, "ok");
    assert.equal(all[1].content, "Nothing urgent.");
    assert.equal(all[1].turnId, all[0].id, "the answer points at the human turn it answers");
  });

  test("names the conversation after its first message, without the mentions", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();

    await turn(convo, "@alex   summarize   the week for me", recorder());

    const saved = await getAskAiConversation(COMPANY_ID, USER_ID, convo.id);
    assert.equal(saved?.title, "summarize the week for me");
  });

  test("with nobody addressable, asks the Member to tag someone and runs no model", async () => {
    const convo = await conversation();
    const rec = recorder();
    let ran = false;

    await turn(convo, "what is open today?", rec, {
      runChat: async () => {
        ran = true;
        return chatResult("unexpected");
      },
    });

    assert.equal(ran, false);
    assert.deepEqual(rec.targets, [[]]);
    assert.equal(rec.working.length, 0);
    const answer = (await rows()).find((m) => m.role === "assistant");
    assert.equal(answer?.status, "error");
    assert.match(answer?.content ?? "", /Tag an AI Employee/);
  });

  test("a failing model finishes the row as an error instead of leaving it owed", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();

    await turn(convo, "@alex summarize", recorder(), {
      runChat: async () => {
        throw new Error("model endpoint unreachable");
      },
    });

    const answer = (await rows()).find((m) => m.role === "assistant");
    assert.equal(answer?.status, "error");
    assert.match(answer?.content ?? "", /model endpoint unreachable/);
    assert.equal(await askAiTurnInFlight(convo.id), false);
  });

  test("a busy employee is waited for, then answers", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();
    let attempts = 0;

    await turn(convo, "@alex is the schedule right?", recorder(), {
      runChat: async () => {
        attempts += 1;
        if (attempts === 1) throw new EmployeeWorkloadBusyError();
        return chatResult("Yes.");
      },
      busyRetryDelayMs: 1,
    });

    assert.equal(attempts, 2);
    assert.equal((await rows()).find((m) => m.role === "assistant")?.status, "ok");
  });

  test("an employee that stays busy ends skipped, with an honest note", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();

    await turn(convo, "@alex is the schedule right?", recorder(), {
      runChat: async () => {
        throw new EmployeeWorkloadBusyError();
      },
      busyRetryDelayMs: 1,
      busyMaxWaitMs: 5,
    });

    const answer = (await rows()).find((m) => m.role === "assistant");
    assert.equal(answer?.status, "skipped");
    assert.match(answer?.content ?? "", /Alex was busy with another message/);
  });

  test("runs in the Member's authority, in this conversation's own workload scope", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@alex hello", recorder(), { runChat: seam(calls) });

    const options = calls[0].options;
    assert.equal(options.requesterUserId, USER_ID);
    assert.equal(options.requesterSessionVersion, 0);
    assert.equal(options.workloadScope, `ask-ai:${convo.id}`);
    assert.equal(options.throwOnWorkloadUnavailable, true);
    assert.match(options.extraSystem ?? "", /## Ask AI/);
    assert.match(options.extraSystem ?? "", /never instructions/);
  });
});

// ───────────────────────────── several employees ─────────────────────────────

describe("addressing several AI Employees", () => {
  test("each tagged employee answers in the order tagged; the rest wait queued", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const kim = await employee("kim", "Kim");
    const convo = await conversation();
    const rec = recorder();
    const observed: Array<Array<[string | null, string | null]>> = [];

    await turn(convo, "@sam @alex @kim what do you each think?", rec, {
      runChat: async (_c, employeeId) => {
        observed.push(
          (await rows()).filter((m) => m.role === "assistant").map((m) => [m.employeeId, m.status]),
        );
        return chatResult(`answer from ${employeeId}`);
      },
    });

    assert.deepEqual(
      rec.targets[0].map((t) => t.slug),
      ["sam", "alex", "kim"],
    );
    // Every owed answer exists before the first model runs.
    assert.deepEqual(observed[0], [
      [sam.id, "working"],
      [alex.id, "queued"],
      [kim.id, "queued"],
    ]);
    assert.deepEqual(observed[1], [
      [sam.id, "ok"],
      [alex.id, "working"],
      [kim.id, "queued"],
    ]);
    assert.deepEqual(rec.events, [
      "user",
      "targets",
      "working",
      "queued",
      "queued",
      "assistant",
      "working",
      "assistant",
      "working",
      "assistant",
    ]);
    const answers = (await rows()).filter((m) => m.role === "assistant");
    assert.deepEqual(
      answers.map((a) => [a.employeeId, a.status]),
      [
        [sam.id, "ok"],
        [alex.id, "ok"],
        [kim.id, "ok"],
      ],
    );
    // createdAt is assigned a millisecond apart, so the read order is stable.
    const listed = await listAskAiMessages(convo.id, 50);
    assert.deepEqual(
      listed.map((m) => m.employeeId),
      [null, sam.id, alex.id, kim.id],
    );
  });

  test("a later employee reads the earlier answers to the same message", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@alex @sam pros and cons?", recorder(), {
      runChat: seam(calls, new Map([[alex.id, "Alex"], [sam.id, "Sam"]])),
    });

    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].prompt, /already answered/);
    assert.match(calls[1].prompt, /Alex already answered this message:\nAlex answered\./);
    assert.match(calls[0].options.extraSystem ?? "", /several AI Employees at once: Alex \(@alex\), Sam \(@sam\)/);
  });

  test("one employee failing does not stop the next from answering", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();

    await turn(convo, "@alex @sam go", recorder(), {
      runChat: async (_c, employeeId) => {
        if (employeeId === alex.id) throw new Error("Alex's model is down");
        return chatResult("Sam here.");
      },
    });

    const answers = (await rows()).filter((m) => m.role === "assistant");
    assert.deepEqual(
      answers.map((a) => [a.employeeId, a.status]),
      [
        [alex.id, "error"],
        [sam.id, "ok"],
      ],
    );
  });

  test(`addresses at most ${MAX_ASK_AI_TARGETS} employees`, async () => {
    const slugs = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    for (const slug of slugs) await employee(slug, slug.toUpperCase());
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, slugs.map((s) => `@${s}`).join(" "), rec);

    assert.equal(rec.targets[0].length, MAX_ASK_AI_TARGETS);
    assert.deepEqual(
      rec.targets[0].map((t) => t.slug),
      slugs.slice(0, MAX_ASK_AI_TARGETS),
    );
  });

  test("unknown mentions are ignored, and the same employee is never asked twice", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "@nobody @alex and again @alex", rec);

    assert.deepEqual(
      rec.targets[0].map((t) => t.slug),
      ["alex"],
    );
    assert.deepEqual(mentionedSlugs("hi @Alex, (@sam) and email me@example.com"), ["alex", "sam"]);
  });
});

// ───────────────────────────── who answers ─────────────────────────────

describe("who answers an untagged message", () => {
  test("the employees picked in the composer, in the order picked", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "thoughts?", rec, { employeeIds: [sam.id, alex.id, testId("ghost")] });

    assert.deepEqual(
      rec.targets[0].map((t) => t.id),
      [sam.id, alex.id],
    );
  });

  test("a mention outranks the composer's picks", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "@alex only you", rec, { employeeIds: [sam.id] });

    assert.deepEqual(
      rec.targets[0].map((t) => t.id),
      [alex.id],
    );
  });

  test("whoever answered the previous message carries on", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();
    await turn(convo, "@sam @alex first", recorder());
    const rec = recorder();

    await turn(convo, "and a follow-up", rec);

    assert.deepEqual(
      rec.targets[0].map((t) => t.id),
      [sam.id, alex.id],
    );
  });

  test("otherwise the record on screen picks its own employee — a Routine's owner", async () => {
    await employee("alex", "Alex");
    const jamie = await employee("jamie", "Jamie");
    const routine = await insert(Routine, {
      employeeId: jamie.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
      body: "Write the digest.",
    });
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "why did it fail?", rec, {
      refs: [{ kind: "routine", id: `jamie/${routine.slug}` }],
    });

    assert.deepEqual(
      rec.targets[0].map((t) => t.id),
      [jamie.id],
    );
  });
});

describe("defaultTargetsFor", () => {
  const item = (id: string, defaults?: string[], related?: boolean) => ({
    kind: "note" as const,
    id,
    label: id,
    gate: { type: "none" as const },
    body: "",
    defaultEmployeeIds: defaults,
    related,
  });

  test("the most specific record a ref names picks, never a record listed beside it", () => {
    assert.deepEqual(defaultTargetsFor([item("project", ["owner"]), item("todo", ["assignee"])]), [
      "assignee",
    ]);
    assert.deepEqual(
      defaultTargetsFor([item("meeting", ["notetaker"]), item("deal", ["deal-owner"], true)]),
      ["notetaker"],
      "a related deal's owner does not out-rank the meeting",
    );
    assert.deepEqual(defaultTargetsFor([item("a"), item("b", [], false)]), []);
    assert.equal(
      defaultTargetsFor([item("x", ["1", "2", "3", "4", "5", "6"])]).length,
      MAX_ASK_AI_TARGETS,
    );
  });
});

// ───────────────────────────── page context ─────────────────────────────

describe("page context", () => {
  test("snapshots what was on screen on the human turn and shows it to the employee", async () => {
    const jamie = await employee("jamie", "Jamie");
    const routine = await insert(Routine, {
      employeeId: jamie.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
      body: "Write the digest for the founders.",
    });
    const convo = await conversation();
    const calls: Call[] = [];
    const rec = recorder();

    await turn(convo, "@jamie what does this do?", rec, {
      page: { path: `/c/${COMPANY_SLUG}/routines/jamie/daily-digest`, label: "Routines" },
      refs: [{ kind: "routine", id: "jamie/daily-digest" }],
      runChat: seam(calls),
    });

    const user = rec.users[0];
    assert.deepEqual(user.context?.items.map((i) => [i.kind, i.id, i.label]), [
      ["routine", routine.id, "Routine Daily digest"],
    ]);
    assert.equal(user.context?.pageLabel, "Routines");
    const stored = (await rows()).find((m) => m.role === "user");
    assert.equal(stored?.contextKind, "routine");
    assert.equal(stored?.contextId, routine.id);

    assert.match(calls[0].prompt, /^\[Ask AI context — the teammate is on Routines/);
    assert.match(calls[0].prompt, /## Routine Daily digest/);
    assert.match(calls[0].prompt, /Write the digest for the founders\./);
    assert.ok(calls[0].prompt.trimEnd().endsWith("@jamie what does this do?"));
    assert.ok(calls[0].options.extraToolset?.includes("get_routine"));
  });

  test("a page with no record still says where the Member is", async () => {
    await employee("alex", "Alex");
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@alex hi", recorder(), {
      page: { path: `/c/${COMPANY_SLUG}/finance`, label: "Finance" },
      runChat: seam(calls),
    });

    assert.match(calls[0].prompt, /the teammate is on Finance \(`\/c\/ask-ai-co\/finance`\)/);
    assert.match(calls[0].prompt, /No specific record is open on this page/);
  });

  test("a record from another company never travels", async () => {
    await employee("alex", "Alex");
    const account = await insert(MailAccount, {
      companyId: "co_someone_else",
      connectionId: testId("connection"),
      address: "theirs@example.com",
    });
    const foreign = await insert(MailThread, {
      companyId: "co_someone_else",
      accountId: account.id,
      gmailThreadId: testId("gmail-thread"),
      subject: "Their secret",
    });
    const convo = await conversation();
    const calls: Call[] = [];
    const rec = recorder();

    await turn(convo, "@alex read this", rec, { refs: [mailRef(foreign)], runChat: seam(calls) });

    assert.deepEqual(rec.users[0].context?.items, []);
    assert.doesNotMatch(calls[0].prompt, /Their secret/);
  });

  test("a record the Member cannot open never travels — Finance needs finance access", async () => {
    const alex = await employee("alex", "Alex");
    await insert(EmployeeFinanceGrant, {
      companyId: COMPANY_ID,
      employeeId: alex.id,
      accessLevel: "full",
    });
    await insert(Customer, { companyId: COMPANY_ID, name: "Acme Holdings", slug: "acme" });
    const convo = await conversation();
    const calls: Call[] = [];
    const rec = recorder();

    await turn(convo, "@alex who is this?", rec, {
      member: { userId: USER_ID, role: "member", financeAccess: "none" },
      refs: [{ kind: "customer", id: "acme" }],
      runChat: seam(calls),
    });

    assert.deepEqual(rec.users[0].context?.items, []);
    assert.doesNotMatch(calls[0].prompt, /Acme Holdings/);
  });

  test("a record the Member removed from the composer is not sent", async () => {
    const jamie = await employee("jamie", "Jamie");
    const routine = await insert(Routine, {
      employeeId: jamie.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
      body: "Write the digest.",
    });
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "@jamie generic question", rec, {
      refs: [{ kind: "routine", id: routine.id }],
      exclude: [`routine:${routine.id}`],
    });

    assert.deepEqual(rec.users[0].context?.items, []);
  });
});

// ───────────────────────────── Grants ─────────────────────────────

describe("Grants decide what each employee is shown", () => {
  test("an employee with a mailbox Grant reads the thread; one without learns only that an email is open", async () => {
    const reader = await employee("reader", "Reader");
    const outsider = await employee("outsider", "Outsider");
    const { account, thread } = await mailFixture();
    await insert(EmployeeMailAccountGrant, {
      accountId: account.id,
      employeeId: reader.id,
      accessLevel: "draft",
    });
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@reader @outsider what's the budget?", recorder(), {
      refs: [mailRef(thread)],
      runChat: seam(calls),
    });

    const [toReader, toOutsider] = calls;
    assert.equal(toReader.employeeId, reader.id);
    assert.match(toReader.prompt, /confidential budget is 48,000 USD/);
    assert.ok(toReader.options.extraToolset?.includes("read_mail_attachment"));
    assert.equal(toReader.options.mailThreadId, thread.id);
    assert.match(toReader.options.extraSystem ?? "", /access level on this mailbox is "draft"/);

    assert.equal(toOutsider.employeeId, outsider.id);
    assert.doesNotMatch(toOutsider.prompt, /48,000/);
    assert.doesNotMatch(toOutsider.prompt, /Quarterly pricing/, "not even the subject");
    assert.match(toOutsider.prompt, /## Email \(withheld\)/);
    assert.match(toOutsider.prompt, /no Grant on this mailbox/);
    assert.ok(!toOutsider.options.extraToolset?.includes("read_mail_attachment"));
    assert.equal(toOutsider.options.mailThreadId, null);
    // The reader's answer to the same message may quote the email.
    assert.doesNotMatch(toOutsider.prompt, /Reader answered|already answered this message:/);
    assert.match(toOutsider.prompt, /Reader also answered, with records in view you have no Grant to read/);
  });

  test("an answer written with a mailbox in view is withheld from a later employee without that Grant", async () => {
    const reader = await employee("reader", "Reader");
    await employee("outsider", "Outsider");
    const { account, thread } = await mailFixture();
    await insert(EmployeeMailAccountGrant, {
      accountId: account.id,
      employeeId: reader.id,
      accessLevel: "read",
    });
    const convo = await conversation();
    await turn(convo, "@reader what's the budget?", recorder(), {
      refs: [mailRef(thread)],
      runChat: async () => chatResult("They have 48,000 USD."),
    });
    const calls: Call[] = [];

    await turn(convo, "@outsider what did they say?", recorder(), { runChat: seam(calls) });

    const replay = calls[0].history;
    assert.equal(replay.length, 2);
    assert.equal(replay[0].role, "user");
    assert.match(replay[0].content, /what's the budget\?/, "the Member's own words still replay");
    assert.match(replay[0].content, /with an email you cannot see open/);
    assert.doesNotMatch(replay[0].content, /Quarterly pricing/);
    assert.equal(replay[1].role, "assistant");
    assert.doesNotMatch(replay[1].content, /48,000/);
    assert.match(replay[1].content, /answer withheld/);
  });

  test("the same answer replays in full to an employee that holds the Grant", async () => {
    const reader = await employee("reader", "Reader");
    const peer = await employee("peer", "Peer");
    const { account, thread } = await mailFixture();
    for (const e of [reader, peer]) {
      await insert(EmployeeMailAccountGrant, {
        accountId: account.id,
        employeeId: e.id,
        accessLevel: "read",
      });
    }
    const convo = await conversation();
    await turn(convo, "@reader what's the budget?", recorder(), {
      refs: [mailRef(thread)],
      runChat: async () => chatResult("They have 48,000 USD."),
    });
    const calls: Call[] = [];

    await turn(convo, "@peer agree?", recorder(), { runChat: seam(calls) });

    const replay = calls[0].history;
    assert.match(replay[0].content, /Email: Quarterly pricing for Acme/);
    assert.equal(replay[1].content, "[Reader answered] They have 48,000 USD.");
  });

  test("a failed answer keeps its Grant boundary too", async () => {
    const reader = await employee("reader", "Reader");
    await employee("outsider", "Outsider");
    const { account, thread } = await mailFixture();
    await insert(EmployeeMailAccountGrant, {
      accountId: account.id,
      employeeId: reader.id,
      accessLevel: "read",
    });
    const convo = await conversation();
    await turn(convo, "@reader go", recorder(), {
      refs: [mailRef(thread)],
      runChat: async () => {
        throw new Error("mid-answer failure about 48,000 USD");
      },
    });

    const failed = (await rows()).find((m) => m.role === "assistant");
    assert.equal(failed?.status, "error");
    assert.match(failed?.contextJson ?? "", /mail:/);
    const calls: Call[] = [];
    await turn(convo, "@outsider hi", recorder(), { runChat: seam(calls) });
    assert.ok(
      calls[0].history.every((t) => !t.content.includes("48,000")),
      "an error row is never replayed as speech",
    );
  });

  test("the composer preview names who would not be shown which record", async () => {
    const holder = await employee("holder", "Holder");
    const lacker = await employee("lacker", "Lacker");
    await insert(EmployeeFinanceGrant, {
      companyId: COMPANY_ID,
      employeeId: holder.id,
      accessLevel: "read",
    });
    const customer = await insert(Customer, {
      companyId: COMPANY_ID,
      name: "Acme Holdings",
      slug: "acme",
    });

    const preview = await previewAskAiContext({
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      member: OWNER,
      refs: [{ kind: "customer", id: "acme" }],
    });

    assert.deepEqual(
      preview.items.map((i) => [i.kind, i.id]),
      [["customer", customer.id]],
    );
    assert.deepEqual(preview.withheld, { [lacker.id]: [`customer:${customer.id}`] });
  });
});

// ───────────────────────────── replay ─────────────────────────────

describe("the replay", () => {
  test("never replays an answer still owed or a failure as speech", async () => {
    const alex = await employee("alex", "Alex");
    const convo = await conversation();
    const userRow = await insert(AskAiMessage, {
      companyId: COMPANY_ID,
      conversationId: convo.id,
      role: "user",
      content: "earlier question",
      contextJson: "",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insert(AskAiMessage, {
      companyId: COMPANY_ID,
      conversationId: convo.id,
      role: "assistant",
      turnId: userRow.id,
      employeeId: alex.id,
      content: "",
      status: "working",
      createdAt: new Date(Date.now() - 59_000),
    });
    const calls: Call[] = [];

    await turn(convo, "@alex any update?", recorder(), { runChat: seam(calls) });

    assert.deepEqual(
      calls[0].history.map((t) => t.content),
      ["earlier question"],
    );
  });

  test("attributes an earlier answer to the employee that gave it", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const convo = await conversation();
    await turn(convo, "@alex first", recorder(), {
      runChat: async () => chatResult("Alex's view."),
    });
    const calls: Call[] = [];

    await turn(convo, "@sam second", recorder(), { runChat: seam(calls) });

    assert.deepEqual(
      calls[0].history.map((t) => [t.role, t.content]),
      [
        ["user", "[Sent from Home (/c/ask-ai-co)]\n@alex first"],
        ["assistant", "[Alex answered] Alex's view."],
      ],
    );
    assert.ok(alex && sam);
  });
});

// ───────────────────────────── files and suggestions ─────────────────────────────

describe("files and suggestions", () => {
  async function companyRow(): Promise<Company> {
    return insert(Company, {
      id: COMPANY_ID,
      name: "Ask AI files",
      slug: `ask-ai-files-${randomUUID()}`,
      ownerId: USER_ID,
    });
  }

  test("binds the Member's own upload to their turn and inlines it for the employee", async () => {
    const company = await companyRow();
    await employee("alex", "Alex");
    try {
      const upload = await recordAttachmentBytes({
        companyId: company.id,
        companySlug: company.slug,
        filename: "w9.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("Taxpayer name: HackerBay, Inc."),
        uploadedByUserId: USER_ID,
      });
      const convo = await conversation();
      const calls: Call[] = [];
      const rec = recorder();

      await turn(convo, "@alex here is our W-9", rec, {
        attachmentIds: [upload.id],
        runChat: seam(calls),
      });

      assert.deepEqual(
        rec.users[0].attachments.map((a) => a.filename),
        ["w9.txt"],
      );
      assert.match(calls[0].prompt, new RegExp(`\\[Attachment id=${upload.id}`));
      assert.match(calls[0].prompt, /Taxpayer name: HackerBay, Inc\./);
    } finally {
      fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
    }
  });

  test("never binds somebody else's upload, even inside the same company", async () => {
    const company = await companyRow();
    await employee("alex", "Alex");
    try {
      const theirs = await recordAttachmentBytes({
        companyId: company.id,
        companySlug: company.slug,
        filename: "payroll.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("salaries"),
        uploadedByUserId: "someone_else",
      });
      const convo = await conversation();
      const rec = recorder();

      await turn(convo, "@alex read this", rec, { attachmentIds: [theirs.id] });

      assert.deepEqual(rec.users[0].attachments, []);
      const row = await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: theirs.id });
      assert.equal(row.messageId, null);
    } finally {
      fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
    }
  });

  test("a file the employee produced lands on its own answer", async () => {
    const company = await companyRow();
    await employee("alex", "Alex");
    try {
      const produced = await recordAttachmentBytes({
        companyId: company.id,
        companySlug: company.slug,
        filename: "summary.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from("%PDF"),
        uploadedByUserId: null,
      });
      const convo = await conversation();
      const rec = recorder();

      await turn(convo, "@alex write it up", rec, {
        runChat: async () => chatResult("Attached.", "ok", { attachmentIds: [produced.id] }),
      });

      const answer = rec.assistant.at(-1);
      assert.deepEqual(
        answer?.attachments.map((a) => a.filename),
        ["summary.pdf"],
      );
      const row = await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: produced.id });
      assert.equal(row.messageId, answer?.id);
    } finally {
      fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
    }
  });

  test("keeps email suggestions only for a mailbox the employee was shown here", async () => {
    const reader = await employee("reader", "Reader");
    const { account, thread } = await mailFixture();
    await insert(EmployeeMailAccountGrant, {
      accountId: account.id,
      employeeId: reader.id,
      accessLevel: "draft",
    });
    const convo = await conversation();
    const rec = recorder();

    await turn(convo, "@reader triage this", rec, {
      refs: [mailRef(thread)],
      runChat: async () =>
        chatResult("Suggested.", "ok", {
          sidecars: {
            "mail.suggestions": [
              { id: "s1", kind: "thread_action", label: "Archive", accountId: account.id },
              { id: "s2", kind: "thread_action", label: "Elsewhere", accountId: testId("other") },
            ],
          },
        }),
    });

    const answer = rec.assistant.at(-1);
    assert.deepEqual(
      answer?.suggestions.map((s) => s.id),
      ["s1"],
    );

    const stamped = await markAskAiSuggestionExecuted(convo, answer!.id, "s1");
    assert.ok(stamped);
    const dto = serializeAskAiMessage(stamped);
    assert.ok(dto.suggestions[0].executedAt, "a run suggestion cannot be armed again");
    assert.equal(await markAskAiSuggestionExecuted(convo, answer!.id, "missing"), null);
  });
});

// ───────────────────────────── models ─────────────────────────────

async function connectedModel(employeeId: string, model: string, isActive = false) {
  return insert(AIModel, {
    employeeId,
    provider: "anthropic",
    model,
    authMode: "apikey",
    isActive,
    configJson: JSON.stringify({ apiKeyEncrypted: "ciphertext" }),
  });
}

describe("models", () => {
  test("a single answer runs on the picked model and records it", async () => {
    const alex = await employee("alex", "Alex");
    await connectedModel(alex.id, "claude-active", true);
    const picked = await connectedModel(alex.id, "claude-picked");
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@alex hi", recorder(), { modelId: picked.id, runChat: seam(calls) });

    assert.equal(calls[0].options.modelId, picked.id);
    const answer = (await rows()).find((m) => m.role === "assistant");
    assert.equal(answer?.modelId, picked.id);
    assert.equal(await lastAskAiModelId(convo.id, alex.id), picked.id);
  });

  test("a pick that belongs to another employee falls back to the employee's own model", async () => {
    const alex = await employee("alex", "Alex");
    const sam = await employee("sam", "Sam");
    const active = await connectedModel(alex.id, "claude-active", true);
    const samsModel = await connectedModel(sam.id, "sam-model", true);
    const convo = await conversation();
    const calls: Call[] = [];

    await turn(convo, "@alex hi", recorder(), { modelId: samsModel.id, runChat: seam(calls) });

    assert.equal(calls[0].options.modelId, active.id);
  });

  test("the roster offers only connected models, active first", async () => {
    const alex = await employee("alex", "Alex");
    await connectedModel(alex.id, "second");
    await connectedModel(alex.id, "first", true);
    await insert(AIModel, {
      employeeId: alex.id,
      provider: "openai",
      model: "unconfigured",
      authMode: "apikey",
      isActive: false,
      configJson: "{}",
    });

    const entry = (await askAiRoster(COMPANY_ID)).find((r) => r.id === alex.id);

    assert.deepEqual(
      entry?.models.map((m) => m.model),
      ["first", "second"],
    );
    assert.equal(entry?.hasModel, true);
  });
});

// ───────────────────────────── conversations ─────────────────────────────

describe("conversations", () => {
  test("belong to the Member who started them", async () => {
    const mine = await conversation();
    await createAskAiConversation(COMPANY_ID, "another_member");

    assert.deepEqual(
      (await listAskAiConversations(COMPANY_ID, USER_ID)).map((c) => c.id),
      [mine.id],
    );
    assert.equal(await getAskAiConversation(COMPANY_ID, "another_member", mine.id), null);
    assert.equal(await getAskAiConversation("co_other", USER_ID, mine.id), null);
  });

  test("deleting one removes its turns and releases its files", async () => {
    const company = await insert(Company, {
      id: COMPANY_ID,
      name: "Ask AI delete",
      slug: `ask-ai-delete-${randomUUID()}`,
      ownerId: USER_ID,
    });
    await employee("alex", "Alex");
    try {
      const upload = await recordAttachmentBytes({
        companyId: company.id,
        companySlug: company.slug,
        filename: "notes.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("notes"),
        uploadedByUserId: USER_ID,
      });
      const convo = await conversation();
      const keep = await conversation();
      await turn(convo, "@alex read", recorder(), { attachmentIds: [upload.id] });
      await turn(keep, "@alex keep me", recorder());

      await deleteAskAiConversation(convo);

      assert.equal(await getAskAiConversation(COMPANY_ID, USER_ID, convo.id), null);
      assert.equal((await rows(convo.id)).length, 0);
      assert.equal((await rows(keep.id)).length, 2, "other conversations are untouched");
      const file = await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: upload.id });
      assert.equal(file.messageId, null);
    } finally {
      fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── routines ─────────────────────────────

describe("helping with a Routine", () => {
  test("a finished answer with someone else's Routine in view counts as participation", async () => {
    const owner = await employee("jamie", "Jamie");
    const helper = await employee("alex", "Alex");
    const routine = await insert(Routine, {
      employeeId: owner.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
      body: "Write the digest.",
    });
    const convo = await conversation();

    await turn(convo, "@alex how could this brief be better?", recorder(), {
      refs: [{ kind: "routine", id: routine.id }],
      runChat: async () => chatResult("Tighten the audience."),
    });

    const answer = (await rows()).find((m) => m.role === "assistant");
    assert.equal(answer?.contextKind, "routine");
    assert.equal(answer?.contextId, routine.id);
    const participation = await findRoutineParticipation(COMPANY_ID, helper.id, routine.id);
    assert.equal(participation?.receipt.id, answer?.id);
    const listed = await listParticipatingRoutines(COMPANY_ID, helper.id);
    assert.deepEqual(
      listed.items.map((i) => i.routine.id),
      [routine.id],
    );
  });

  test("a failed answer does not, and neither does an answer about something else", async () => {
    const owner = await employee("jamie", "Jamie");
    const helper = await employee("alex", "Alex");
    const routine = await insert(Routine, {
      employeeId: owner.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
      body: "Write the digest.",
    });
    const convo = await conversation();
    await turn(convo, "@alex help", recorder(), {
      refs: [{ kind: "routine", id: routine.id }],
      runChat: async () => {
        throw new Error("down");
      },
    });
    await turn(convo, "@alex unrelated", recorder());

    assert.equal(await findRoutineParticipation(COMPANY_ID, helper.id, routine.id), null);
  });
});

// ───────────────────────────── recovery ─────────────────────────────

describe("interrupted turns", () => {
  test("a restart closes working and queued answers and frees their leases", async () => {
    const alex = await employee("alex", "Alex");
    const convo = await conversation();
    const working = await insert(AskAiMessage, {
      companyId: COMPANY_ID,
      conversationId: convo.id,
      role: "assistant",
      employeeId: alex.id,
      content: "",
      status: "working",
      createdAt: new Date(),
    });
    const queued = await insert(AskAiMessage, {
      companyId: COMPANY_ID,
      conversationId: convo.id,
      role: "assistant",
      employeeId: alex.id,
      content: "",
      status: "queued",
      createdAt: new Date(),
    });
    const done = await insert(AskAiMessage, {
      companyId: COMPANY_ID,
      conversationId: convo.id,
      role: "assistant",
      employeeId: alex.id,
      content: "Finished.",
      status: "ok",
      createdAt: new Date(),
    });
    await insert(WorkloadLease, {
      companyId: COMPANY_ID,
      employeeId: alex.id,
      kind: "chat",
      ownerKey: working.id,
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
    });
    assert.equal(await askAiTurnInFlight(convo.id), true);

    assert.equal(await finalizeInterruptedAskAiTurns(), 2);

    const after = new Map((await rows()).map((r) => [r.id, r]));
    assert.equal(after.get(working.id)?.status, "error");
    assert.equal(after.get(queued.id)?.status, "error");
    assert.match(after.get(working.id)?.content ?? "", /restarted/);
    assert.equal(after.get(done.id)?.status, "ok");
    assert.equal(await AppDataSource.getRepository(WorkloadLease).count(), 0);
    assert.equal(await askAiTurnInFlight(convo.id), false);
    assert.equal(await finalizeInterruptedAskAiTurns(), 0);
  });
});

test("pasted screenshots are sent natively and replayed for follow-up questions", async () => {
  const company = await insert(Company, {
    id: COMPANY_ID,
    name: "Ask AI images",
    slug: `ask-ai-images-${randomUUID()}`,
    ownerId: USER_ID,
  });
  await employee("alex", "Alex");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    const screenshot = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "screen.png",
      mimeType: "image/png",
      bytes,
      uploadedByUserId: USER_ID,
    });
    const expected = [
      {
        mimeType: "image/png",
        data: bytes.toString("base64"),
        sourceLabel: `[Attached image id=${screenshot.id} filename=${JSON.stringify(screenshot.filename)}]`,
      },
    ];
    const convo = await conversation();
    await turn(convo, "@alex ", recorder(), {
      attachmentIds: [screenshot.id],
      runChat: async (_c, _e, prompt, history, _chunk, options) => {
        assert.deepEqual(options?.images, expected);
        assert.equal(history.length, 0);
        assert.ok(!prompt.includes(bytes.toString("base64")));
        return chatResult("I can see it.");
      },
    });
    await turn(convo, "what colour was it?", recorder(), {
      runChat: async (_c, _e, _prompt, history, _chunk, options) => {
        assert.equal(options?.images, undefined);
        assert.deepEqual(history.find((t) => t.role === "user")?.images, expected);
        return chatResult("White.");
      },
    });
  } finally {
    fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
  }
});
