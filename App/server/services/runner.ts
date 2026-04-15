import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import {
  employeeDir,
  ensureDir,
  routineDir,
  routineReadme,
  skillReadme,
  soulPath,
} from "./paths.js";
import { PROVIDERS } from "./providers.js";
import { readText } from "./files.js";
import { decryptSecret } from "../lib/secret.js";

/**
 * Run seam.
 *
 * For each Routine run we:
 *  1. Load the employee, company, model, and skill list.
 *  2. Compose a single prompt from SOUL.md + skill READMEs + routine README.
 *  3. Resolve credentials per employee — subscription (CLAUDE_CONFIG_DIR
 *     pointing at their .claude/) or API key (ANTHROPIC_API_KEY).
 *  4. Spawn the provider CLI in the employee's directory, stream stdout +
 *     stderr into a run log, and persist the Run record.
 *
 * Degradation: if no Model is connected, or the provider CLI isn't installed,
 * we write a clear stub log and mark the Run as skipped — the product must
 * keep working on a fresh self-host before anyone has run `claude login`.
 */
export async function runRoutine(routine: Routine): Promise<Run> {
  const runRepo = AppDataSource.getRepository(Run);
  const routineRepo = AppDataSource.getRepository(Routine);
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);
  const modelRepo = AppDataSource.getRepository(AIModel);
  const skillRepo = AppDataSource.getRepository(Skill);

  const emp = await empRepo.findOneBy({ id: routine.employeeId });
  if (!emp) throw new Error("Employee not found for routine");
  const co = await coRepo.findOneBy({ id: emp.companyId });
  if (!co) throw new Error("Company not found for employee");
  const model = await modelRepo.findOneBy({ employeeId: emp.id });
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });

  const now = new Date();
  const run = runRepo.create({
    routineId: routine.id,
    startedAt: now,
    status: "running",
  });
  const saved = await runRepo.save(run);

  const logsDir = path.join(routineDir(co.slug, emp.slug, routine.slug), "runs");
  ensureDir(logsDir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logsDir, `${stamp}.log`);

  const header = [
    `[${now.toISOString()}] run started`,
    `routine=${routine.name} (${routine.slug})`,
    `employee=${emp.name} (${emp.slug})`,
    `company=${co.name} (${co.slug})`,
    `model=${model ? `${model.provider}/${model.model} (${model.authMode})` : "not connected"}`,
    `cron=${routine.cronExpr}`,
    "",
  ];
  fs.writeFileSync(logFile, header.join("\n") + "\n", "utf8");

  // No model connected → skip cleanly.
  if (!model) {
    appendLine(
      logFile,
      "[skipped] This employee has no AI Model connected. Open the employee in the app and connect one.",
    );
    saved.finishedAt = new Date();
    saved.status = "skipped";
    saved.logsPath = logFile;
    await runRepo.save(saved);
    await touchRoutine(routine, saved.finishedAt, routineRepo);
    return saved;
  }

  const prompt = composePrompt({ co, emp, routine, skills });

  const env = buildProviderEnv(co.slug, emp.slug, model);
  if ("error" in env) {
    appendLine(logFile, `[error] ${env.error}`);
    saved.finishedAt = new Date();
    saved.status = "failed";
    saved.logsPath = logFile;
    await runRepo.save(saved);
    await touchRoutine(routine, saved.finishedAt, routineRepo);
    return saved;
  }

  const cwd = employeeDir(co.slug, emp.slug);
  ensureDir(cwd);

  // Dispatch by provider. The headless invocations below are the documented
  // non-interactive entry points for each CLI. If the CLI binary isn't
  // installed we catch ENOENT and degrade to a "skipped" log so the UI keeps
  // working before any provider has been installed on the host.
  const invocation = buildInvocation(model.provider, model.model, prompt);
  const timeoutMs = Math.max(1, routine.timeoutSec) * 1000;
  try {
    const result = await spawnAndLog(
      invocation.cmd,
      invocation.args,
      { cwd, env: env.env, timeoutMs },
      logFile,
    );
    saved.finishedAt = new Date();
    saved.exitCode = result.code;
    saved.status = result.code === 0 ? "completed" : "failed";
    if (result.code !== 0) {
      appendLine(logFile, `[error] ${invocation.cmd} exited with code ${result.code}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SpawnTimeoutError) {
      appendLine(
        logFile,
        `[timeout] Killed after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`,
      );
      saved.finishedAt = new Date();
      saved.status = "timeout";
      saved.exitCode = null;
    } else if (msg.includes("ENOENT")) {
      appendLine(
        logFile,
        `[stub] \`${invocation.cmd}\` CLI not found on PATH. Install it to run this routine for real.`,
      );
      saved.finishedAt = new Date();
      saved.status = "skipped";
      saved.exitCode = null;
    } else {
      appendLine(logFile, `[error] ${msg}`);
      saved.finishedAt = new Date();
      saved.status = "failed";
      saved.exitCode = null;
    }
  }
  saved.logsPath = logFile;
  await runRepo.save(saved);
  await touchRoutine(routine, saved.finishedAt, routineRepo);
  return saved;
}

