import { spawn } from "node:child_process";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { employeeDir, ensureDir } from "./paths.js";
import { PROVIDERS, isSubscriptionConnected } from "./providers.js";
import { decryptSecret } from "../lib/secret.js";
import { materializeMcpConfig } from "./mcp.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";

/**
 * Run seam.
 *
 * For each Routine run we:
 *  1. Load the employee, company, model, and skill list.
 *  2. Compose a single prompt from the Soul body + skill bodies + routine
 *     body, all pulled from the DB.
 *  3. Resolve credentials per employee — subscription (CLAUDE_CONFIG_DIR
 *     pointing at their .claude/) or API key (ANTHROPIC_API_KEY).
 *  4. Spawn the provider CLI in the employee's directory, buffer stdout +
 *     stderr into the Run's `logContent`, and persist the Run record.
 *
 * Degradation: if no Model is connected, or the provider CLI isn't installed,
 * we write a clear stub log and mark the Run as skipped — the product must
 * keep working on a fresh self-host before anyone has run `claude login`.
 */

/**
 * Hard cap on how many bytes of stdout+stderr we keep on a single run row.
 * Matches the old 256KB file-tail display window so nothing visibly changes;
 * output past the cap is dropped and a truncation marker is appended.
 */
export const RUN_LOG_MAX_BYTES = 256 * 1024;

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
    logContent: "",
  });
  const saved = await runRepo.save(run);

  const log = new LogBuffer(RUN_LOG_MAX_BYTES);
  log.write(
    [
      `[${now.toISOString()}] run started`,
      `routine=${routine.name} (${routine.slug})`,
      `employee=${emp.name} (${emp.slug})`,
      `company=${co.name} (${co.slug})`,
      `model=${model ? `${model.provider}/${model.model} (${model.authMode})` : "not connected"}`,
      `cron=${routine.cronExpr}`,
      "",
    ].join("\n") + "\n",
  );

  // No model connected → skip cleanly.
  if (!model) {
    log.line(
      "[skipped] This employee has no AI Model connected. Open the employee in the app and connect one.",
    );
    saved.finishedAt = new Date();
    saved.status = "skipped";
    saved.logContent = log.value();
    await runRepo.save(saved);
    await touchRoutine(routine, saved.finishedAt, routineRepo);
    return saved;
  }

  const prompt = composePrompt({ co, emp, routine, skills });

  const env = buildProviderEnv(co.slug, emp.slug, model);
  if (!("error" in env)) {
    // Merge company vault secrets into the child env. Validation + the
    // internal RESERVED_NAMES filter in loadCompanySecretsEnv mean this
    // can't clobber provider auth keys we just set above.
    try {
      const secrets = await loadCompanySecretsEnv(co.id);
      for (const [k, v] of Object.entries(secrets)) {
        if (k in (env.env ?? {})) continue;
        env.env![k] = v;
      }
    } catch (err) {
      log.line(`[warn] failed to load company secrets: ${(err as Error).message}`);
    }
  }
  if ("error" in env) {
    log.line(`[error] ${env.error}`);
    saved.finishedAt = new Date();
    saved.status = "failed";
    saved.logContent = log.value();
    await runRepo.save(saved);
    await touchRoutine(routine, saved.finishedAt, routineRepo);
    return saved;
  }

  const cwd = employeeDir(co.slug, emp.slug);
  ensureDir(cwd);

  // Mint a fresh MCP token so the built-in Genosyn stdio server can act on
  // this employee's behalf for the duration of the run. Revoked in `finally`
  // so a killed run doesn't leave a usable token behind.
  const mcpToken = issueMcpToken(emp.id, co.id);
  await materializeMcpConfig(emp.id, cwd, { genosynToken: mcpToken });

  // Dispatch by provider. The headless invocations below are the documented
  // non-interactive entry points for each CLI. If the CLI binary isn't
  // installed we catch ENOENT and degrade to a "skipped" log so the UI keeps
  // working before any provider has been installed on the host.
  const invocation = buildInvocation(model.provider, model.model, prompt);
  const timeoutMs = Math.max(1, routine.timeoutSec) * 1000;
  try {
    const result = await spawnAndBuffer(
      invocation.cmd,
      invocation.args,
      { cwd, env: env.env, timeoutMs },
      log,
    );
    saved.finishedAt = new Date();
    saved.exitCode = result.code;
    saved.status = result.code === 0 ? "completed" : "failed";
    if (result.code !== 0) {
      log.line(`[error] ${invocation.cmd} exited with code ${result.code}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SpawnTimeoutError) {
      log.line(
        `[timeout] Killed after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`,
      );
      saved.finishedAt = new Date();
      saved.status = "timeout";
      saved.exitCode = null;
    } else if (msg.includes("ENOENT")) {
      log.line(
        `[stub] \`${invocation.cmd}\` CLI not found on PATH. Install it to run this routine for real.`,
      );
      saved.finishedAt = new Date();
      saved.status = "skipped";
      saved.exitCode = null;
    } else {
      log.line(`[error] ${msg}`);
      saved.finishedAt = new Date();
      saved.status = "failed";
      saved.exitCode = null;
    }
  } finally {
    revokeMcpToken(mcpToken);
  }
  saved.logContent = log.value();
  await runRepo.save(saved);
  await touchRoutine(routine, saved.finishedAt, routineRepo);
  await writeJournalForRun(emp.id, routine, saved);
  return saved;
}

