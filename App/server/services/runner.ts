import { spawn } from "node:child_process";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { employeeDir, employeeOpenclawDir, ensureDir, openclawConfigPath } from "./paths.js";
import { nextRunFor } from "./cron.js";
import { PROVIDERS, isSubscriptionConnected, splitGooseModel } from "./providers.js";
import { decryptSecret } from "../lib/secret.js";
import { materializeMcpConfig } from "./mcp.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";

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

/**
 * In-process registry of LogBuffers for runs that are still executing. The
 * `/runs/:runId/log` endpoint reads from here while a run is in flight so the
 * UI can tail output live; once the run terminates we drop the entry and the
 * endpoint falls back to the persisted `Run.logContent`.
 */
const liveBuffers = new Map<string, LogBuffer>();

export function getLiveRunSnapshot(
  runId: string,
): { content: string; size: number; truncated: boolean } | null {
  const log = liveBuffers.get(runId);
  if (!log) return null;
  const content = log.value();
  return {
    content,
    size: Buffer.byteLength(content, "utf8"),
    truncated: log.isTruncated,
  };
}

/**
 * Synchronous-feeling wrapper used by cron + webhook + approval flows: awaits
 * full completion, returns the final Run row. Manual UI runs use
 * {@link startRoutineRun} so the request can return before execution finishes.
 */
export async function runRoutine(routine: Routine): Promise<Run> {
  const { completion } = await startRoutineRun(routine);
  return completion;
}

/**
 * Begin a run and return the saved Run row immediately (status `running`),
 * along with a `completion` promise that resolves once the child process
 * exits and the row has been finalized. The LogBuffer is registered in
 * {@link liveBuffers} for the lifetime of the run so polling clients can
 * tail output before it lands in the DB.
 */
export async function startRoutineRun(
  routine: Routine,
): Promise<{ run: Run; completion: Promise<Run> }> {
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
  liveBuffers.set(saved.id, log);
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

  const completion = (async (): Promise<Run> => {
    try {
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

      const memoryContext = await composeMemoryContext(emp.id);
      const prompt = composePrompt({ co, emp, routine, skills, memoryContext });

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
      const mcpExtras = await materializeMcpConfig(emp.id, cwd, {
        genosynToken: mcpToken,
        provider: model.provider,
        companySlug: co.slug,
        employeeSlug: emp.slug,
      });
      // goose returns extra CLI flags + env (it has no config file we can write
      // without clobbering `goose configure`'s state). Other providers return
      // empty values; the merge is a no-op for them.
      for (const [k, v] of Object.entries(mcpExtras.extraEnv)) {
        if (env.env && !(k in env.env)) env.env[k] = v;
      }

      // Materialize each granted GitHub Connection's allowlisted repos into
      // `<cwd>/repos/<owner>/<name>/`. Errors are non-fatal — we surface them
      // in the run log and let the agent decide whether to proceed.
      const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
      for (const [k, v] of Object.entries(repoSync.extraEnv)) {
        if (env.env && !(k in env.env)) env.env[k] = v;
      }
      for (const r of repoSync.repos) {
        log.line(`[repos] synced ${r.owner}/${r.name}@${r.defaultBranch}`);
      }
      for (const e of repoSync.errors) {
        log.line(`[repos] ${e.scope}: ${e.message}`);
      }

      // Dispatch by provider. The headless invocations below are the documented
      // non-interactive entry points for each CLI. If the CLI binary isn't
      // installed we catch ENOENT and degrade to a "skipped" log so the UI keeps
      // working before any provider has been installed on the host.
      const invocation = buildInvocation(model.provider, model.model, prompt, mcpExtras.extraArgs);
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
    } finally {
      // Once the row has the final logContent, the live buffer is no longer
      // the source of truth — drop it so subsequent /log reads hit the DB.
      liveBuffers.delete(saved.id);
    }
  })();

  return { run: saved, completion };
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
  // Recompute nextRunAt from the moment the run finished. Collapses any
  // missed slots that elapsed during a long-running invocation into a single
  // future tick, so the heartbeat doesn't immediately refire the stale slot.
  // Manual "Run now" and webhook fires land here too — the worst case is that
  // the next scheduled tick moves forward by one slot, which is the
  // fire-at-most-once behavior we want project-wide.
  if (routine.enabled) {
    routine.nextRunAt = nextRunFor(routine.cronExpr, at ?? new Date());
  }
  await repo.save(routine);
}

