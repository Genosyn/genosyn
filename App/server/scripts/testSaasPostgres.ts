import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { Client } from "pg";
import { config } from "../../config.js";

const CHILD_TIMEOUT_MS = 90_000;
const children = new Set<ChildProcess>();
const stop = new AbortController();
const abort = () => stop.abort(new Error("Postgres smoke interrupted"));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

function localPostgresUrl(raw: string | undefined): URL {
  if (!raw)
    throw new Error("Set GENOSYN_TEST_POSTGRES_URL to a disposable local Postgres service.");
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Postgres smoke accepts only literal loopback hosts, without URL query options.",
    );
  }
  return url;
}

function deadline<T>(work: Promise<T>, label: string, timeoutMs = CHILD_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stop.abort(new Error(`${label} timed out`)), timeoutMs);
    const interrupted = () => reject(stop.signal.reason);
    stop.signal.addEventListener("abort", interrupted, { once: true });
    if (stop.signal.aborted) interrupted();
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", interrupted);
    });
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  await deadline(
    (async () => {
      while (!(await check())) {
        stop.signal.throwIfAborted();
        await delay(10, undefined, { signal: stop.signal });
      }
    })(),
    label,
  );
}

function configure(url: URL, dataDir: string): void {
  // Entity column types and migration paths are chosen at module evaluation.
  // No datasource or service imports are allowed above this assignment.
  Object.assign(config.db, { driver: "postgres", postgresUrl: url.toString() });
  Object.assign(config.security, {
    multiTenant: true,
    encryptionSecret: "test-only-postgres-encryption-secret-00000000000000000000000000000000",
  });
  Object.assign(config, {
    dataDir,
    sessionSecret: "test-only-postgres-session-secret-000000000000000000000000000000000",
  });
}

function parentMessage(command: string): Promise<void> {
  return deadline(
    new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (message !== command) return;
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
        resolve();
      };
      const onDisconnect = () => reject(new Error("Smoke parent disconnected"));
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
    }),
    `Parent ${command}`,
  );
}

async function childMain(mode: string): Promise<void> {
  const url = localPostgresUrl(process.env.GENOSYN_TEST_POSTGRES_URL);
  const dataDir = process.env.GENOSYN_TEST_DATA_DIR;
  if (!process.send || !dataDir || !/^\/genosyn_saas_smoke_[a-f0-9]{32}$/.test(url.pathname)) {
    throw new Error("Smoke child requires its parent's isolated database and IPC channel.");
  }
  configure(url, dataDir);
  const { AppDataSource, runMigrationsExclusively } = await import("../db/datasource.js");
  try {
    await AppDataSource.initialize();
    if (mode === "migrate") {
      const start = parentMessage("start");
      process.send("ready");
      await start;
      await runMigrationsExclusively();
    } else if (mode === "hold-capacity") {
      const { overrideRuntimeSettingsForTests } = await import("../services/runtimeSettings.js");
      const { withCompanyAgentCapacity } = await import("../services/companyAgentCapacity.js");
      overrideRuntimeSettingsForTests({ agent: { maxConcurrentTurnsPerCompany: 2 } });
      const employeeId = process.env.GENOSYN_TEST_EMPLOYEE_ID;
      assert.ok(employeeId);
      await withCompanyAgentCapacity(employeeId, stop.signal, async (signal) => {
        const release = parentMessage("release");
        process.send!("ready");
        await release;
        signal?.throwIfAborted();
      });
    } else if (mode === "accept-manual-routines") {
      const { AIEmployee } = await import("../db/entities/AIEmployee.js");
      const { Routine } = await import("../db/entities/Routine.js");
      const { startManualRoutineRun } = await import("../services/runner.js");
      const { stopRoutineQueue } = await import("../services/routineQueue.js");
      // Acceptance must finish without waiting for model work. Keep the durable
      // queued rows stable while independent processes race the actual helper.
      stopRoutineQueue();
      const employeeId = process.env.GENOSYN_TEST_EMPLOYEE_ID;
      assert.ok(employeeId);
      const employee = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
        id: employeeId,
      });
      const selectedIds: unknown = JSON.parse(process.env.GENOSYN_TEST_ROUTINE_IDS ?? "[]");
      assert.ok(
        Array.isArray(selectedIds) &&
          selectedIds.length > 0 &&
          selectedIds.every((id) => typeof id === "string"),
      );
      const selected = await Promise.all(
        selectedIds.map((id: string) =>
          AppDataSource.getRepository(Routine).findOneByOrFail({ id, employeeId }),
        ),
      );
      const start = parentMessage("start");
      process.send("ready");
      await start;
      await Promise.all(
        selected.map(async (routine) => {
          const run = await startManualRoutineRun(routine, employee.companyId);
          assert.equal(run.routineId, routine.id);
          process.send!({ kind: "manual-run-accepted", routineId: routine.id, runId: run.id });
        }),
      );
    } else if (mode === "drain-model-capacity") {
      const { Run } = await import("../db/entities/Run.js");
      const { agentRuntime } = await import("../services/agent/runtime.js");
      const { dispatchQueuedRoutineRuns, waitForRoutineQueueIdle } = await import(
        "../services/routineQueue.js"
      );
      const employeeId = process.env.GENOSYN_TEST_EMPLOYEE_ID;
      assert.ok(employeeId);
      agentRuntime.run = async () => {
        const [running] = await AppDataSource.getRepository(Run).findBy({
          employeeId,
          status: "running",
        });
        assert.ok(running, "A started Run must be visible to every process");
        const finish = parentMessage(`finish-run:${running.id}`);
        process.send!({ kind: "routine-started", runId: running.id });
        await finish;
        return { finalText: "Done", steps: 1, stopReason: "end_turn" };
      };
      const start = parentMessage("start");
      process.send!("ready");
      await start;
      // Keep offering queued work, as the heartbeat would, until none remains.
      while (await AppDataSource.getRepository(Run).existsBy({ employeeId, status: "queued" })) {
        await dispatchQueuedRoutineRuns();
        await waitForRoutineQueueIdle();
        await delay(250);
      }
      await waitForRoutineQueueIdle();
    } else if (mode === "drain-routine-queue" || mode === "exercise-routine-admission") {
      const { Run } = await import("../db/entities/Run.js");
      const { agentRuntime } = await import("../services/agent/runtime.js");
      const { dispatchQueuedRoutineRuns, registerQueuedRun, waitForRoutineQueueIdle } =
        await import("../services/routineQueue.js");
      const employeeId = process.env.GENOSYN_TEST_EMPLOYEE_ID;
      assert.ok(employeeId);
      const { Routine } = await import("../db/entities/Routine.js");
      const selectedIds: unknown = JSON.parse(process.env.GENOSYN_TEST_RUN_IDS ?? "[]");
      assert.ok(Array.isArray(selectedIds) && selectedIds.every((id) => typeof id === "string"));
      const selected = new Set<string>(selectedIds);
      if (mode === "exercise-routine-admission") assert.ok(selected.size > 0);
      // Real dispatch and Run lifecycles coordinate through Postgres; hold only
      // the model turns so the parent can inspect concurrent claim ownership.
      agentRuntime.run = async (params) => {
        const prompt = params.messages
          .flatMap((message) =>
            message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
          )
          .join("\n");
        const name = /^## Routine: (.+)$/m.exec(prompt)?.[1];
        assert.ok(name, "Routine brief must identify its work");
        const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
          employeeId,
          name,
        });
        const active = (
          await AppDataSource.getRepository(Run).findBy({
            employeeId,
            routineId: routine.id,
            status: "running",
          })
        ).filter((run) => selected.size === 0 || selected.has(run.id));
        assert.equal(active.length, 1, "Each child must identify its exact Run");
        const finish = parentMessage(`finish-run:${active[0].id}`);
        process.send!({ kind: "routine-started", runId: active[0].id });
        await finish;
        return { finalText: "Done", steps: 1, stopReason: "end_turn" };
      };
      const rounds = mode === "exercise-routine-admission" ? 2 : 1;
      let start = parentMessage("start");
      process.send("ready");
      for (let round = 1; round <= rounds; round++) {
        await start;
        // Register the next listener before acknowledging this round, so an
        // immediate parent dispatch cannot be lost between IPC listeners.
        if (round < rounds) start = parentMessage(`dispatch:${round + 1}`);
        if (selected.size) {
          for (const id of selected) {
            const run = await AppDataSource.getRepository(Run).findOneByOrFail({ id });
            if (run.status === "queued") void registerQueuedRun(run);
          }
        } else {
          await dispatchQueuedRoutineRuns();
        }
        await waitForRoutineQueueIdle();
        process.send({ kind: "queue-drained", round });
      }
    } else {
      throw new Error("Unknown smoke child mode");
    }
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    if (process.connected) process.disconnect();
  }
}

