import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrDismissal } from "../db/entities/TldrDismissal.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  collectTldrSources,
  detachEmployeeFromTldrs,
  dismissTldr,
  dispatchDueTldrs,
  generateTldrNow,
  getTldrSettings,
  listHomeTldrs,
  listTldrs,
  nextTldrRunAt,
  updateTldrSettings,
  type TldrServiceDependencies,
} from "./tldrs.js";
import { deleteUserCascade } from "./userDelete.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const NOW = new Date("2026-08-20T12:00:00.000Z");

type Fixture = {
  company: Company;
  employee: AIEmployee;
  owner: User;
  member: User;
  model: AIModel;
};

async function fixture(): Promise<Fixture> {
  const owner = await insert(User, {
    email: "owner-tldr@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  const member = await insert(User, {
    email: "member-tldr@example.test",
    name: "Member",
    passwordHash: "x",
  });
  const company = await insert(Company, {
    name: "Acme TLDR",
    slug: "acme-tldr",
    ownerId: owner.id,
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Chief of staff",
    soulBody: "Be clear and factual.",
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
  return { company, employee, owner, member, model };
}

async function message(
  channel: Channel,
  content: string,
  createdAt: Date,
  deletedAt: Date | null = null,
): Promise<ChannelMessage> {
  return insert(ChannelMessage, {
    channelId: channel.id,
    authorKind: "system",
    authorUserId: null,
    authorEmployeeId: null,
    authorName: "Status feed",
    content,
    parentMessageId: null,
    editedAt: null,
    deletedAt,
    createdAt,
  });
}

const submittingAgent =
  (
    inspect?: (serializedPrompt: string, toolNames: string[]) => void,
  ): NonNullable<TldrServiceDependencies["runRestricted"]> =>
  async (params) => {
    inspect?.(
      JSON.stringify(params.messages),
      params.tools.map((tool) => tool.name),
    );
    const result = await params.tools[0].run({
      title: "Daily progress",
      summary: "The team shipped the important work.",
      body: "## Done\n\nDeployment completed. token=generated-secret",
    });
    assert.equal(result.isError, undefined);
    return { status: "ok", finalText: "", steps: 1 };
  };

describe("TLDR source boundary", () => {
  test("uses public messages and company AI work only, with caps and credential redaction", async () => {
    const { company, employee, owner } = await fixture();
    const otherCompany = await insert(Company, {
      name: "Other TLDR company",
      slug: "other-tldr-company",
      ownerId: owner.id,
    });
    const otherEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Other Rey",
      slug: "other-rey",
      role: "Private operator",
      soulBody: "",
    });
    const publicChannel = await insert(Channel, {
      companyId: company.id,
      kind: "public",
      name: "General",
      slug: "general",
    });
    const privateChannel = await insert(Channel, {
      companyId: company.id,
      kind: "private",
      name: "Leadership",
      slug: "leadership",
    });
    const dm = await insert(Channel, {
      companyId: company.id,
      kind: "dm",
      name: null,
      slug: null,
    });
    const otherPublic = await insert(Channel, {
      companyId: otherCompany.id,
      kind: "public",
      name: "Other general",
      slug: "other-general",
    });
    await message(
      publicChannel,
      "Shipped billing with sk-proj-ABC123 github_pat_ABC123 AKIAABCDEFGHIJKLMNOP",
      new Date(NOW.getTime() - 30_000),
    );
    await message(privateChannel, "private roadmap", new Date(NOW.getTime() - 20_000));
    await message(dm, "direct secret", new Date(NOW.getTime() - 10_000));
    await message(otherPublic, "other company message", new Date(NOW.getTime() - 10_000));
    await message(publicChannel, "deleted public message", new Date(NOW.getTime() - 5_000), NOW);
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "note",
      title: "Customer launch",
      body: "The launch is green; Authorization: Bearer journal-secret",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 25_000),
    });
    await insert(JournalEntry, {
      employeeId: otherEmployee.id,
      kind: "note",
      title: "Other company journal",
      body: "Must stay isolated.",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 24_000),
    });
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Release check",
      slug: "release-check",
      cronExpr: "0 * * * *",
      body: "",
    });
    const completed = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(NOW.getTime() - 60_000),
      finishedAt: new Date(NOW.getTime() - 15_000),
      status: "completed",
      logContent: "Released successfully with github_pat_RUNSECRET",
      exitCode: 0,
    });
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "run",
      title: "Duplicate run summary",
      body: "Already represented by the bounded Run tail",
      runId: completed.id,
      routineId: routine.id,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 14_000),
    });
    await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(NOW.getTime() - 50_000),
      finishedAt: new Date(NOW.getTime() - 12_000),
      status: "timeout",
      logContent: "Timed out after recording token=timeout-secret",
      exitCode: null,
    });
    const otherRoutine = await insert(Routine, {
      employeeId: otherEmployee.id,
      name: "Other company routine",
      slug: "other-company-routine",
      cronExpr: "0 * * * *",
      body: "",
    });
    await insert(Run, {
      routineId: otherRoutine.id,
      startedAt: new Date(NOW.getTime() - 50_000),
      finishedAt: new Date(NOW.getTime() - 12_000),
      status: "completed",
      logContent: "other company Run output",
      exitCode: 0,
    });
    await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(NOW.getTime() - 10_000),
      finishedAt: null,
      status: "running",
      logContent: "still private until terminal",
      exitCode: null,
    });

    const sources = await collectTldrSources(
      company.id,
      new Date(NOW.getTime() - 60 * 60_000),
      NOW,
    );

    assert.deepEqual(sources.stats, {
      journalEntries: 1,
      routineRuns: 2,
      channelMessages: 1,
      channels: 1,
    });
    const serialized = JSON.stringify(sources);
    assert.match(serialized, /Shipped billing/);
    assert.match(serialized, /Customer launch/);
    assert.match(serialized, /Timed out/);
    assert.doesNotMatch(
      serialized,
      /private roadmap|direct secret|deleted public|still private|other company/i,
    );
    assert.doesNotMatch(
      serialized,
      /ABC123|AKIAABCDEFGHIJKLMNOP|journal-secret|RUNSECRET|timeout-secret/,
    );
    assert.match(serialized, /redacted/);
  });
});

