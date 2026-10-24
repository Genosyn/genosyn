/**
 * Disposable real-app boot for test-visual-system.ts; never reads a developer
 * database.
 *
 * The real Express app, services and routes run on an isolated in-memory
 * SQLite schema; a small reverse proxy serves a built client (`dist/client`,
 * or the directory passed as the second argument, so an older build can be
 * photographed against the same data) with `/api` forwarded to the App.
 *
 * Rows a Member cannot create through the API — connected AI Models, Runs and
 * Decisions, which only an AI Employee or the scheduler ever writes — are
 * seeded here through the same repositories the services use, on
 * `POST /__visual/seed`. That hook lives on the proxy, never on the App.
 *
 * Prints `[visual-server] ready <origin> <email> <password>` once both servers
 * are listening.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "../config.js";

const testRoot = process.argv[2];
assert(testRoot && path.basename(testRoot).startsWith("genosyn-visual-system-"));
assert.equal(path.dirname(fs.realpathSync(testRoot)), fs.realpathSync(os.tmpdir()));
const clientDir = path.resolve(
  process.argv[3] || fileURLToPath(new URL("../dist/client/", import.meta.url)),
);
assert(
  fs.existsSync(path.join(clientDir, "index.html")),
  `No built client at ${clientDir}. Run npm run build:client first.`,
);

export const VISUAL_EMAIL = "morgan@visual.test";
const password = `Visual-${randomBytes(9).toString("hex")}`;

/** Ask the kernel for a free port. The tiny race is fine for a local suite. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const uiPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`;

Object.assign(config, {
  dataDir: path.join(testRoot, "data"),
  port,
  sessionSecret: randomBytes(32).toString("hex"),
});
Object.assign(config.db, { sqlitePath: path.join(testRoot, "data", "app.sqlite"), driver: "sqlite" });
Object.assign(config.security, {
  encryptionSecret: randomBytes(32).toString("hex"),
  secureCookies: false,
  trustedProxyHops: 1,
  bootstrapMasterAdminEmail: VISUAL_EMAIL,
});
Object.assign(config.agent.codingTools, { enabled: false, executionMode: "disabled" });

const { initTestDb } = await import("../server/test/dbHarness.js");
await initTestDb();
const { AppDataSource } = await import("../server/db/datasource.js");
const { User } = await import("../server/db/entities/User.js");
const { ensureUserHandle } = await import("../server/services/userHandle.js");
const bcrypt = (await import("bcrypt")).default;

// The operator account, verified and promoted, as if it had already proved
// its mailbox: the suite is about how pages look, not about signing up.
const users = AppDataSource.getRepository(User);
const owner = await users.save(
  users.create({
    email: VISUAL_EMAIL,
    name: "Morgan Lee",
    passwordHash: await bcrypt.hash(password, 4),
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
    resetToken: null,
    resetExpiresAt: null,
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    sessionVersion: 0,
  }),
);
await ensureUserHandle(owner);

const { setPublicUrl } = await import("../server/services/publicUrl.js");
await setPublicUrl(origin);
await import("../server/index.js");

const { AIModel } = await import("../server/db/entities/AIModel.js");
const { AIEmployee } = await import("../server/db/entities/AIEmployee.js");
const { Routine } = await import("../server/db/entities/Routine.js");
const { Run } = await import("../server/db/entities/Run.js");
const { Decision } = await import("../server/db/entities/Decision.js");
const { encryptSecret } = await import("../server/lib/secret.js");

const HOUR = 3_600_000;

/** Rows only an AI Employee or the scheduler writes, for one seeded company. */
async function seed(companyId: string): Promise<Record<string, number>> {
  const now = Date.now();
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  assert(employees.length > 0, "seed employees through the API first");
  const models = AppDataSource.getRepository(AIModel);
  for (const [index, employee] of employees.entries()) {
    await models.save(
      models.create({
        employeeId: employee.id,
        provider: "anthropic",
        model: "claude-opus-5-5",
        authMode: "apikey",
        isActive: true,
        configJson: JSON.stringify({
          apiKeyEncrypted: encryptSecret(`sk-ant-visual-${index}-0000000000`, companyId),
        }),
        connectedAt: new Date(now - (index + 2) * 24 * HOUR),
        contextWindow: 200_000,
        contextWindowSource: "probed",
        maxConcurrentRuns: null,
      }),
    );
  }
  // The first employee also keeps a second, self-hosted model, as in the
  // Model page people reported.
  await models.save(
    models.create({
      employeeId: employees[0].id,
      provider: "custom",
      model: "Qwen/Qwen3.8-27B",
      authMode: "customEndpoint",
      isActive: false,
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("http://10.20.30.40:46455/v1", companyId),
      }),
      connectedAt: new Date(now - 3 * 24 * HOUR),
      contextWindow: 32_768,
      contextWindowSource: "probed",
      maxConcurrentRuns: 2,
    }),
  );

  const allRoutines = (
    await Promise.all(
      employees.map((employee) =>
        AppDataSource.getRepository(Routine).find({ where: { employeeId: employee.id } }),
      ),
    )
  ).flat();
  const runs = AppDataSource.getRepository(Run);
  let runCount = 0;
  for (const [index, routine] of allRoutines.entries()) {
    const history: Array<{
      ago: number;
      status: "completed" | "failed" | "error" | "running";
      verdict: "achieved" | "off_goal" | "unclear" | null;
    }> = [
      { ago: 70, status: "completed", verdict: "achieved" },
      { ago: 46, status: "completed", verdict: "achieved" },
      {
        ago: 22,
        status: index % 3 === 1 ? "failed" : "completed",
        verdict: index % 3 === 1 ? "off_goal" : "achieved",
      },
      { ago: 3, status: index % 4 === 2 ? "error" : "completed", verdict: index % 4 === 2 ? null : "unclear" },
    ];
    if (index === 0) history.push({ ago: 0.2, status: "running", verdict: null });
    for (const entry of history) {
      const startedAt = new Date(now - entry.ago * HOUR);
      const running = entry.status === "running";
      await runs.save(
        runs.create({
          routineId: routine.id,
          employeeId: routine.employeeId,
          startedAt,
          finishedAt: running ? null : new Date(startedAt.getTime() + (4 + index) * 60_000),
          status: entry.status,
          errorKind: entry.status === "error" ? "runtime" : null,
          failureReason:
            entry.status === "failed"
              ? "The supplier portal was down, so the weekly order sheet could not be downloaded."
              : null,
          logContent: running ? "" : "Reviewed the inbox and filed three follow-ups.",
          triggerKind: "schedule",
          outcomeVerdict: entry.verdict,
          outcomeNote: entry.verdict === "achieved" ? "The brief's definition of done is met." : null,
          outcomeCheckedAt: entry.verdict ? new Date(startedAt.getTime() + 10 * 60_000) : null,
          tokensIn: 18_000 + index * 1_200,
          tokensOut: 2_400 + index * 300,
        }),
      );
      runCount += 1;
    }
  }

  const decisions = AppDataSource.getRepository(Decision);
  const questions = [
    {
      title: "Offer Northwind a 12% renewal discount?",
      summary: "Northwind renews on Friday and asked for 15% off the annual plan.",
      recommendation: "Offer 12% with a two-year term; it keeps margin above target.",
      options: ["Offer 12% for two years", "Offer 15% for one year", "Hold the list price"],
      urgency: "high" as const,
    },
    {
      title: "Which supplier should restock the March order?",
      summary: "Both quotes arrived; Brightline is cheaper, Acorn ships two days sooner.",
      recommendation: "Brightline — the two days do not affect any open order.",
      options: ["Brightline", "Acorn Supply"],
      urgency: "normal" as const,
    },
    {
      title: "Publish the spring pricing page this week?",
      summary: "The copy is drafted and reviewed; the new tiers go live with it.",
      recommendation: "Publish on Thursday after the newsletter goes out.",
      options: ["Publish Thursday", "Wait for the April launch"],
      urgency: "low" as const,
    },
  ];
  for (const [index, question] of questions.entries()) {
    const employee = employees[index % employees.length];
    await decisions.save(
      decisions.create({
        companyId,
        employeeId: employee.id,
        title: question.title,
        body: `${question.summary}\n\n${question.recommendation}`,
        summary: question.summary,
        recommendation: question.recommendation,
        optionsJson: JSON.stringify(
          question.options.map((label, optionIndex) => ({
            id: `option-${optionIndex + 1}`,
            label,
            detail: null,
            tone: "neutral",
          })),
        ),
        status: "pending",
        urgency: question.urgency,
      }),
    );
  }
  return { models: employees.length + 1, runs: runCount, decisions: questions.length };
}

const ui = express();
ui.post("/__visual/seed", express.json(), async (req, res) => {
  try {
    const companyId = String((req.body as { companyId?: unknown }).companyId ?? "");
    assert(companyId, "companyId is required");
    res.json(await seed(companyId));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
ui.use("/api", (req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.originalUrl,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": req.headers.host ?? `127.0.0.1:${uiPort}`,
        "x-forwarded-proto": "http",
      },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => res.status(502).end());
  req.pipe(upstream);
});
ui.use(express.static(clientDir));
ui.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
const frontend = http.createServer(ui);
frontend.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(port, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      upstream.write(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
await new Promise<void>((resolve) => frontend.listen(uiPort, "127.0.0.1", resolve));

// The App logs its own listening line; wait for the socket rather than the log.
for (let attempt = 0; ; attempt += 1) {
  const ready = await new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  if (ready) break;
  assert(attempt < 1200, "the App never started listening");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(`[visual-server] ready ${origin} ${VISUAL_EMAIL} ${password}`);