function spawnChild(
  mode: string,
  url: URL,
  dataDir: string,
  employeeId = "",
  runIds: string[] = [],
  routineIds: string[] = [],
) {
  stop.signal.throwIfAborted();
  const child = fork(fileURLToPath(import.meta.url), [mode], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      GENOSYN_TEST_POSTGRES_URL: url.toString(),
      GENOSYN_TEST_DATA_DIR: dataDir,
      GENOSYN_TEST_EMPLOYEE_ID: employeeId,
      GENOSYN_TEST_RUN_IDS: JSON.stringify(runIds),
      GENOSYN_TEST_ROUTINE_IDS: JSON.stringify(routineIds),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12_000);
    });
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${mode} child failed (${signal ?? code}): ${output}`));
    });
  });
  // A child can fail while a different phase is running; retain its rejection
  // for the explicit await without an unhandled-rejection race.
  void exited.catch(() => undefined);
  const ready = deadline(
    new Promise<void>((resolve, reject) => {
      child.on("message", (message) => {
        if (message === "ready") resolve();
      });
      void exited.then(() => reject(new Error(`${mode} exited before readiness`)), reject);
    }),
    `${mode} readiness`,
  );
  void ready.catch(() => undefined);
  return { child, ready, completion: exited, exited: () => deadline(exited, `${mode} completion`) };
}

async function stopChildren(): Promise<void> {
  await Promise.all(
    Array.from(
      children,
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

async function exercisePostgres(url: URL, dataDir: string): Promise<void> {
  const peers = [spawnChild("migrate", url, dataDir), spawnChild("migrate", url, dataDir)];
  await Promise.all(peers.map((peer) => peer.ready));
  for (const peer of peers) peer.child.send("start");
  await Promise.all(peers.map((peer) => peer.exited()));
  console.log("PASS simultaneous migration processes on a fresh Postgres database");

  configure(url, dataDir);
  const { AppDataSource } = await import("../db/datasource.js");
  try {
    await AppDataSource.initialize();
    stop.signal.throwIfAborted();
    assert.equal(await AppDataSource.showMigrations(), false, "Pending Postgres migrations");
    const drift = await AppDataSource.driver.createSchemaBuilder().log();
    assert.equal(
      drift.upQueries.length,
      0,
      `Postgres schema drift: ${drift.upQueries.map((q) => q.query).join("; ")}`,
    );
    console.log(
      `PASS ${AppDataSource.migrations.length} migrations at head with zero schema drift`,
    );

    const { findUuidTextComparisons } = await import("./postgresQueryComparisons.js");
    const migratedColumns: { table_name: string; column_name: string; data_type: string }[] =
      await AppDataSource.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema()",
      );
    const columnTypes = new Map<string, Map<string, string>>();
    for (const entity of AppDataSource.entityMetadatas) {
      const types = new Map<string, string>();
      for (const column of entity.columns) {
        const migrated = migratedColumns.find(
          (row) => row.table_name === entity.tableName && row.column_name === column.databaseName,
        );
        if (migrated) types.set(column.propertyName, migrated.data_type);
      }
      columnTypes.set(entity.name, types);
    }
    const uuidTextComparisons = await findUuidTextComparisons(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      columnTypes,
    );
    assert.deepEqual(
      uuidTextComparisons,
      [],
      "Postgres has no uuid = varchar operator; cast the uuid side, e.g. CAST(run.id AS text) = session.runId",
    );
    console.log("PASS query builder comparisons match migrated Postgres column types");

    const { AIEmployee } = await import("../db/entities/AIEmployee.js");
    const { AuditEvent } = await import("../db/entities/AuditEvent.js");
    const { Base } = await import("../db/entities/Base.js");
    const { BaseField } = await import("../db/entities/BaseField.js");
    const { BaseFormSubmission } = await import("../db/entities/BaseFormSubmission.js");
    const { BaseRecord } = await import("../db/entities/BaseRecord.js");
    const { BaseTable } = await import("../db/entities/BaseTable.js");
    const { Company } = await import("../db/entities/Company.js");
    const { User } = await import("../db/entities/User.js");
    const { UserSession } = await import("../db/entities/UserSession.js");
    const { SchedulerLease } = await import("../db/entities/SchedulerLease.js");
    const { PublicBaseFormClosedError, createBaseForm, submitBaseFormResponse, updateBaseForm } =
      await import("../services/baseForms.js");
    const { overrideRuntimeSettingsForTests } = await import("../services/runtimeSettings.js");
    const { withCompanyAgentCapacity, CompanyAgentCapacityError } =
      await import("../services/companyAgentCapacity.js");
    const users = AppDataSource.getRepository(User);

    const formsOwner = await users.save(
      users.create({
        email: "forms-postgres@example.com",
        name: "Forms Postgres Owner",
        passwordHash: "unused",
        sessionVersion: 0,
      }),
    );
    const companies = AppDataSource.getRepository(Company);
    const formsCompany = await companies.save(
      companies.create({
        name: "Forms Postgres Company",
        slug: "forms-postgres-company",
        ownerId: formsOwner.id,
      }),
    );
    const bases = AppDataSource.getRepository(Base);
    const formsBase = await bases.save(
      bases.create({
        companyId: formsCompany.id,
        name: "Responses",
        slug: "responses",
        color: "violet",
        createdById: formsOwner.id,
      }),
    );
    const tables = AppDataSource.getRepository(BaseTable);
    const formsTable = await tables.save(
      tables.create({
        baseId: formsBase.id,
        name: "Signups",
        slug: "signups",
        sortOrder: 1_000,
        archivedAt: null,
      }),
    );
    const fields = AppDataSource.getRepository(BaseField);
    const nameField = await fields.save(
      fields.create({
        tableId: formsTable.id,
        name: "Name",
        type: "text",
        configJson: "{}",
        isPrimary: true,
        sortOrder: 1_000,
      }),
    );

    const concurrentFormTitle = "C".repeat(160);
    const concurrentForms = await Promise.all(
      Array.from({ length: 12 }, () =>
        createBaseForm({
          companyId: formsCompany.id,
          baseSlug: formsBase.slug,
          tableId: formsTable.id,
          title: concurrentFormTitle,
          actorUserId: formsOwner.id,
        }),
      ),
    );
    const concurrentFormIds = new Set(concurrentForms.map(({ form }) => form.id));
    const concurrentFormSlugs = new Set(concurrentForms.map(({ form }) => form.slug));
    const expectedConcurrentSlugs = new Set(
      Array.from({ length: 12 }, (_, index) => {
        const tail = index === 0 ? "" : `-${index + 1}`;
        return `${"c".repeat(120 - tail.length)}${tail}`;
      }),
    );
    assert.equal(concurrentFormIds.size, 12);
    assert.deepEqual(concurrentFormSlugs, expectedConcurrentSlugs);
    assert.ok([...concurrentFormSlugs].every((slug) => slug.length <= 120));
    const concurrentCreateAudits = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: formsCompany.id,
      action: "form.create",
    });
    assert.equal(
      concurrentCreateAudits.filter(
        (audit) => audit.targetId !== null && concurrentFormIds.has(audit.targetId),
      ).length,
      12,
    );
    console.log("PASS Postgres Forms: concurrent same-title creates receive bounded unique slugs");

    const createdForm = await createBaseForm({
      companyId: formsCompany.id,
      baseSlug: formsBase.slug,
      tableId: formsTable.id,
      title: "Postgres signups",
      actorUserId: formsOwner.id,
    });
    const questionId = randomUUID();
    const publishedForm = await updateBaseForm({
      companyId: formsCompany.id,
      baseSlug: formsBase.slug,
      tableId: formsTable.id,
      formSlug: createdForm.form.slug,
      actorUserId: formsOwner.id,
      patch: {
        questions: [
          {
            id: questionId,
            fieldId: nameField.id,
            label: "Your name",
            description: "",
            required: true,
          },
        ],
        published: true,
      },
    });
    assert.ok(publishedForm.form.publicUrl, "Published Form did not expose its Member URL");
    const formToken = new URL(publishedForm.form.publicUrl).pathname.split("/").pop();
    assert.ok(formToken, "Published Form URL did not contain a bearer token");

    const sharedSubmissionId = randomUUID();
    const sharedResults = await Promise.all(
      Array.from({ length: 12 }, () =>
        submitBaseFormResponse({
          token: formToken,
          clientSubmissionId: sharedSubmissionId,
          values: { [questionId]: "One retried respondent" },
        }),
      ),
    );
    assert.ok(sharedResults.every((result) => result.ok));
    assert.equal(
      await AppDataSource.getRepository(BaseRecord).countBy({ tableId: formsTable.id }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({
        formId: publishedForm.form.id,
      }),
      1,
    );

    const distinctResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        submitBaseFormResponse({
          token: formToken,
          clientSubmissionId: randomUUID(),
          values: { [questionId]: `Postgres respondent ${index + 1}` },
        }),
      ),
    );
    assert.ok(distinctResults.every((result) => result.ok));
    const submissions = await AppDataSource.getRepository(BaseFormSubmission).findBy({
      formId: publishedForm.form.id,
    });
    assert.equal(submissions.length, 9);
    assert.equal(new Set(submissions.map((submission) => submission.recordId)).size, 9);
    assert.equal(
      await AppDataSource.getRepository(BaseRecord).countBy({ tableId: formsTable.id }),
      9,
    );

    await updateBaseForm({
      companyId: formsCompany.id,
      baseSlug: formsBase.slug,
      tableId: formsTable.id,
      formSlug: publishedForm.form.slug,
      actorUserId: formsOwner.id,
      patch: { acceptingResponses: false },
    });
    assert.deepEqual(
      await submitBaseFormResponse({
        token: formToken,
        clientSubmissionId: sharedSubmissionId,
        values: { [questionId]: "Ignored retry body" },
      }),
      { ok: true },
    );
    await assert.rejects(
      () =>
        submitBaseFormResponse({
          token: formToken,
          clientSubmissionId: randomUUID(),
          values: { [questionId]: "Late respondent" },
        }),
      PublicBaseFormClosedError,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseRecord).countBy({ tableId: formsTable.id }),
      9,
    );
    const formAudits = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: formsCompany.id,
      action: "form.submission.create",
    });
    assert.equal(formAudits.length, 9);
    assert.ok(formAudits.every((audit) => !audit.metadataJson.includes("respondent")));
    console.log(
      "PASS Postgres Forms: concurrent idempotency, distinct responses, close and audit redaction",
    );

    overrideRuntimeSettingsForTests({ agent: { maxConcurrentTurnsPerCompany: 2 } });
    const employees = AppDataSource.getRepository(AIEmployee);
    const first = await employees.save(
      employees.create({
        companyId: randomUUID(),
        name: "Capacity A",
        slug: "capacity-a",
        role: "Operations",
      }),
    );
    const second = await employees.save(
      employees.create({
        companyId: randomUUID(),
        name: "Capacity B",
        slug: "capacity-b",
        role: "Operations",
      }),
    );
    const holder = spawnChild("hold-capacity", url, dataDir, first.id);
    await holder.ready;
    let release!: () => void;
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const occupied = withCompanyAgentCapacity(first.id, stop.signal, async () => {
      admitted();
      await released;
      return "released";
    });
    void occupied.catch(() => undefined);
    try {
      await deadline(entered, "Parent slot admission");
      await assert.rejects(
        () => withCompanyAgentCapacity(first.id, undefined, async () => "excess"),
        CompanyAgentCapacityError,
      );
      assert.equal(
        await withCompanyAgentCapacity(second.id, undefined, async () => "independent"),
        "independent",
      );
    } finally {
      release();
      await occupied;
    }
    assert.equal(
      await withCompanyAgentCapacity(first.id, undefined, async () => "reused"),
      "reused",
    );
    holder.child.send("release");
    await holder.exited();

    const cancellation = new AbortController();
    const cancelled = withCompanyAgentCapacity(first.id, cancellation.signal, async (signal) => {
      assert.ok(signal);
      const stopped = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      cancellation.abort(new Error("Parent cancelled"));
      return stopped;
    });
    await assert.rejects(() => cancelled, /Parent cancelled/);
    const liveLeases = await AppDataSource.getRepository(SchedulerLease)
      .createQueryBuilder("lease")
      .where("lease.name LIKE :prefix", { prefix: "ai-capacity:%" })
      .andWhere('lease."expiresAt" > CURRENT_TIMESTAMP')
      .getCount();
    assert.equal(
      liveLeases,
      0,
      "Capacity slots must be released after completion and cancellation",
    );
    console.log(
      "PASS cross-process capacity: rejection, release, company isolation and cancellation",
    );

    const { AIModel } = await import("../db/entities/AIModel.js");
    const { Routine } = await import("../db/entities/Routine.js");
    const { Run } = await import("../db/entities/Run.js");
    const { encryptSecret } = await import("../lib/secret.js");
    const queueEmployee = await employees.save(
      employees.create({
        companyId: formsCompany.id,
        name: "Routine Queue",
        slug: "routine-queue",
        role: "Operations",
      }),
    );
    const models = AppDataSource.getRepository(AIModel);
    await models.save(
      models.create({
        employeeId: queueEmployee.id,
        provider: "custom",
        model: "postgres-queue-test",
        authMode: "customEndpoint",
        isActive: true,
        connectedAt: new Date(),
        // Cross-process dispatch, not model capacity, is under test here.
        maxConcurrentRuns: 0,
        configJson: JSON.stringify({
          baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
          modelId: "postgres-queue-test",
        }),
      }),
    );
    const routines = AppDataSource.getRepository(Routine);
    const runs = AppDataSource.getRepository(Run);
    const queued: InstanceType<typeof Run>[] = [];
    for (let index = 0; index < 3; index++) {
      const routine = await routines.save(
        routines.create({
          employeeId: queueEmployee.id,
          name: `Queued Routine ${index + 1}`,
          slug: `queued-routine-${index + 1}`,
          cronExpr: "0 9 * * *",
          timeoutSec: 60,
          body: "Complete this Routine.",
        }),
      );
      queued.push(
        await runs.save(
          runs.create({
            employeeId: queueEmployee.id,
            routineId: routine.id,
            status: "queued",
            triggerKind: "manual",
            queueOptionsJson: JSON.stringify({ triggerKind: "manual" }),
            startedAt: new Date(Date.now() - 60_000 + index),
            createdAt: new Date(Date.now() - 60_000 + index),
          }),
        ),
      );
    }
    const queuePeers = [
      spawnChild("drain-routine-queue", url, dataDir, queueEmployee.id),
      spawnChild("drain-routine-queue", url, dataDir, queueEmployee.id),
    ];
    const starts: { runId: string; child: ChildProcess }[] = [];
    let wake: (() => void) | undefined;
    for (const peer of queuePeers) {
      peer.child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "routine-started" &&
          "runId" in message &&
          typeof message.runId === "string"
        ) {
          starts.push({ runId: message.runId, child: peer.child });
          wake?.();
        }
      });
    }
    await Promise.all(queuePeers.map((peer) => peer.ready));
    for (const peer of queuePeers) peer.child.send("start");
    while (starts.length < queued.length) {
      await deadline(
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        "Concurrent Routine starts",
      );
      wake = undefined;
    }
    assert.equal(starts.length, queued.length);
    assert.deepEqual(
      new Set(starts.map(({ runId }) => runId)),
      new Set(queued.map((run) => run.id)),
      "Competing processes must execute each durable Run exactly once",
    );
    const concurrent = await runs.findBy({ employeeId: queueEmployee.id, status: "running" });
    assert.equal(
      concurrent.length,
      queued.length,
      "Every ready Routine must start before any finishes",
    );
    assert.equal(await runs.countBy({ employeeId: queueEmployee.id, status: "queued" }), 0);
    for (const run of concurrent)
      assert.ok(run.queueActiveEmployeeId?.startsWith(`run:${run.id}:`));
    for (const { runId, child } of starts) child.send(`finish-run:${runId}`);
    await Promise.all(queuePeers.map((peer) => peer.exited()));
    assert.equal(starts.length, queued.length);
    const completed = await runs.findBy({ employeeId: queueEmployee.id, status: "completed" });
    assert.equal(completed.length, queued.length);
    assert.ok(completed.every((run) => run.queueActiveEmployeeId === null));
    for (const run of completed) {
      assert.equal(
        await AppDataSource.getRepository(SchedulerLease).countBy({
          name: `routine-run:${run.id}`,
        }),
        0,
        "Completed Runs must not leave permanent dispatch lease rows",
      );
    }
    console.log(
      "PASS cross-process Routine dispatch: durable recovery, concurrent starts and one owner per Run",
    );

    // A model server on this machine serves one Routine Run at a time by
    // default; that limit must hold across every App process sharing Postgres.
    const capacityEmployee = await employees.save(
      employees.create({
        companyId: formsCompany.id,
        name: "Model Capacity",
        slug: "model-capacity",
        role: "Operations",
      }),
    );
    await models.save(
      models.create({
        employeeId: capacityEmployee.id,
        provider: "custom",
        model: "postgres-capacity-test",
        authMode: "customEndpoint",
        isActive: true,
        connectedAt: new Date(),
        configJson: JSON.stringify({
          baseURLEncrypted: encryptSecret("http://127.0.0.1:19998/v1"),
          modelId: "postgres-capacity-test",
        }),
      }),
    );
    const capacityRuns: InstanceType<typeof Run>[] = [];
    for (let index = 0; index < 3; index++) {
      const routine = await routines.save(
        routines.create({
          employeeId: capacityEmployee.id,
          name: `Capacity Routine ${index + 1}`,
          slug: `capacity-routine-${index + 1}`,
          cronExpr: "0 9 * * *",
          timeoutSec: 60,
          body: "Complete this Routine.",
        }),
      );
      capacityRuns.push(
        await runs.save(
          runs.create({
            employeeId: capacityEmployee.id,
            routineId: routine.id,
            status: "queued",
            triggerKind: "manual",
            queueOptionsJson: JSON.stringify({ triggerKind: "manual" }),
            startedAt: new Date(Date.now() - 60_000 + index),
            createdAt: new Date(Date.now() - 60_000 + index),
          }),
        ),
      );
    }
    const capacityPeers = [
      spawnChild("drain-model-capacity", url, dataDir, capacityEmployee.id),
      spawnChild("drain-model-capacity", url, dataDir, capacityEmployee.id),
    ];
    const capacityStarts: { runId: string; child: ChildProcess }[] = [];
    let capacityWake: (() => void) | undefined;
    for (const peer of capacityPeers) {
      peer.child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "routine-started" &&
          "runId" in message &&
          typeof message.runId === "string"
        ) {
          capacityStarts.push({ runId: message.runId, child: peer.child });
          capacityWake?.();
        }
      });
    }
    await Promise.all(capacityPeers.map((peer) => peer.ready));
    for (const peer of capacityPeers) peer.child.send("start");
    for (let started = 1; started <= capacityRuns.length; started++) {
      while (capacityStarts.length < started) {
        await deadline(
          new Promise<void>((resolve) => {
            capacityWake = resolve;
          }),
          "Model capacity start",
        );
        capacityWake = undefined;
      }
      // Give the other process every chance to overreach before checking.
      await delay(1_000);
      assert.equal(capacityStarts.length, started, "No second Run may start on a busy model");
      assert.equal(
        await runs.countBy({ employeeId: capacityEmployee.id, status: "running" }),
        1,
        "A local model serves one Routine Run at a time across processes",
      );
      const current = capacityStarts[started - 1];
      current.child.send(`finish-run:${current.runId}`);
    }
    await Promise.all(capacityPeers.map((peer) => peer.exited()));
    assert.deepEqual(
      new Set(capacityStarts.map(({ runId }) => runId)),
      new Set(capacityRuns.map((run) => run.id)),
      "Every waiting Run starts once a slot frees",
    );
    assert.equal(
      await runs.countBy({ employeeId: capacityEmployee.id, status: "completed" }),
      capacityRuns.length,
    );
    console.log(
      "PASS cross-process model capacity: one Run at a time on a local model, waiting Runs start as slots free",
    );

    const [sharedRoutine, unrelatedRoutine, cleanupRoutine] = await Promise.all(
      ["Shared admission", "Unrelated admission", "Held cleanup"].map((name, index) =>
        routines.save(
          routines.create({
            employeeId: queueEmployee.id,
            name,
            slug: `admission-${index}`,
            cronExpr: "0 9 * * *",
            timeoutSec: 60,
            body: "Complete this Routine.",
          }),
        ),
      ),
    );
    const [sharedOne, sharedTwo, unrelated, afterCleanup] = await Promise.all(
      [sharedRoutine, sharedRoutine, unrelatedRoutine, cleanupRoutine].map((routine) =>
        runs.save(
          runs.create({
            employeeId: queueEmployee.id,
            routineId: routine.id,
            status: "queued",
            triggerKind: "manual",
            queueOptionsJson: JSON.stringify({ triggerKind: "manual" }),
            startedAt: new Date(),
          }),
        ),
      ),
    );
    const heldClaim = "run:postgres-smoke:cleanup";
    const cleaning = await runs.save(
      runs.create({
        employeeId: queueEmployee.id,
        routineId: cleanupRoutine.id,
        status: "error",
        errorKind: "timeout",
        startedAt: new Date(Date.now() - 120_000),
        finishedAt: new Date(),
        queueActiveEmployeeId: heldClaim,
      }),
    );
    const admissionPeers = [
      spawnChild("exercise-routine-admission", url, dataDir, queueEmployee.id, [
        sharedOne.id,
        unrelated.id,
        afterCleanup.id,
      ]),
      spawnChild("exercise-routine-admission", url, dataDir, queueEmployee.id, [sharedTwo.id]),
    ];
    const admissionStarts: { runId: string; child: ChildProcess }[] = [];
    const drained = new Set<ChildProcess>();
    for (const peer of admissionPeers) {
      peer.child.on("message", (message: unknown) => {
        if (typeof message !== "object" || message === null || !("kind" in message)) return;
        if (
          message.kind === "routine-started" &&
          "runId" in message &&
          typeof message.runId === "string"
        ) {
          admissionStarts.push({ runId: message.runId, child: peer.child });
        } else if (message.kind === "queue-drained" && "round" in message && message.round === 1) {
          drained.add(peer.child);
        }
      });
    }
    const sharedIds = new Set([sharedOne.id, sharedTwo.id]);
    const finishAdmission = (runId: string) => {
      const started = admissionStarts.find((entry) => entry.runId === runId);
      assert.ok(started, `Run ${runId} did not reach the model`);
      started.child.send(`finish-run:${runId}`);
    };
    await Promise.all(admissionPeers.map((peer) => peer.ready));
    const rowLock = AppDataSource.createQueryRunner();
    await rowLock.connect();
    await rowLock.startTransaction();
    try {
      await rowLock.manager.getRepository(Routine).findOneOrFail({
        where: { id: sharedRoutine.id },
        lock: { mode: "pessimistic_write" },
      });
      for (const peer of admissionPeers) peer.child.send("start");
      await waitUntil(async () => {
        assert.ok(
          admissionStarts.every(({ runId }) => runId === unrelated.id),
          "The shared Routine must wait for its database lock, and terminal cleanup must block admission",
        );
        const blocked: { pid: number }[] = await AppDataSource.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() " +
            "AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'",
        );
        return blocked.length === 2 && admissionStarts.some(({ runId }) => runId === unrelated.id);
      }, "Both processes contend for the Routine lock while unrelated work starts");
    } finally {
      await rowLock.rollbackTransaction();
      await rowLock.release();
    }
    await waitUntil(
      () => admissionStarts.some(({ runId }) => sharedIds.has(runId)),
      "First shared Routine Run starts after the row lock is released",
    );
    finishAdmission(unrelated.id);
    await waitUntil(() => drained.size > 0, "Losing process finishes its admission attempt");
    const sharedRunning = await runs.findBy({ routineId: sharedRoutine.id, status: "running" });
    assert.equal(sharedRunning.length, 1, "Different processes must not overlap one Routine");
    assert.equal(await runs.countBy({ routineId: sharedRoutine.id, status: "queued" }), 1);
    assert.equal(
      admissionStarts.filter(({ runId }) => sharedIds.has(runId)).length,
      1,
      "Only one of the competing shared Runs may reach the model",
    );
    const blockedManual = await runs.findOneByOrFail({ id: afterCleanup.id });
    assert.equal(blockedManual.status, "queued");
    assert.equal(blockedManual.triggerKind, "manual");
    assert.equal(blockedManual.queueActiveEmployeeId, null);
    assert.equal(
      admissionStarts.some(({ runId }) => runId === afterCleanup.id),
      false,
    );
    assert.equal(
      (await runs.findOneByOrFail({ id: cleaning.id })).queueActiveEmployeeId,
      heldClaim,
    );
    finishAdmission(sharedRunning[0].id);
    await waitUntil(() => drained.size === 2, "First admission round cleans up in both processes");
    assert.equal(
      (await runs.findOneByOrFail({ id: sharedRunning[0].id })).queueActiveEmployeeId,
      null,
    );
    await runs.update(
      { id: cleaning.id, queueActiveEmployeeId: heldClaim },
      { queueActiveEmployeeId: null },
    );
    for (const peer of admissionPeers) peer.child.send("dispatch:2");
    await waitUntil(
      () => admissionStarts.length >= 4,
      "Deferred Runs start after cleanup releases ownership",
    );
    const previouslyQueued = [sharedOne, sharedTwo].find((run) => run.id !== sharedRunning[0].id)!;
    const secondRound = await Promise.all(
      [previouslyQueued, afterCleanup].map((run) => runs.findOneByOrFail({ id: run.id })),
    );
    assert.ok(secondRound.every((run) => run.status === "running"));
    for (const run of secondRound) finishAdmission(run.id);
    await Promise.all(admissionPeers.map((peer) => peer.exited()));
    const admittedRuns = [sharedOne, sharedTwo, unrelated, afterCleanup];
    assert.equal(admissionStarts.length, admittedRuns.length);
    assert.deepEqual(
      new Set(admissionStarts.map(({ runId }) => runId)),
      new Set(admittedRuns.map((run) => run.id)),
    );
    for (const run of admittedRuns) {
      const finished = await runs.findOneByOrFail({ id: run.id });
      assert.equal(finished.status, "completed");
      assert.equal(finished.queueActiveEmployeeId, null);
      assert.equal(
        await AppDataSource.getRepository(SchedulerLease).countBy({
          name: `routine-run:${run.id}`,
        }),
        0,
      );
    }
    console.log(
      "PASS cross-process Routine admission: same-Routine serialization, terminal cleanup exclusion and unrelated concurrency",
    );

    const [manualShared, manualUnrelated] = await Promise.all(
      ["Shared manual request", "Independent manual request"].map((name, index) =>
        routines.save(
          routines.create({
            employeeId: queueEmployee.id,
            name,
            slug: `manual-acceptance-${index}`,
            cronExpr: "0 9 * * *",
            timeoutSec: 60,
            body: "Complete this Routine.",
          }),
        ),
      ),
    );
    const manualPeers = [
      spawnChild(
        "accept-manual-routines",
        url,
        dataDir,
        queueEmployee.id,
        [],
        [manualShared.id, manualUnrelated.id],
      ),
      spawnChild("accept-manual-routines", url, dataDir, queueEmployee.id, [], [manualShared.id]),
    ];
    const manualAccepted: { routineId: string; runId: string; child: ChildProcess }[] = [];
    for (const peer of manualPeers) {
      peer.child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "manual-run-accepted" &&
          "routineId" in message &&
          typeof message.routineId === "string" &&
          "runId" in message &&
          typeof message.runId === "string"
        ) {
          manualAccepted.push({
            routineId: message.routineId,
            runId: message.runId,
            child: peer.child,
          });
        }
      });
    }
    await Promise.all(manualPeers.map((peer) => peer.ready));
    const manualLock = AppDataSource.createQueryRunner();
    await manualLock.connect();
    await manualLock.startTransaction();
    try {
      await manualLock.manager.getRepository(Routine).findOneOrFail({
        where: { id: manualShared.id },
        lock: { mode: "pessimistic_write" },
      });
      const [{ pid: lockOwner }]: { pid: number }[] = await manualLock.query(
        "SELECT pg_backend_pid() AS pid",
      );
      for (const peer of manualPeers) peer.child.send("start");
      await Promise.race([
        waitUntil(async () => {
          assert.ok(
            manualAccepted.every(({ routineId }) => routineId === manualUnrelated.id),
            "A manual request must not insert or return a Run before acquiring its Routine lock",
          );
          // Postgres truncates activity query text at 1kB by default, before
          // FOR UPDATE on a full Routine SELECT. Follow the actual blocker
          // chain, including a second waiter queued behind the first one.
          const blocked: { pid: number }[] = await AppDataSource.query(
            "WITH RECURSIVE blocked(pid) AS (" +
              "SELECT pid FROM pg_stat_activity WHERE datname = current_database() " +
              "AND $1 = ANY(pg_blocking_pids(pid)) " +
              "UNION SELECT activity.pid FROM pg_stat_activity activity " +
              "JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid)) " +
              "WHERE activity.datname = current_database()) SELECT pid FROM blocked",
            [lockOwner],
          );
          return blocked.length === 2 && manualAccepted.length === 1;
        }, "Two manual requests wait on the same Routine while an unrelated request is accepted"),
        ...manualPeers.map((peer) =>
          peer.completion.then(() => {
            throw new Error("Manual request process exited before its Routine lock was released");
          }),
        ),
      ]);
      assert.equal(await runs.countBy({ routineId: manualShared.id }), 0);
      const independent = await runs.findOneByOrFail({ routineId: manualUnrelated.id });
      assert.equal(independent.id, manualAccepted[0].runId);
      assert.equal(independent.status, "queued");
    } finally {
      await manualLock.rollbackTransaction();
      await manualLock.release();
    }
    await Promise.all(manualPeers.map((peer) => peer.exited()));
    assert.equal(manualAccepted.length, 3);
    const sharedResponses = manualAccepted.filter(({ routineId }) => routineId === manualShared.id);
    assert.equal(sharedResponses.length, 2);
    assert.equal(new Set(sharedResponses.map(({ child }) => child)).size, 2);
    assert.equal(new Set(sharedResponses.map(({ runId }) => runId)).size, 1);
    const sharedRows = await runs.findBy({ routineId: manualShared.id });
    assert.equal(
      sharedRows.length,
      1,
      "Simultaneous Member requests must create only one durable Run",
    );
    assert.equal(sharedRows[0].id, sharedResponses[0].runId);
    assert.notEqual(
      sharedRows[0].id,
      manualAccepted.find(({ routineId }) => routineId === manualUnrelated.id)!.runId,
    );
    for (const routine of [manualShared, manualUnrelated]) {
      assert.equal(await runs.countBy({ routineId: routine.id }), 1);
      const accepted = await runs.findOneByOrFail({ routineId: routine.id });
      assert.equal(accepted.employeeId, queueEmployee.id);
      assert.equal(accepted.status, "queued");
      assert.equal(accepted.triggerKind, "manual");
      assert.equal(accepted.queueActiveEmployeeId, null);
      assert.equal(accepted.parentRunId, null);
      assert.equal(accepted.continuationCount, 0);
    }
    console.log(
      "PASS cross-process manual requests: one accepted Run, shared response ID and independent Routine progress",
    );

    const { createUserSession, resolveUserSession, revokeCurrentUserSession } =
      await import("../services/userSessions.js");
    const user = await users.save(
      users.create({
        email: "smoke@example.com",
        name: "Smoke Member",
        passwordHash: "unused",
        sessionVersion: 0,
      }),
    );
    const one = await createUserSession(user);
    const two = await createUserSession(user);
    assert.equal((await resolveUserSession(one))?.id, user.id);
    await revokeCurrentUserSession({ session: one } as Request);
    assert.equal(await resolveUserSession(one), null);
    assert.equal((await resolveUserSession(two))?.id, user.id);
    assert.equal(await resolveUserSession({ ...two, expiresAt: 0 }), null);
    await users.increment({ id: user.id }, "sessionVersion", 1);
    assert.equal(await resolveUserSession(two), null);
    const current = await users.findOneByOrFail({ id: user.id });
    const expired = await createUserSession(current);
    await AppDataSource.getRepository(UserSession).update(expired.userSessionId, {
      expiresAt: new Date(0),
    });
    assert.equal(await resolveUserSession(expired), null);
    console.log("PASS Postgres browser sessions: individual logout, account revocation and expiry");

    const { BrowserSession } = await import("../db/entities/BrowserSession.js");
    const { reconcileOrphanedRuns } = await import("../services/runRecovery.js");
    const { dispatchDueMeetings } = await import("../services/meetings/recorder.js");
    const recordedRoutine = await routines.save(
      routines.create({
        employeeId: queueEmployee.id,
        name: "Recorded browser Routine",
        slug: "recorded-browser-routine",
        cronExpr: "0 9 * * *",
        timeoutSec: 60,
        body: "Use the browser.",
      }),
    );
    const recordedRun = await runs.save(
      runs.create({
        employeeId: queueEmployee.id,
        routineId: recordedRoutine.id,
        status: "error",
        triggerKind: "manual",
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
    );
    const browserSessions = AppDataSource.getRepository(BrowserSession);
    await browserSessions.save(
      browserSessions.create({
        companyId: formsCompany.id,
        employeeId: queueEmployee.id,
        runId: recordedRun.id,
        mcpToken: randomUUID(),
        mcpTokenExpiresAt: new Date(),
        status: "closed",
      }),
    );
    // Both run on every scheduler heartbeat. Boot recovery must finish before
    // the heartbeat dispatches any due Routine, so a failing query here stops
    // all scheduled work rather than one feature.
    await reconcileOrphanedRuns({ boot: true, now: new Date() });
    await dispatchDueMeetings(new Date());
    console.log("PASS Postgres scheduler heartbeat: boot recovery and notetaker dispatch queries");
  } finally {
    await stopChildren();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

async function main(): Promise<void> {
  if (process.argv[2]) return childMain(process.argv[2]);
  const maintenanceUrl = localPostgresUrl(process.env.GENOSYN_TEST_POSTGRES_URL);
  const name = `genosyn_saas_smoke_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(maintenanceUrl);
  testUrl.pathname = `/${name}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "genosyn-saas-postgres-"));
  const maintenance = new Client({
    connectionString: maintenanceUrl.toString(),
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  let created = false;
  try {
    await maintenance.connect();
    // Only this internally generated, unique database identifier is mutated.
    assert.match(name, /^genosyn_saas_smoke_[a-f0-9]{32}$/);
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    // Multiple independent process pairs each import and initialize the full
    // service graph. Keep their individual deadlines while allowing all phases
    // to complete on a busy CI worker.
    await deadline(exercisePostgres(testUrl, dataDir), "Postgres smoke", 300_000);
  } finally {
    stop.abort(new Error("Postgres smoke cleanup"));
    try {
      await stopChildren();
    } finally {
      try {
        if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        try {
          await maintenance.end();
        } finally {
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown smoke failure";
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[Postgres URL redacted]"));
  process.exitCode = 1;
});
