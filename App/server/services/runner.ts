import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { employeeDir, ensureDir } from "./paths.js";
import { nextRunFor } from "./cron.js";
import { resolveRoutineModel } from "./models.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";
import { composeCodeReposContext, materializeCodeReposForEmployee } from "./codeRepos.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import type { CompactionInfo, ToolTrimInfo, TurnUsage } from "./agent/types.js";
import { config } from "../../config.js";
import { acquireWorkloadLease, releaseWorkloadLease } from "./workloadLeases.js";

/**
 * Run seam.
 *
 * For each Routine run we:
 *  1. Load the employee, company, active model, and skill list.
 *  2. Compose a system prompt (Soul + Memory + Skills + tools briefing) and the
 *     routine instruction, all pulled from the DB.
 *  3. Run the in-process agent against the model's API (Anthropic / OpenAI /
 *     custom OpenAI-compatible endpoint), handing it the built-in coding tools,
 *     the genosyn MCP tools, browser tools (when enabled), and any
 *     company-configured MCP servers — buffering the transcript into the Run's
 *     `logContent`.
 *
 * Degradation: if no Model is connected we write a clear stub log and mark the
 * Run as skipped — the product must keep working on a fresh self-host before
 * anyone has connected a model.
 */

/**
 * Hard cap on how many bytes of transcript we keep on a single run row.
 * Output past the cap is dropped and a truncation marker is appended.
 */
export const RUN_LOG_MAX_BYTES = 256 * 1024;

/** Max model turns before the loop stops itself (runaway-loop backstop). */
const RUN_MAX_STEPS = 100;

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
 * along with a `completion` promise that resolves once the agent finishes and
 * the row has been finalized. The LogBuffer is registered in {@link liveBuffers}
 * for the lifetime of the run so polling clients can tail output before it lands
 * in the DB.
 */