function composePrompt(args: {
  co: Company;
  emp: AIEmployee;
  routine: Routine;
  skills: Skill[];
  memoryContext: string;
}): string {
  const { co, emp, routine, skills, memoryContext } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. The following documents are yours — your Soul, your Memory, your Skills, and today's Routine.`,
  );
  parts.push(
    [
      "",
      "## Tools",
      "You have a `genosyn` MCP server attached. Use `add_journal_entry` to log what you accomplished, `add_memory` to capture durable facts worth recalling next time, `create_todo` or `create_routine` to follow up on work, and the `list_*` helpers to orient.",
      "Reach for tools instead of describing what you would do — a tool call leaves a visible audit row and an action pill the operator can inspect. Prose-only claims are invisible.",
    ].join("\n"),
  );
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  if (memoryContext) parts.push(memoryContext);
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
  // host's logged-in session or shared key. The XDG_* and GOOSE_* entries
  // protect opencode + goose from picking up the operator's own config dirs.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "GOOSE_PROVIDER",
    "GOOSE_MODEL",
    "GOOSE_DISABLE_KEYRING",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
  ]) {
    delete base[key];
  }

  if (model.authMode === "subscription") {
    const dir = spec.configDir(coSlug, empSlug);
    if (!spec.supportsSubscription || !spec.loginCommand) {
      return { error: `${model.provider} doesn't support subscription auth — use an API key.` };
    }
    if (!isSubscriptionConnected(model.provider, coSlug, empSlug)) {
      return {
        error: `Subscription credentials not found. Run \`${spec.configDirEnv}=${dir} ${spec.loginCommand}\` and retry.`,
      };
    }
    const env: NodeJS.ProcessEnv = { ...base, [spec.configDirEnv]: dir };
    if (model.provider === "goose") {
      // Pin keys to config.yaml (not the host keychain) so per-employee
      // isolation actually holds. Pass through provider/model selection so
      // the AIModel record stays authoritative even if the user's
      // `goose configure` choice drifts.
      env.GOOSE_DISABLE_KEYRING = "1";
      const { provider: gp, model: gm } = splitGooseModel(model.model);
      if (gp) env.GOOSE_PROVIDER = gp;
      if (gm) env.GOOSE_MODEL = gm;
    }
    return { env };
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
  const env: NodeJS.ProcessEnv = { ...base, [spec.apiKeyEnv]: key };
  if (model.provider === "openclaw") {
    // OpenClaw needs its config file path (OPENCLAW_CONFIG_PATH) and its
    // runtime state dir (OPENCLAW_STATE_DIR) pinned per-employee. Without
    // both, per-agent auth profiles would land in the operator's
    // ~/.openclaw/ and leak across employees.
    env.OPENCLAW_CONFIG_PATH = openclawConfigPath(coSlug, empSlug);
    env.OPENCLAW_STATE_DIR = employeeOpenclawDir(coSlug, empSlug);
  }
  return { env };
}

/**
 * Headless invocations per provider.
 *  - claude-code: `claude -p <prompt> --model <model>` (official headless mode)
 *  - codex:       `codex exec --model <model> <prompt>` (non-interactive mode)
 *  - opencode:    `opencode run --model <model> <prompt>` (router mode)
 *  - goose:       `goose run --text <prompt> --no-session --quiet`
 *                 (router mode; provider + model are pinned via env vars
 *                 so the AIModel record stays authoritative)
 *  - openclaw:    `openclaw agent --message <prompt>` (one-shot turn).
 *                 Model + underlying provider live in openclaw.json (pointed
 *                 at via OPENCLAW_CONFIG_PATH); we materialize that file's
 *                 `mcp.servers` block before each spawn so the genosyn MCP
 *                 server is always attached, but leave model defaults to
 *                 OpenClaw (operator can run `openclaw onboard` to seed
 *                 them, or rely on built-in defaults).
 *
 * `extraArgs` carries provider-specific MCP wiring that has to land on the
 * argv rather than a config file. Empty for everyone except goose today.
 */
function buildInvocation(
  provider: AIModel["provider"],
  modelStr: string,
  prompt: string,
  extraArgs: string[],
): { cmd: string; args: string[] } {
  switch (provider) {
    case "claude-code":
      // See the mirror in `chat.ts` — `--allowedTools "mcp__genosyn"`
      // pre-approves the built-in MCP tools so `claude -p` actually attaches
      // them instead of silently dropping the server.
      return {
        cmd: "claude",
        args: [
          "-p",
          prompt,
          "--model",
          modelStr,
          "--allowedTools",
          "mcp__genosyn",
          ...extraArgs,
        ],
      };
    case "codex":
      // Mirror of chat.ts — run codex non-interactively with tool calls
      // pre-approved and sandboxed to the employee's cwd.
      return {
        cmd: "codex",
        args: [
          "exec",
          "--model",
          modelStr,
          "--ask-for-approval",
          "never",
          "--sandbox",
          "workspace-write",
          ...extraArgs,
          prompt,
        ],
      };
    case "opencode":
      return {
        cmd: "opencode",
        args: ["run", "--model", modelStr, ...extraArgs, prompt],
      };
    case "goose":
      // `--no-session` skips writing a session file (we don't replay these),
      // `--quiet` drops the recipe banner so stdout stays focused on the
      // model's reply. Provider + model selection rides on env vars set in
      // `buildProviderEnv` so a single AIModel.model edit reroutes both
      // chat and routine spawns without surgery here.
      return {
        cmd: "goose",
        args: ["run", "--text", prompt, "--no-session", "--quiet", ...extraArgs],
      };
    case "openclaw":
      return {
        cmd: "openclaw",
        args: ["agent", "--message", prompt, ...extraArgs],
      };
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

  get isTruncated(): boolean {
    return this.truncated;
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
