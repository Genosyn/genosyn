import type { Repository } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import type { RunTrigger } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { employeeDir, ensureDir } from "./paths.js";
import { nextRunFor } from "./cron.js";
import { automaticRetryDelayMs, automaticRetryLimit, shouldRetry } from "./cronMath.js";
import { resolveRoutineModel } from "./models.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";
import { composeCodeReposContext, materializeCodeReposForEmployee } from "./codeRepos.js";
import { composeFinanceContext } from "./financeGrants.js";
import { composeRevenueContext } from "./revenue/grants.js";
import { composeMarketingContext } from "./marketing.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import type { CompactionInfo, ToolDeferralInfo, ToolTrimInfo, TurnUsage } from "./agent/types.js";
import { config } from "../../config.js";
import { composeEmployeeSystemPrompt } from "./agent/systemPrompt.js";
import { residentNamesForSkills, skillToolsetMap } from "./skillToolset.js";
import { acquireWorkloadLease, releaseWorkloadLease } from "./workloadLeases.js";
import { DurableRunLog, RUN_LOG_MAX_BYTES } from "./runLog.js";
import { supportsParallelDelegation } from "./agent/tools/parallelDelegation.js";
import { shouldMaterializeRepositoriesForTurn } from "./codexSubscription.js";
import { CODING_TOOL_NAMES } from "./agent/tools/coding.js";

export { RUN_LOG_MAX_BYTES } from "./runLog.js";

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
 * Max model turns before the loop stops itself (runaway-loop backstop).
 */
const RUN_MAX_STEPS = 100;

/**
 * In-process registry of LogBuffers for runs that are still executing. The
 * `/runs/:runId/log` endpoint reads from here while a run is in flight so the
 * UI can tail output live; once the run terminates we drop the entry and the
 * endpoint falls back to the persisted `Run.logContent`.
 */
const liveBuffers = new Map<string, DurableRunLog>();

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
export async function runRoutine(routine: Routine, opts: StartRunOptions = {}): Promise<Run> {
  const { completion } = await startRoutineRun(routine, opts);
  return completion;
}

/**
 * Provenance for a run. Defaults deliberately describe a human-triggered run
 * (`manual`, first attempt, nothing missed), so the "Run now" path needs no
 * argument and is correctly excluded from automatic retry — someone was there
 * and saw what happened.
 */
export type StartRunOptions = {
  triggerKind?: RunTrigger;
  /** 1-based attempt within a retry chain. */
  attempt?: number;
  /** Effective ceiling for display when crash recovery extends the configured budget. */
  attemptLimit?: number;
  parentRunId?: string | null;
  /** Occurrences this run is catching up for. See `Run.missedSlots`. */
  missedSlots?: number;
  /**
   * Internal scheduler seam, called at the last safe point before the Run row
   * is inserted. Retry dispatch uses it to renew and revalidate its durable
   * claim after all potentially slow start prerequisites have completed.
   * Throwing aborts the start and releases any acquired workload lease.
   *
   * @internal
   */
  beforeRunPersist?: () => Promise<void>;
};

/**
 * Begin a run and return the saved Run row immediately (status `running`),
 * along with a `completion` promise that resolves once the agent finishes and
 * the row has been finalized. The durable log is registered in
 * {@link liveBuffers} for the lifetime of the run so polling clients can tail
 * output, while periodic snapshots are checkpointed to the DB for crash
 * recovery.
 */