export async function startRoutineRun(
  routine: Routine,
): Promise<{ run: Run; completion: Promise<Run> }> {
  const runRepo = AppDataSource.getRepository(Run);
  const routineRepo = AppDataSource.getRepository(Routine);
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);
  const skillRepo = AppDataSource.getRepository(Skill);

  const emp = await empRepo.findOneBy({ id: routine.employeeId });
  if (!emp) throw new Error("Employee not found for routine");
  const co = await coRepo.findOneBy({ id: emp.companyId });
  if (!co) throw new Error("Company not found for employee");
  // An employee can hold several models. The routine runs on the one it pins,
  // falling back to the employee's active model when it pins none.
  const { model, pinned } = await resolveRoutineModel(routine);
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });
  const workloadLease = model
    ? await acquireWorkloadLease(
        co.id,
        emp.id,
        "routine",
        Math.max(1, routine.timeoutSec) * 1000 + 60_000,
      )
    : null;

  const now = new Date();
  const run = runRepo.create({
    routineId: routine.id,
    startedAt: now,
    status: "running",
    logContent: "",
  });
  let saved: Run;
  try {
    saved = await runRepo.save(run);
  } catch (error) {
    await releaseWorkloadLease(workloadLease);
    throw error;
  }

  const log = new LogBuffer(RUN_LOG_MAX_BYTES);
  liveBuffers.set(saved.id, log);
  log.write(
    [
      `[${now.toISOString()}] run started`,
      `routine=${routine.name} (${routine.slug})`,
      `employee=${emp.name} (${emp.slug})`,
      `company=${co.name} (${co.slug})`,
      `model=${
        model
          ? `${model.provider}/${model.model} (${model.authMode})` +
            (pinned ? " [pinned to this routine]" : " [employee's active model]")
          : "not connected"
      }`,
      `cron=${routine.cronExpr}`,
      "",
    ].join("\n") + "\n",
  );

  const completion = (async (): Promise<Run> => {
    let mcpToken: string | null = null;
    try {
      mcpToken = issueMcpToken(emp.id, co.id);
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
      const codeReposContext = await composeCodeReposContext(emp.id);
      const system = composeSystemPrompt({
        co,
        emp,
        skills,
        memoryContext,
        codeReposContext,
      });
      const userMessage = composeRoutineMessage(routine);

      const cwd = employeeDir(co.slug, emp.slug);
      ensureDir(cwd);

      // Env for the bash tool: company vault secrets plus whatever the repo
      // materializers export. Secrets are validated + reserved-name filtered
      // by loadCompanySecretsEnv, so this can't clobber anything load-bearing.
      const toolEnv: Record<string, string> = {};
      if (!config.security.multiTenant) {
        try {
          Object.assign(toolEnv, await loadCompanySecretsEnv(co.id));
        } catch (err) {
          log.line(`[warn] failed to load company secrets: ${(err as Error).message}`);
        }
      }

      // Materialize granted GitHub Connection repos + provider-agnostic Code
      // Repositories into the employee's cwd. Errors are non-fatal.
      const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
      Object.assign(toolEnv, repoSync.extraEnv);
      for (const r of repoSync.repos) {
        log.line(`[repos] synced ${r.owner}/${r.name}@${r.defaultBranch}`);
      }
      for (const e of repoSync.errors) log.line(`[repos] ${e.scope}: ${e.message}`);

      const codeRepoSync = await materializeCodeReposForEmployee({ employeeId: emp.id, cwd });
      Object.assign(toolEnv, codeRepoSync.extraEnv);
      for (const r of codeRepoSync.repos) {
        log.line(`[code-repos] synced ${r.slug}@${r.defaultBranch} (${r.accessLevel})`);
      }
      for (const e of codeRepoSync.errors) log.line(`[code-repos] ${e.scope}: ${e.message}`);

      log.line("");

      // Overall time budget: abort the loop after the routine's timeout.
      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = Math.max(1, routine.timeoutSec) * 1000;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      // The final answer is already written to the transcript as it streams
      // (onText below); track that so we don't append it a second time — except
      // in the max-steps fallback, whose placeholder text never streamed.
      let streamedAny = false;
      let result;
      try {
        result = await runEmployeeAgent({
          model,
          employeeId: emp.id,
          system,
          messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
          cwd,
          toolEnv,
          genosynToken: mcpToken,
          bashTimeoutMs: Math.min(timeoutMs, 5 * 60 * 1000),
          maxSteps: RUN_MAX_STEPS,
          routineId: routine.id,
          runId: saved.id,
          signal: controller.signal,
          callbacks: {
            onText: (delta) => {
              streamedAny = true;
              log.write(delta);
            },
            onToolUse: (name, input) => log.line(`\n[tool] ${name} ${previewArgs(input)}`),
            onToolResult: (name, r) => log.line(`[tool:${name}] ${r.isError ? "error" : "ok"}`),
            onUsage: (u) => log.line(usageLine(u, model.contextWindow)),
            onCompact: (c) => log.line(compactLine(c)),
            onToolsTrimmed: (t) => log.line(toolTrimLine(t)),
          },
        });
      } finally {
        clearTimeout(timer);
      }

      saved.finishedAt = new Date();
      if (timedOut) {
        log.line(
          `\n[timeout] Stopped after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`,
        );
        saved.status = "timeout";
        saved.exitCode = null;
      } else if (result.status === "error") {
        log.line(`\n[error] ${result.error}`);
        saved.status = "failed";
        saved.exitCode = null;
      } else {
        if (!streamedAny && result.finalText.trim()) log.line("\n" + result.finalText.trim());
        saved.status = "completed";
        saved.exitCode = 0;
      }
      saved.logContent = log.value();
      await runRepo.save(saved);
      await touchRoutine(routine, saved.finishedAt, routineRepo);
      await writeJournalForRun(emp.id, routine, saved);
      return saved;
    } catch (err) {
      log.line(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
      saved.finishedAt = new Date();
      saved.status = "failed";
      saved.exitCode = null;
      saved.logContent = log.value();
      await runRepo.save(saved);
      await touchRoutine(routine, saved.finishedAt, routineRepo);
      return saved;
    } finally {
      if (mcpToken) revokeMcpToken(mcpToken);
      await releaseWorkloadLease(workloadLease);
      // Once the row has the final logContent, the live buffer is no longer the
      // source of truth — drop it so subsequent /log reads hit the DB.
      liveBuffers.delete(saved.id);
    }
  })();

  return { run: saved, completion };
}

/** Short, safe preview of a tool call's arguments for the run transcript. */
function previewArgs(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return "";
  }
}

/**
 * Warn once the prompt is using this share of the window — just under the point
 * where the loop starts compacting, so the transcript shows the squeeze building
 * before it shows history being dropped.
 */
const CONTEXT_WARN_PCT = 80;

/**
 * Record what each turn's prompt cost, so a run approaching the model's ceiling
 * is visible in the transcript rather than arriving as an unexplained provider
 * 400 on the turn that finally overflows.
 *
 * The counts come from the provider's own tokenizer, which is the only source
 * that can be right: a custom endpoint can serve any weights, so we can't know
 * the tokenizer and any local estimate would be a guess.
 */
function usageLine(u: TurnUsage, contextWindow: number | null): string {
  const base = `[tokens] in=${u.inputTokens} out=${u.outputTokens}`;
  // Say "unknown" rather than implying a ceiling we were never told. This is
  // also a nudge: with no window there's no budget, so the loop can only react
  // to an overflow after the fact instead of preventing one.
  if (!contextWindow) {
    return `${base} (context window unknown — set it on the model to let this run budget its context)`;
  }
  const pct = Math.round((u.inputTokens / contextWindow) * 100);
  const line = `${base} — ${pct}% of ${contextWindow}`;
  return pct >= CONTEXT_WARN_PCT
    ? `${line}\n[warn] Prompt is using ${pct}% of this model's context window. Older tool results will be dropped to make room.`
    : line;
}

