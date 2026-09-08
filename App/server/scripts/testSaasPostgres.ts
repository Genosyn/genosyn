import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

function configure(url: URL, dataDir: string): void {
  // Entity column types and migration paths are chosen at module evaluation.
  // No datasource or service imports are allowed above this assignment.
  Object.assign(config.db, { driver: "postgres", postgresUrl: url.toString() });
  Object.assign(config.security, { multiTenant: true });
  Object.assign(config, { dataDir });
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
    } else {
      throw new Error("Unknown smoke child mode");
    }
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    if (process.connected) process.disconnect();
  }
}

function spawnChild(mode: string, url: URL, dataDir: string, employeeId = "") {
  stop.signal.throwIfAborted();
  const child = fork(fileURLToPath(import.meta.url), [mode], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      GENOSYN_TEST_POSTGRES_URL: url.toString(),
      GENOSYN_TEST_DATA_DIR: dataDir,
      GENOSYN_TEST_EMPLOYEE_ID: employeeId,
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
  return { child, ready, exited: () => deadline(exited, `${mode} completion`) };
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

    const { AIEmployee } = await import("../db/entities/AIEmployee.js");
    const { User } = await import("../db/entities/User.js");
    const { UserSession } = await import("../db/entities/UserSession.js");
    const { SchedulerLease } = await import("../db/entities/SchedulerLease.js");
    const { overrideRuntimeSettingsForTests } = await import("../services/runtimeSettings.js");
    const { withCompanyAgentCapacity, CompanyAgentCapacityError } =
      await import("../services/companyAgentCapacity.js");
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

    const { createUserSession, resolveUserSession, revokeCurrentUserSession } =
      await import("../services/userSessions.js");
    const users = AppDataSource.getRepository(User);
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
    await deadline(exercisePostgres(testUrl, dataDir), "Postgres smoke", 180_000);
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