/**
 * Emit a journal entry for every terminal run so the employee's diary shows
 * what actually happened. We don't journal the `running` state — only the
 * terminal transition, once the status is final.
 */
async function writeJournalForRun(
  employeeId: string,
  routine: Routine,
  run: Run,
): Promise<void> {
  const journalRepo = AppDataSource.getRepository(JournalEntry);
  const verb =
    run.status === "completed"
      ? "completed"
      : run.status === "failed"
        ? "failed"
        : run.status === "skipped"
          ? "was skipped"
          : run.status === "timeout"
            ? "timed out"
            : "finished";
  const title = `Routine "${routine.name}" ${verb}`;
  const bodyLines: string[] = [];
  if (run.exitCode !== null) bodyLines.push(`exit code: ${run.exitCode}`);
  const entry = journalRepo.create({
    employeeId,
    kind: "run",
    title,
    body: bodyLines.join("\n"),
    runId: run.id,
    routineId: routine.id,
    authorUserId: null,
  });
  await journalRepo.save(entry);
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
  parts.push(
    `\n## Tools\nYou have a \`genosyn\` MCP server attached. Use \`add_journal_entry\` to log what you accomplished, \`create_todo\` or \`create_routine\` to follow up on work, and the \`list_*\` helpers to orient. Reach for tools instead of describing what you would do.`,
  );
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(s.body);
  }
  parts.push(`\n## Routine: ${routine.name}\n`);
  parts.push(routine.body);
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
    if (!isSubscriptionConnected(model.provider, coSlug, empSlug)) {
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
 * Bounded log buffer. Keeps the first `cap` bytes; everything after is
 * dropped with a one-shot `[truncated]` marker, so a runaway CLI can't blow
 * up the run row. Stored content fits the same display cap the route used
 * to apply at read time.
 */
class LogBuffer {
  private parts: string[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly cap: number) {}

  write(s: string): void {
    if (!s) return;
    if (this.truncated) return;
    const b = Buffer.byteLength(s, "utf8");
    if (this.size + b <= this.cap) {
      this.parts.push(s);
      this.size += b;
      return;
    }
    const remaining = this.cap - this.size;
    if (remaining > 0) {
      // Trim to roughly `remaining` bytes. Favor correctness over byte-exactness:
      // slice by chars, then push, then mark as truncated.
      this.parts.push(s.slice(0, remaining));
      this.size += Buffer.byteLength(s.slice(0, remaining), "utf8");
    }
    this.parts.push(`\n[truncated — output exceeded ${this.cap} bytes]\n`);
    this.truncated = true;
  }

  line(s: string): void {
    this.write(s + "\n");
  }

  value(): string {
    return this.parts.join("");
  }
}

/**
 * Spawn a child, copy stdout/stderr into the provided LogBuffer, and resolve
 * with the exit code on normal close. If the child doesn't exit within
 * `timeoutMs` we SIGKILL it and reject with {@link SpawnTimeoutError} — the
 * caller is expected to mark the Run `timeout` with `exitCode = null`.
 */
function spawnAndBuffer(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  log: LogBuffer,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    child.stdout.on("data", (b: Buffer) => log.write(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => log.write(b.toString("utf8")));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tag = timedOut ? "timeout" : `exit ${code}`;
      log.line(`\n[${new Date().toISOString()}] ${tag}`);
      if (timedOut) {
        reject(new SpawnTimeoutError(`${cmd} timed out after ${opts.timeoutMs}ms`));
      } else {
        resolve({ code: code ?? -1 });
      }
    });
  });
}