async function touchRoutine(
  routine: Routine,
  at: Date | null,
  repo: ReturnType<typeof AppDataSource.getRepository<Routine>>,
) {
  routine.lastRunAt = at;
  await repo.save(routine);
}

function composePrompt(args: {
  co: Company;
  emp: AIEmployee;
  routine: Routine;
  skills: Skill[];
}): string {
  const { co, emp, routine, skills } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. The following documents are yours — your Soul, your Skills, and today's Routine.`,
  );
  parts.push("\n## SOUL.md\n");
  parts.push(readText(soulPath(co.slug, emp.slug)));
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(readText(skillReadme(co.slug, emp.slug, s.slug)));
  }
  parts.push(`\n## Routine: ${routine.name}\n`);
  parts.push(readText(routineReadme(co.slug, emp.slug, routine.slug)));
  parts.push("\n---\nRun this routine now. Produce the expected output.");
  return parts.join("\n");
}

function buildProviderEnv(
  coSlug: string,
  empSlug: string,
  model: AIModel,
): { env: NodeJS.ProcessEnv; error?: undefined } | { env?: undefined; error: string } {
  const spec = PROVIDERS[model.provider];
  const base = { ...process.env };
  // Strip any ambient credentials so employees can't accidentally inherit the
  // host's logged-in session or shared key.
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    delete base[key];
  }

  if (model.authMode === "subscription") {
    const dir = spec.configDir(coSlug, empSlug);
    if (!fs.existsSync(spec.credsPath(coSlug, empSlug))) {
      return {
        error: `Subscription credentials not found. Run \`${spec.configDirEnv}=${dir} ${spec.loginCommand}\` and retry.`,
      };
    }
    return { env: { ...base, [spec.configDirEnv]: dir } };
  }

  // apikey mode
  if (!spec.apiKeyEnv) {
    return { error: `${model.provider} doesn't support API key auth — use subscription.` };
  }
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(model.configJson || "{}");
  } catch {
    cfg = {};
  }
  const enc = typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  if (!enc) return { error: "No API key is set for this employee." };
  let key: string;
  try {
    key = decryptSecret(enc);
  } catch {
    return { error: "Stored API key could not be decrypted (sessionSecret may have rotated)." };
  }
  return { env: { ...base, [spec.apiKeyEnv]: key } };
}

/**
 * Headless invocations per provider.
 *  - claude-code: `claude -p <prompt> --model <model>` (official headless mode)
 *  - codex:       `codex exec --model <model> <prompt>` (non-interactive mode)
 *  - opencode:    `opencode run --model <model> <prompt>` (router mode)
 */
function buildInvocation(
  provider: AIModel["provider"],
  modelStr: string,
  prompt: string,
): { cmd: string; args: string[] } {
  switch (provider) {
    case "claude-code":
      return { cmd: "claude", args: ["-p", prompt, "--model", modelStr] };
    case "codex":
      return { cmd: "codex", args: ["exec", "--model", modelStr, prompt] };
    case "opencode":
      return { cmd: "opencode", args: ["run", "--model", modelStr, prompt] };
  }
}

class SpawnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnTimeoutError";
  }
}

/**
 * Spawn a child, pipe stdout/stderr into `logFile`, and resolve with the
 * exit code on normal close. If the child doesn't exit within `timeoutMs`
 * we SIGKILL it and reject with {@link SpawnTimeoutError} — the caller is
 * expected to mark the Run `timeout` with `exitCode = null`.
 */
function spawnAndLog(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  logFile: string,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const out = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      out.end();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tag = timedOut ? "timeout" : `exit ${code}`;
      out.end(`\n[${new Date().toISOString()}] ${tag}\n`);
      if (timedOut) {
        reject(new SpawnTimeoutError(`${cmd} timed out after ${opts.timeoutMs}ms`));
      } else {
        resolve({ code: code ?? -1 });
      }
    });
  });
}

function appendLine(file: string, line: string): void {
  fs.appendFileSync(file, line + "\n", "utf8");
}