/**
 * Say so in the transcript when the loop dropped history to stay inside the
 * window. Without this line an operator reading the log sees an employee that
 * inexplicably forgot what a tool told it ten steps ago.
 *
 * "overflow" is the louder case: the provider had already rejected a turn and we
 * recovered. That means the pre-flight budget missed — usually because the
 * model's context window is unknown, so there was nothing to budget against.
 */
function compactLine(c: CompactionInfo): string {
  const what = `dropped ${c.evicted} older tool result${c.evicted === 1 ? "" : "s"} (~${c.freedTokens} tokens) to fit the context window`;
  return c.reason === "budget"
    ? `[compact] ${what}`
    : `[compact] The model rejected the prompt as too long — ${what} and retried.`;
}

/**
 * Say plainly which tools the employee didn't get.
 *
 * This is the one line that turns "the agent ignored the CRM" into a fact the
 * reader can act on, so it names the dropped tools rather than counting them —
 * and points at the lever, because the fix is the employee's, not ours.
 */
function toolTrimLine(t: ToolTrimInfo): string {
  return (
    `[tools] ${t.offered} tools exceeds this model's limit of ${t.limit} — dropped ` +
    `${t.dropped.length}: ${t.dropped.join(", ")}. Remove an integration connection or ` +
    `MCP server from this employee, or move it to a provider without a tool cap.`
  );
}

/**
 * Emit a journal entry for every terminal run so the employee's diary shows
 * what actually happened. We don't journal the `running` state — only the
 * terminal transition, once the status is final.
 */
async function writeJournalForRun(employeeId: string, routine: Routine, run: Run): Promise<void> {
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
  // Recompute nextRunAt from the moment the run finished. Collapses any missed
  // slots that elapsed during a long-running invocation into a single future
  // tick, so the heartbeat doesn't immediately refire the stale slot.
  if (routine.enabled) {
    routine.nextRunAt = nextRunFor(routine.cronExpr, at ?? new Date());
  }
  await repo.save(routine);
}

/**
 * Compose the system prompt: who the employee is, the tools they have, and
 * their Soul + Memory + Skills + repo context — everything except the specific
 * task, which goes in the user message.
 */
function composeSystemPrompt(args: {
  co: Company;
  emp: AIEmployee;
  skills: Skill[];
  memoryContext: string;
  codeReposContext: string;
}): string {
  const { co, emp, skills, memoryContext, codeReposContext } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. The following documents are yours — your Soul, your Memory, and your Skills.`,
  );
  parts.push(toolsBriefing());
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  if (memoryContext) parts.push(memoryContext);
  if (codeReposContext) parts.push(codeReposContext);
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(s.body);
  }
  return parts.join("\n");
}

function composeRoutineMessage(routine: Routine): string {
  return [
    `## Routine: ${routine.name}`,
    "",
    routine.body,
    "",
    "---",
    "Run this routine now. Produce the expected output.",
  ].join("\n");
}

/**
 * Short briefing so the model knows the tools it holds are real and should be
 * used rather than narrated. Covers the coding toolset and the built-in genosyn
 * tools; the model discovers the full schema for each from the tool list.
 */
function toolsBriefing(): string {
  return [
    "",
    "## Tools",
    "You have tools available — use them instead of describing what you would do. A tool call leaves a visible audit row; prose-only claims are invisible.",
    "- Coding: `bash` (run shell commands in your working directory), `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`. Your working directory holds any git repositories you were granted, under `repos/` and `code-repos/`.",
    "- Genosyn: `add_journal_entry` to log what you accomplished, `memory` to capture durable facts, `create_routine`/`create_todo` to follow up on work, `update_routine` to edit or pause an existing Routine in place (never create a duplicate to change one), `get_self`/`list_employees`/`list_routines` to orient, plus Bases (`bases`, `base_rows`), email via the `mail` tool when a mailbox has been granted to you (op: accounts/search/get/draft/update/send — prefer drafts unless the brief explicitly allows sending), chat attachments, and any company integration tools you were granted.",
    '- Related actions are bundled behind an `op` argument rather than one tool each — `base_rows` takes `op: "list" | "create" | "update" | "delete"`, and `memory`, `notes`, `charts` and others work the same way. Each tool\'s description lists the ops it accepts and what each one requires; read it before calling.',
    "- Parallel delegation: `delegate_parallel_work` runs independent briefs concurrently as temporary copies of you, then returns their results for you to verify and synthesize. Prefer independent research, analysis, and API calls. Workers share your working directory, so partition file-writing briefs explicitly and never overlap git operations.",
    "- Browser (when enabled) and any company-configured MCP servers appear as additional tools.",
  ].join("\n");
}

/**
 * Bounded transcript buffer. Keeps the first `cap` bytes; everything after is
 * dropped with a one-shot `[truncated]` marker so a runaway agent can't blow up
 * the run row.
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