export async function startRoutineRun(
  routine: Routine,
  opts: StartRunOptions = {},
): Promise<{ run: Run; completion: Promise<Run> }> {
  // The Routine's timeout is an absolute wall-clock budget, not merely an
  // agent-loop timer. Capture it before model resolution, lease acquisition,
  // and every other start prerequisite, then persist this exact boundary.
  const startedAt = new Date();
  const timeoutMs = Math.max(1, routine.timeoutSec) * 1000;
  const runRepo = AppDataSource.getRepository(Run);
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
    ? await acquireWorkloadLease(co.id, emp.id, "routine", timeoutMs + 60_000)
    : null;

  const missedSlots = opts.missedSlots ?? 0;
  const run = runRepo.create({
    routineId: routine.id,
    startedAt,
    status: "running",
    logContent: "",
    triggerKind: opts.triggerKind ?? "manual",
    attempt: opts.attempt ?? 1,
    parentRunId: opts.parentRunId ?? null,
    missedSlots,
  });
  let saved: Run;
  try {
    await opts.beforeRunPersist?.();
    saved = await runRepo.save(run);
  } catch (error) {
    await releaseWorkloadLease(workloadLease);
    throw error;
  }
  const deadlineAtMs = saved.startedAt.getTime() + timeoutMs;

  const checkpointState: { headerDurable: boolean; initialFailure?: unknown } = {
    headerDurable: false,
  };
  const log = new DurableRunLog({
    cap: RUN_LOG_MAX_BYTES,
    persist: async (content) => {
      // Never let a late checkpoint overwrite a terminal row recovered or
      // finalized elsewhere. Only the transcript column changes.
      await runRepo.update({ id: saved.id, status: "running" }, { logContent: content });
    },
    onCheckpointError: (error) => {
      if (!checkpointState.headerDurable) checkpointState.initialFailure = error;
      // A later checkpoint or the final Run save will try again. The Routine
      // itself should not fail solely because one progress snapshot did.
      // eslint-disable-next-line no-console
      console.error(`[runner] failed to checkpoint log for run ${saved.id}:`, error);
    },
  });
  liveBuffers.set(saved.id, log);
  log.write(
    [
      `[${startedAt.toISOString()}] run started`,
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
      `trigger=${saved.triggerKind}` +
        (saved.attempt > 1
          ? ` (attempt ${saved.attempt} of ${opts.attemptLimit ?? routine.maxAttempts}, retry of ${saved.parentRunId})`
          : ""),
      ...(missedSlots > 0
        ? [`missed=${missedSlots} scheduled occurrence(s) while the server was unavailable`]
        : []),
      "",
    ].join("\n") + "\n",
  );
  // Make the framing header durable before any model, repository, or tool work
  // begins. Even a crash inside the first checkpoint window then leaves a
  // useful starting boundary instead of an empty interrupted Run.
  try {
    await log.flush();
    // DurableRunLog reports checkpoint errors through its callback so later
    // progress snapshots remain best-effort. The framing header is different:
    // startRoutineRun must not report a successfully started child when its
    // first durable boundary was never written.
    if ("initialFailure" in checkpointState) throw checkpointState.initialFailure;
    checkpointState.headerDurable = true;
  } catch (err) {
    const setupTimedOut = Date.now() >= deadlineAtMs;
    log.line(
      setupTimedOut
        ? `\n[timeout] Stopped after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`
        : `\n[error] Run setup failed before work began: ${errorMessage(err)}`,
    );
    saved.finishedAt = new Date();
    saved.status = setupTimedOut ? "timeout" : "failed";
    saved.exitCode = null;
    stampRetry(saved, routine, log);
    try {
      const finalization = await finalizeRunFromRunning(runRepo, saved, log);
      saved = finalization.run;
      if (finalization.persisted) {
        await settleAfterRun(routine.id, saved.finishedAt);
      }
    } finally {
      liveBuffers.delete(saved.id);
      await releaseWorkloadLease(workloadLease);
    }
    throw err;
  }

  const completion = (async (): Promise<Run> => {
    let mcpToken: string | null = null;
    let agentInvocationStarted = false;
    const deadlineReached = (): boolean => Date.now() >= deadlineAtMs;
    const finalizeTimedOutRun = async (): Promise<Run> => {
      saved.finishedAt = new Date();
      log.line(
        `\n[timeout] Stopped after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`,
      );
      saved.status = "timeout";
      saved.exitCode = null;
      stampRetry(saved, routine, log);
      const finalization = await finalizeRunFromRunning(runRepo, saved, log);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      await settleAfterRun(routine.id, saved.finishedAt);
      await journalQuietly(emp.id, routine, saved);
      return saved;
    };
    try {
      if (deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      mcpToken = issueMcpToken(emp.id, co.id, {
        runId: saved.id,
        routineId: routine.id,
      });
      // No model connected → skip cleanly.
      if (!model) {
        log.line(
          "[skipped] This employee has no AI Model connected. Open the employee in the app and connect one.",
        );
        saved.finishedAt = new Date();
        saved.status = "skipped";
        const finalization = await finalizeRunFromRunning(runRepo, saved, log);
        saved = finalization.run;
        if (!finalization.persisted) return saved;
        await settleAfterRun(routine.id, saved.finishedAt);
        return saved;
      }

      const parallelDelegationAvailable = supportsParallelDelegation(model.authMode);
      const unavailableCodingTools =
        !config.agent.codingTools.enabled || config.agent.codingTools.executionMode === "disabled"
          ? [...CODING_TOOL_NAMES]
          : config.agent.codingTools.executionMode === "bubblewrap"
            ? CODING_TOOL_NAMES.filter((name) => name !== "bash")
            : model.authMode === "subscription"
              ? [...CODING_TOOL_NAMES]
              : [];
      const unavailableSkillTools = [
        ...(parallelDelegationAvailable ? [] : ["delegate_parallel_work"]),
        ...unavailableCodingTools,
      ];
      const repositoryMaterializationAllowed = shouldMaterializeRepositoriesForTurn(model.authMode);
      const memoryContext = await composeMemoryContext(emp.id);
      const codeReposContext = repositoryMaterializationAllowed
        ? await composeCodeReposContext(emp.id)
        : "";
      const financeContext = await composeFinanceContext(emp.id);
      const [revenueContext, marketingContext] = await Promise.all([
        composeRevenueContext(emp.id),
        composeMarketingContext(emp.id),
      ]);
      if (deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      const system = composeEmployeeSystemPrompt({
        co,
        emp,
        skills,
        memoryContext,
        codeReposContext,
        financeContext,
        revenueContext,
        marketingContext,
        surface: "routine",
        parallelDelegationAvailable,
        codingToolsAvailable: unavailableCodingTools.length < CODING_TOOL_NAMES.length,
        isolatedCodingTools: config.agent.codingTools.executionMode === "bubblewrap",
        opening:
          `You are ${emp.name}, ${emp.role} at ${co.name}. The following documents are yours — ` +
          `your Soul, your Memory, and your Skills.`,
        skillToolsets: skillToolsetMap(skills, unavailableSkillTools),
      });
      const userMessage = composeRoutineMessage(routine, missedSlots);

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

      if (repositoryMaterializationAllowed) {
        // Materialize granted GitHub Connection repos + provider-agnostic Code
        // Repositories into the employee's cwd. Errors are non-fatal.
        const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
        Object.assign(toolEnv, repoSync.extraEnv);
        for (const r of repoSync.repos) {
          log.line(`[repos] synced ${r.owner}/${r.name}@${r.defaultBranch}`);
        }
        for (const e of repoSync.errors) log.line(`[repos] ${e.scope}: ${e.message}`);

        const codeRepoSync = await materializeCodeReposForEmployee({
          employeeId: emp.id,
          cwd,
          githubRepoCredentials: repoSync.githubRepoCredentials,
        });
        Object.assign(toolEnv, codeRepoSync.extraEnv);
        for (const r of codeRepoSync.repos) {
          log.line(`[code-repos] synced ${r.slug}@${r.defaultBranch} (${r.accessLevel})`);
        }
        for (const e of codeRepoSync.errors) log.line(`[code-repos] ${e.scope}: ${e.message}`);
      } else {
        log.line("[repos] automatic repository sync is disabled for this Run");
      }

      log.line("");

      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }

      // Spend only the wall-clock budget that remains after start and context
      // setup. This timer shares the persisted Run deadline, so setup time can
      // never silently extend the configured timeout.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remainingMs);

      // The final answer is already written to the transcript as it streams
      // (onText below); track that so we don't append it a second time — except
      // in the max-steps fallback, whose placeholder text never streamed.
      let streamedAny = false;
      let result;
      try {
        if (deadlineReached()) {
          timedOut = true;
          controller.abort();
        } else {
          agentInvocationStarted = true;
          result = await runEmployeeAgent({
            model,
            employeeId: emp.id,
            system,
            messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
            cwd,
            toolEnv,
            genosynToken: mcpToken,
            bashTimeoutMs: Math.min(remainingMs, 5 * 60 * 1000),
            maxSteps: RUN_MAX_STEPS,
            skillToolset: residentNamesForSkills(skills, unavailableSkillTools),
            routineId: routine.id,
            runId: saved.id,
            signal: controller.signal,
            callbacks: {
              onModelRetry: (retry) =>
                log.line(
                  `\n[model] ${retry.reason}; retrying attempt ${retry.attempt} of ${retry.maxAttempts} in ${(retry.delayMs / 1000).toFixed(1)}s`,
                ),
              onText: (delta) => {
                streamedAny = true;
                log.write(delta);
              },
              onToolUse: (name, input) => log.line(`\n[tool] ${name} ${previewArgs(input)}`),
              onToolResult: (name, r) => log.line(`[tool:${name}] ${r.isError ? "error" : "ok"}`),
              onUsage: (u) => log.line(usageLine(u, model.contextWindow)),
              onCompact: (c) => log.line(compactLine(c)),
              onToolsTrimmed: (t) => log.line(toolTrimLine(t)),
              onToolsDeferred: (d) => log.line(toolDeferLine(d)),
            },
          });
        }
      } catch (err) {
        // Providers differ in whether an aborted request resolves with an
        // error result or rejects. Both represent the same timeout verdict
        // once the absolute deadline has passed.
        if (!timedOut && !deadlineReached()) throw err;
      } finally {
        clearTimeout(timer);
      }

      if (timedOut || deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      if (!result) throw new Error("The AI Model returned no Run result.");

      saved.finishedAt = new Date();
      if (result.status === "error") {
        log.line(`\n[error] ${result.error}`);
        saved.status = "failed";
        saved.exitCode = null;
      } else {
        if (!streamedAny && result.finalText.trim()) log.line("\n" + result.finalText.trim());
        saved.status = "completed";
        saved.exitCode = 0;
      }
      // Before log.value(): stampRetry writes its own transcript line.
      stampRetry(saved, routine, log);
      const finalization = await finalizeRunFromRunning(runRepo, saved, log);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      // Deliberately not inside the try that owns the status: a throw from
      // either of these used to fall into the catch below, which unconditionally
      // rewrote an already-persisted `completed` run to `failed`. That matters
      // far more now that `failed` can mean "retry this", i.e. spend money.
      await settleAfterRun(routine.id, saved.finishedAt);
      await journalQuietly(emp.id, routine, saved);
      return saved;
    } catch (err) {
      if (!agentInvocationStarted && saved.status === "running" && deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      log.line(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
      saved.finishedAt = new Date();
      saved.status = "failed";
      saved.exitCode = null;
      stampRetry(saved, routine, log);
      const finalization = await finalizeRunFromRunning(runRepo, saved, log);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      await settleAfterRun(routine.id, saved.finishedAt);
      return saved;
    } finally {
      if (mcpToken) revokeMcpToken(mcpToken);
      // Once the row has the final logContent, the live buffer is no longer the
      // source of truth — drop it so subsequent /log reads hit the DB.
      liveBuffers.delete(saved.id);
      await releaseWorkloadLease(workloadLease);
    }
  })();

  return { run: saved, completion };
}

/**
 * Persist a terminal verdict only while this process still owns the `running`
 * row. Crash recovery performs the inverse compare-and-set, so whichever side
 * wins cannot later be overwritten by a stale in-memory Run object.
 */
async function finalizeRunFromRunning(
  runRepo: Repository<Run>,
  run: Run,
  log: DurableRunLog,
): Promise<{ run: Run; persisted: boolean }> {
  try {
    await log.stopCheckpointing();
  } catch (err) {
    // The terminal compare-and-set below carries the complete in-memory log,
    // so a failed progress checkpoint must not strand the row as `running`.
    log.line(`\n[warn] A progress checkpoint failed while finalizing: ${errorMessage(err)}`);
  }
  run.logContent = log.value();
  const result = await runRepo.update(
    { id: run.id, status: "running" },
    {
      // ResourceChangeSubscriber uses this unchanged relation key to route
      // Run updates to the correct Routine detail stream.
      routineId: run.routineId,
      finishedAt: run.finishedAt,
      status: run.status,
      logContent: run.logContent,
      exitCode: run.exitCode,
      retryAt: run.retryAt,
    },
  );
  if (result.affected === 1) return { run, persisted: true };

  // Reconciliation (or another terminal owner) won. Return the authoritative
  // row and, critically, do not run post-completion bookkeeping for our stale
  // verdict. A deleted Routine may have cascaded the Run away altogether; in
  // that case the local object is safe to return but must not be persisted.
  const current = await runRepo.findOneBy({ id: run.id });
  return { run: current ?? run, persisted: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * How the tool catalogue was split for this run.
 *
 * Worth a line in the transcript for the same reason the trim and compaction
 * lines are: from the outside, "the employee never used the tool" and "the
 * employee was never shown the tool" look identical. This is what tells them
 * apart when someone is reading a run that went wrong.
 */
function toolDeferLine(d: ToolDeferralInfo): string {
  if (d.deferred === 0) {
    return `[tools] ${d.resident} tools, all loaded up-front (discovery off or catalogue small).`;
  }
  const skills =
    d.fromSkills.length > 0
      ? ` (${d.fromSkills.length} from Skills: ${d.fromSkills.join(", ")})`
      : "";
  return (
    `[tools] ${d.resident} loaded${skills}, ${d.deferred} in the catalogue behind find_tools ` +
    `— ${d.domains.join(", ")}.`
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
            : run.status === "interrupted"
              ? "was interrupted"
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

/**
 * Record that a run finished and re-anchor the schedule.
 *
 * Re-reads the routine rather than saving back the entity captured when the
 * run started: with runs allowed to last six hours, saving the stale copy
 * silently resurrects a routine a human disabled mid-run — exactly what an
 * operator does while reacting to a problem. Writing only the two columns this
 * owns also keeps a concurrent settings edit from being clobbered.
 */
async function touchRoutine(routineId: string, at: Date | null): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const fresh = await repo.findOneBy({ id: routineId });
  if (!fresh) return;
  // Recompute nextRunAt from the moment the run finished. Collapses any missed
  // slots that elapsed during a long-running invocation into a single future
  // tick, so the heartbeat doesn't immediately refire the stale slot.
  const next = fresh.enabled ? nextRunFor(fresh.cronExpr, at ?? new Date()) : fresh.nextRunAt;
  await repo.update({ id: routineId }, { lastRunAt: at, nextRunAt: next });
}

/**
 * Post-run bookkeeping that must never be able to change the run's verdict.
 * Failures here are logged and swallowed — the run already happened.
 */
async function settleAfterRun(routineId: string, at: Date | null): Promise<void> {
  try {
    await touchRoutine(routineId, at);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[runner] failed to re-anchor routine ${routineId}:`, err);
  }
}

async function journalQuietly(employeeId: string, routine: Routine, run: Run): Promise<void> {
  try {
    await writeJournalForRun(employeeId, routine, run);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[runner] failed to journal run ${run.id}:`, err);
  }
}

/**
 * Schedule the next attempt on the run row itself, in the same save as its
 * terminal status, so an owed retry survives a crash. Writes a transcript line
 * so the reason a run reappears an hour later is legible from the log alone.
 */
function stampRetry(run: Run, routine: Routine, log: DurableRunLog): void {
  if (
    !shouldRetry({
      status: run.status,
      triggerKind: run.triggerKind,
      attempt: run.attempt,
      maxAttempts: routine.maxAttempts,
      retryOnTimeout: routine.retryOnTimeout,
    })
  ) {
    return;
  }
  const delay = automaticRetryDelayMs({
    status: run.status,
    attempt: run.attempt,
    maxAttempts: routine.maxAttempts,
    baseMs: routine.retryBackoffSec * 1000,
  });
  run.retryAt = new Date(Date.now() + delay);
  log.line(
    `\n[retry] attempt ${run.attempt + 1} of ${automaticRetryLimit(run.status, routine.maxAttempts)} scheduled in ~${Math.round(delay / 1000)}s`,
  );
}

function composeRoutineMessage(routine: Routine, missedSlots: number): string {
  return [
    `## Routine: ${routine.name}`,
    "",
    routine.body,
    "",
    "---",
    "Run this routine now. Produce the expected output.",
    // Without this a catch-up digest silently reports on the wrong window —
    // the last interval rather than the whole period nobody covered.
    ...(missedSlots > 0
      ? [
          "",
          `This run is catching up: ${missedSlots} scheduled occurrence(s) were missed while ` +
            "the server was unavailable. Cover the whole period since the last run rather than " +
            "only the most recent interval, and say so in your output.",
        ]
      : []),
  ].join("\n");
}