describe("TLDR generation, history, and acknowledgements", () => {
  test("invokes only submit_tldr, stores a ready digest, dismisses per Member, and skips empty windows", async () => {
    const { company, employee, owner, member } = await fixture();
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "note",
      title: "Quarterly plan",
      body: "The plan was approved.",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    await updateTldrSettings(
      company.id,
      { enabled: true, cadence: "daily", employeeId: employee.id },
      new Date(NOW.getTime() - 60_000),
    );

    let inspected = false;
    const tldr = await generateTldrNow(company.id, {
      now: () => NOW,
      runRestricted: submittingAgent((prompt, toolNames) => {
        inspected = true;
        assert.deepEqual(toolNames, ["submit_tldr"]);
        assert.match(prompt, /Quarterly plan/);
      }),
    });
    assert.ok(tldr);
    assert.equal(inspected, true);
    assert.equal(tldr.status, "ready");
    assert.doesNotMatch(tldr.body, /generated-secret/);
    assert.deepEqual(JSON.parse(tldr.sourceStatsJson), {
      journalEntries: 1,
      routineRuns: 0,
      channelMessages: 0,
      channels: 0,
    });

    const ownerHistory = await listTldrs({
      companyId: company.id,
      userId: owner.id,
      limit: 30,
    });
    assert.equal(ownerHistory.total, 1);
    assert.equal(ownerHistory.unreadCount, 1);
    assert.equal(ownerHistory.items[0].employee.name, "Rey");
    assert.equal(ownerHistory.items[0].dismissed, false);
    await dismissTldr({ companyId: company.id, tldrId: tldr.id, userId: owner.id });
    await dismissTldr({ companyId: company.id, tldrId: tldr.id, userId: owner.id });
    assert.equal((await listHomeTldrs({ companyId: company.id, userId: owner.id })).unreadCount, 0);
    assert.equal(
      (await listHomeTldrs({ companyId: company.id, userId: member.id })).unreadCount,
      1,
    );

    const settingsAfterReady = await getTldrSettings(company.id);
    assert.equal(settingsAfterReady.lastCoveredAt, NOW.toISOString());
    assert.equal(settingsAfterReady.lastGeneratedAt, NOW.toISOString());
    assert.equal(settingsAfterReady.lastAttemptAt, NOW.toISOString());

    const emptyAt = new Date(NOW.getTime() + 60 * 60_000);
    const empty = await generateTldrNow(company.id, { now: () => emptyAt });
    assert.equal(empty, null);
    const settingsAfterEmpty = await getTldrSettings(company.id);
    assert.equal(settingsAfterEmpty.lastCoveredAt, emptyAt.toISOString());
    assert.equal(settingsAfterEmpty.lastGeneratedAt, NOW.toISOString());
    assert.equal(settingsAfterEmpty.lastAttemptAt, emptyAt.toISOString());
    assert.equal(await AppDataSource.getRepository(Tldr).count(), 1);
  });

  test("keeps the original coverage window across a failed scheduled retry", async () => {
    const { company, employee } = await fixture();
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "note",
      title: "Important event",
      body: "Must survive a failed attempt.",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    await updateTldrSettings(
      company.id,
      { enabled: true, cadence: "four_hours", employeeId: employee.id },
      NOW,
    );
    await AppDataSource.getRepository(TldrSettings).update(
      { companyId: company.id },
      { nextRunAt: NOW },
    );

    const failedDispatch = await dispatchDueTldrs(NOW, {
      now: () => NOW,
      runRestricted: async () => {
        throw new Error("temporary model outage");
      },
    });
    assert.equal(failedDispatch.started, 1);
    await assert.rejects(failedDispatch.completions[0], /temporary model outage/);
    const failed = await AppDataSource.getRepository(Tldr).findOneByOrFail({ status: "failed" });
    const afterFailure = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(afterFailure.lastCoveredAt, null);
    assert.equal(
      afterFailure.nextRunAt?.toISOString(),
      new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    );

    const retryAt = afterFailure.nextRunAt!;
    const retry = await dispatchDueTldrs(retryAt, {
      now: () => retryAt,
      runRestricted: submittingAgent(),
    });
    await retry.completions[0];
    const ready = await AppDataSource.getRepository(Tldr).findOneByOrFail({ status: "ready" });
    assert.equal(ready.periodStart.toISOString(), failed.periodStart.toISOString());
  });

  test("rejects settings changes and employee deletion that race an active generation", async () => {
    const { company, employee } = await fixture();
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "note",
      title: "Work in flight",
      body: "Source",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    await updateTldrSettings(
      company.id,
      { enabled: true, cadence: "daily", employeeId: employee.id },
      NOW,
    );
    await AppDataSource.getRepository(TldrSettings).update(
      { companyId: company.id },
      { nextRunAt: NOW },
    );
    const generation = generateTldrNow(company.id, {
      now: () => NOW,
      runRestricted: async (params) => {
        const scheduled = await dispatchDueTldrs(NOW, { now: () => NOW });
        assert.equal(scheduled.started, 0);
        assert.ok(
          (
            await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
              companyId: company.id,
            })
          ).activeTldrId,
          "a stale scheduled due row must not erase the manual generation claim",
        );
        await assert.rejects(
          updateTldrSettings(
            company.id,
            { enabled: false, cadence: "daily", employeeId: employee.id },
            NOW,
          ),
          /being prepared/,
        );
        await detachEmployeeFromTldrs(company.id, employee.id, NOW);
        await params.tools[0].run({ title: "Too late", summary: "Too late", body: "Too late" });
        return { status: "ok", finalText: "", steps: 1 };
      },
    });
    await assert.rejects(generation, /settings changed/);
    const settings = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(settings.enabled, false);
    assert.equal(settings.employeeId, null);
    assert.equal(await AppDataSource.getRepository(Tldr).countBy({ status: "ready" }), 0);
  });

  test("does not turn a disconnected scheduled model into a five-minute retry loop", async () => {
    const { company, employee, model } = await fixture();
    await insert(JournalEntry, {
      employeeId: employee.id,
      kind: "system",
      title: "Model state",
      body: "A source exists so generation reaches model validation.",
      runId: null,
      routineId: null,
      authorUserId: null,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    await updateTldrSettings(
      company.id,
      { enabled: true, cadence: "four_hours", employeeId: employee.id },
      NOW,
    );
    await AppDataSource.getRepository(TldrSettings).update(
      { companyId: company.id },
      { nextRunAt: NOW },
    );
    await AppDataSource.getRepository(AIModel).update({ id: model.id }, { configJson: "{}" });

    const dispatch = await dispatchDueTldrs(NOW, { now: () => NOW });
    await assert.rejects(dispatch.completions[0], /connected active AI Model/);
    const settings = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(settings.nextRunAt?.toISOString(), nextTldrRunAt("four_hours", NOW).toISOString());
  });

  test("deletes a departing Member's acknowledgements without deleting TLDR history", async () => {
    const { company, employee, member } = await fixture();
    const tldr = await insert(Tldr, {
      companyId: company.id,
      employeeId: employee.id,
      employeeName: employee.name,
      employeeSlug: employee.slug,
      employeeRole: employee.role,
      employeeAvatarKey: null,
      status: "ready",
      triggerKind: "manual",
      periodStart: new Date(NOW.getTime() - 60 * 60_000),
      periodEnd: NOW,
      title: "Persistent history",
      summary: "The briefing remains for the company.",
      body: "Body",
      sourceStatsJson: JSON.stringify({
        journalEntries: 1,
        routineRuns: 0,
        channelMessages: 0,
        channels: 0,
      }),
      errorMessage: "",
      finishedAt: NOW,
    });
    await dismissTldr({ companyId: company.id, tldrId: tldr.id, userId: member.id });
    assert.equal(await AppDataSource.getRepository(TldrDismissal).count(), 1);

    await deleteUserCascade({ userId: member.id });

    assert.equal(await AppDataSource.getRepository(TldrDismissal).count(), 0);
    assert.equal(await AppDataSource.getRepository(Tldr).countBy({ id: tldr.id }), 1);
  });
});
