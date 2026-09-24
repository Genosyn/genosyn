import { IsNull, type Repository } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import type { RunErrorKind, RunTrigger } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { employeeDir, ensureDir } from "./paths.js";
import { nextRunFor } from "./cron.js";
import { automaticRetryDelayMs, automaticRetryLimit, shouldRetry } from "./cronMath.js";
import { resolveRoutineModel } from "./models.js";
import { issueMcpToken, resolveMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { routineDeliveryPolicy, routineNeedsWorkReview } from "./proactive/policy.js";
import { createPrivilegedMemberToolAuthorizer } from "./memberTurnAuthority.js";
import { selfReviewToolScope } from "./proactive/reviewPolicy.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { composeGoalsContext, goalBriefBlock } from "./goals.js";
import { composePoliciesContext } from "./companyPolicies.js";
import { composeWorkstreamBlock } from "./workstreams.js";
import { composeLessonsBlock, reflectOnRun, shouldReflect } from "./runLessons.js";
import { contractAutonomyOnBadRun } from "./autonomy.js";
import { materializeEmployeeRepositoryContext } from "./repositories.js";
import { composeFinanceContext } from "./financeGrants.js";
import { composeSigningContext } from "./signing.js";
import { composeRevenueContext } from "./revenue/grants.js";
import { composeMarketingContext } from "./marketing.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import { contextUsagePercent, isContextUsageHigh } from "./agent/contextUsage.js";
import type { CompactionInfo, ToolDeferralInfo, ToolTrimInfo, TurnUsage } from "./agent/types.js";
import { config } from "../../config.js";
import { composeEmployeeSystemPrompt } from "./agent/systemPrompt.js";
import { residentNamesForSkills, skillToolsetMap } from "./skillToolset.js";
import { DurableRunLog, RUN_LOG_MAX_BYTES, formatToolResultLine } from "./runLog.js";
import { RunDiagnosticRecorder, readRunDiagnostics } from "./runDiagnostics.js";
import { workSummaryLogLine } from "./runWorkSummary.js";
import { supportsParallelDelegation } from "./agent/tools/parallelDelegation.js";
import { shouldMaterializeRepositoriesForTurn } from "./codexSubscription.js";
import { CODING_TOOL_NAMES } from "./agent/tools/coding.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
import { finalizeBrowserRecordingsForRun } from "./browserSessions.js";
import {
  browserRunCreationBlocked,
  releaseBrowserRecordingRunFinalizing,
} from "./browserRecordings.js";
import { notifyRunFailure } from "./runAlerts.js";
import { gradeAndPersistRunOutcome } from "./runGrading.js";
import {
  composeChecksBlock,
  composeRemediationMessage,
  listChecks,
  runChecksForRun,
} from "./routineChecks.js";
import type { RunCheckResult } from "../db/entities/RunCheckResult.js";
import {
  StanddownError,
  placeStanddown,
  registerRunInterrupter,
  unregisterRunInterrupter,
  workBlocked,
} from "./standdowns.js";
import { getContainmentSettings } from "./runtimeSettings.js";
import { continuationEffects, priorAttemptEffects, renderPriorAttemptBlock } from "./runEffects.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { runAllowanceBrief, shouldYieldRunBatch } from "./runBatchBudget.js";
import { manualResumeEligibility, RunManualResumeError } from "./runManualResume.js";
import {
  checkpointAdvanced,
  continuationBrief,
  continuationEligibility,
  readRunCheckpoint,
  CONTINUATION_DELAY_MS,
  CONTINUATION_TOKEN_LIMIT,
} from "./runContinuation.js";

export { RUN_LOG_MAX_BYTES } from "./runLog.js";

/**
 * Run seam.
 *
 * For each Routine run we:
 *  1. Load the employee, company, active model, and skill list.
 *  2. Compose a system prompt (Soul + Memory + Skills + tools briefing) and the
 *     routine instruction, all pulled from the DB.
 *  3. Run OpenCode (or official Codex for subscription access), supplying the
 *     authorized Genosyn, browser, and company MCP tools and the selected coding
 *     mode, while buffering the transcript into the Run's `logContent`.
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
 * How many briefed rounds a Run gets to turn a failing Check green.
 *
 * Two, deliberately. One is often enough for the ordinary case (the employee
 * forgot a step and is told which); a third has, in practice, nothing new to
 * try and spends a model turn discovering that. The Run's absolute deadline
 * bounds the whole thing regardless.
 */
const ROUTINE_CHECK_REMEDIATION_MAX = 2;

/** A remediation round is a focused fix, not a second Run. */
const ROUTINE_CHECK_REMEDIATION_STEPS = 30;

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
  /** Server-only: an admin grants a fresh allowance to this saved unfinished work. */
  resumeFromRunId?: string;
  /** Internal: resume an owned durable checkpoint within its original limits. */
  continuationFromRunId?: string;
  triggerKind?: RunTrigger;
  /** Server-only proof of the exact human-approved plan this Run may perform. */
  proactiveApprovalId?: string;
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
   * Throwing aborts the start before the Run row is written.
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
  if (browserRunCreationBlocked({ employeeId: routine.employeeId, routineId: routine.id })) {
    throw new Error("This Routine is being removed.");
  }
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
  const proactiveApproval = opts.proactiveApprovalId
    ? await (
        await import("./proactive/approvals.js")
      ).validateProactiveRoutineApproval(opts.proactiveApprovalId, routine, co.id)
    : null;
  const runAuthority = {
    companyId: co.id,
    employeeId: emp.id,
    routineId: routine.id,
  };
  if (browserRunCreationBlocked(runAuthority)) {
    throw new Error("This Routine is being removed.");
  }
  // A Standdown refuses the Run before its row exists (M58). Deliberately no
  // `skipped` Run: a skipped row is a record of work that was attempted and
  // could not proceed, and every consumer treats it that way — the Home panel,
  // System Health, the Usage rollups. A stop is not a failure of this Routine,
  // and filling a company's history with rows saying otherwise would make the
  // stop itself look like the incident.
  const stopped = workBlocked(co.id, { employeeId: emp.id, routineId: routine.id });
  if (stopped.blocked) {
    throw new StanddownError(
      `AI work is stood down for this ${stopped.scope === "company" ? "company" : stopped.scope === "employee" ? "AI Employee" : "Routine"}: ${stopped.reason}`,
    );
  }
  // An employee can hold several models. The routine runs on the one it pins,
  // falling back to the employee's active model when it pins none.
  const { model, pinned } = await resolveRoutineModel(routine);
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });

  const parentId = opts.resumeFromRunId ?? opts.continuationFromRunId;
  const continuationParent = parentId
    ? await runRepo.findOneBy({ id: parentId, routineId: routine.id })
    : null;
  const manualResume = !!opts.resumeFromRunId;
  if (manualResume) {
    if (!model?.connectedAt)
      throw new RunManualResumeError("Connect an AI Model before resuming unfinished work.");
    if (
      !continuationParent ||
      opts.continuationFromRunId ||
      proactiveApproval ||
      !manualResumeEligibility(continuationParent, routine).eligible
    )
      throw new RunManualResumeError("This Run cannot resume unfinished work.");
  } else if (opts.triggerKind === "continuation" || opts.continuationFromRunId) {
    if (
      !continuationParent ||
      opts.triggerKind !== "continuation" ||
      proactiveApproval ||
      !continuationEligibility(continuationParent, routine).eligible
    ) {
      throw new Error("This Run cannot start an automatic continuation.");
    }
  }

  const missedSlots = opts.missedSlots ?? 0;
  const run = runRepo.create({
    routineId: routine.id,
    startedAt,
    status: "running",
    errorKind: null,
    failureReason: null,
    logContent: "",
    triggerKind: manualResume ? "continuation" : (opts.triggerKind ?? "manual"),
    attempt: opts.attempt ?? 1,
    parentRunId: continuationParent?.id ?? opts.parentRunId ?? null,
    missedSlots,
    tokensIn: 0,
    tokensOut: 0,
    checkpointJson: null,
    continuationCount:
      continuationParent && !manualResume ? (continuationParent.continuationCount ?? 0) + 1 : 0,
    continuationOriginTriggerKind: continuationParent
      ? (continuationParent.continuationOriginTriggerKind ?? continuationParent.triggerKind)
      : null,
    continuationReviewOnly:
      !!continuationParent?.continuationReviewOnly ||
      routineNeedsWorkReview(
        routine,
        continuationParent?.continuationOriginTriggerKind ??
          continuationParent?.triggerKind ??
          opts.triggerKind ??
          "manual",
      ),
    continuationDeadlineAt:
      continuationParent && !manualResume
        ? (continuationParent.continuationDeadlineAt ??
          new Date(continuationParent.startedAt.getTime() + timeoutMs))
        : new Date(startedAt.getTime() + timeoutMs),
    continuationTokensUsed:
      continuationParent && !manualResume
        ? (continuationParent.continuationTokensUsed ?? 0) +
          continuationParent.tokensIn +
          continuationParent.tokensOut
        : 0,
  });
  let saved: Run;
  await opts.beforeRunPersist?.();
  if (manualResume) {
    const currentParent = await runRepo.findOneBy({ id: parentId!, routineId: routine.id });
    if (
      !currentParent ||
      !manualResumeEligibility(currentParent, routine).eligible ||
      currentParent.checkpointJson !== continuationParent!.checkpointJson
    )
      throw new RunManualResumeError("The unfinished Run changed before it could be resumed.");
  }
  run.continuationReviewOnly ||= routineNeedsWorkReview(
    routine,
    run.continuationOriginTriggerKind ?? run.triggerKind,
  );
  if (browserRunCreationBlocked(runAuthority)) {
    throw new Error("This Routine is being removed.");
  }
  saved = await runRepo.save(run);
  if (browserRunCreationBlocked(runAuthority)) {
    await runRepo.delete({ id: saved.id }).catch(() => undefined);
    throw new Error("This Routine is being removed.");
  }
  const deadlineAtMs = Math.min(
    saved.startedAt.getTime() + timeoutMs,
    saved.continuationDeadlineAt?.getTime() ?? Infinity,
  );

  const diagnostics = new RunDiagnosticRecorder();
  const checkpointState: { headerDurable: boolean; initialFailure?: unknown } = {
    headerDurable: false,
  };
  const log = new DurableRunLog({
    cap: RUN_LOG_MAX_BYTES,
    persist: async (content) => {
      // Never let a late checkpoint overwrite a terminal row recovered or
      // finalized elsewhere. Diagnostics share the transcript checkpoint boundary.
      await runRepo.update(
        { id: saved.id, status: "running" },
        { logContent: content, diagnosticsJson: diagnostics.json() },
      );
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
      ...(continuationParent
        ? [
            manualResume
              ? `[resume] An admin resumed unfinished Run ${continuationParent.id} with a fresh ${CONTINUATION_TOKEN_LIMIT} token allowance; deadline ${new Date(deadlineAtMs).toISOString()}.`
              : `[continuation] Resuming ${continuationParent.id}; original deadline ${new Date(deadlineAtMs).toISOString()}.`,
          ]
        : []),
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
    diagnostics.fail(
      setupTimedOut
        ? new Error(
            `Run setup exceeded its ${routine.timeoutSec}s time budget: ${errorMessage(err)}`,
          )
        : err,
      setupTimedOut ? "timeout" : "application",
    );
    log.line(
      setupTimedOut
        ? `\n[timeout] Stopped after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`
        : `\n[error] Run setup failed before work began: ${errorMessage(err)}`,
    );
    saved.finishedAt = new Date();
    saved.status = "error";
    saved.errorKind = setupTimedOut ? "timeout" : "runtime";
    saved.exitCode = null;
    try {
      const finalization = await finalizeRunFromRunning(runRepo, saved, log, routine, diagnostics);
      saved = finalization.run;
      if (finalization.persisted) {
        await settleAfterRun(routine.id, saved.finishedAt);
        await journalQuietly(emp.id, routine, saved);
        await contractAutonomyOnBadRun({ run: saved, employee: emp });
        await updateRoutineBreaker(saved, routine, co.id, emp.id);
      }
    } finally {
      liveBuffers.delete(saved.id);
    }
    throw err;
  }

  const completion = (async (): Promise<Run> => {
    let mcpToken: string | null = null;
    let interrupted = false;
    const deadlineReached = (): boolean => Date.now() >= deadlineAtMs;
    const finalizeTimedOutRun = async (): Promise<Run> => {
      saved.finishedAt = new Date();
      log.line(
        `\n[timeout] Stopped after ${routine.timeoutSec}s. Increase the routine's timeoutSec if this is expected.`,
      );
      saved.status = "error";
      saved.errorKind = "timeout";
      diagnostics.fail(
        `The Run exceeded its ${routine.timeoutSec}s time budget (deadline ${new Date(deadlineAtMs).toISOString()}).`,
        "timeout",
      );
      saved.exitCode = null;
      const finalization = await finalizeRunFromRunning(runRepo, saved, log, routine, diagnostics);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      await settleAfterRun(routine.id, saved.finishedAt);
      await journalQuietly(emp.id, routine, saved);
      await contractAutonomyOnBadRun({ run: saved, employee: emp });
      // The breaker has to see this. A timeout is the *characteristic* shape of
      // the failure it exists for — a deleted integration, a renamed report, a
      // Connection whose token expired all hang rather than returning a tidy
      // provider error — and every one of this function's four callers returns
      // straight out of the completion body, so leaving the count to the happy
      // path meant the breaker never fired on exactly the population it was
      // built for.
      await updateRoutineBreaker(saved, routine, co.id, emp.id);
      return saved;
    };
    try {
      if (deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      const proactiveReview =
        !proactiveApproval &&
        (saved.continuationReviewOnly ||
          routineNeedsWorkReview(
            routine,
            saved.continuationOriginTriggerKind ?? saved.triggerKind,
          ));
      const deliveryPolicy = routineDeliveryPolicy(
        routine,
        proactiveReview,
        proactiveApproval?.payload.origin.mailThreadId
          ? "review"
          : (proactiveApproval?.payload.origin.mailDeliveryMode ??
              (saved.continuationReviewOnly ? "review" : null)),
      );
      mcpToken = issueMcpToken(emp.id, co.id, {
        runId: saved.id,
        routineId: routine.id,
        ...(proactiveApproval
          ? {
              authority: "member" as const,
              requesterUserId: proactiveApproval.user.id,
              requesterSessionVersion: proactiveApproval.user.sessionVersion,
            }
          : { authority: "employee" as const }),
        mailDeliveryMode: deliveryPolicy.mailDeliveryMode,
        selfReviewOnly: routine.selfReviewOnly,
        proactiveReview,
        mailThreadId: proactiveApproval?.payload.origin.mailThreadId ?? null,
        mailHandoverId: proactiveApproval?.payload.origin.mailHandoverId ?? null,
      });
      // No model connected → skip cleanly.
      if (!model) {
        log.line(
          `[${continuationParent ? "failed" : "skipped"}] This employee has no AI Model connected. Open the employee in the app and connect one.`,
        );
        saved.finishedAt = new Date();
        saved.status = continuationParent ? "failed" : "skipped";
        if (continuationParent) {
          saved.continuationStopReason =
            "The AI Employee no longer has a connected AI Model. Unfinished work needs attention.";
        }
        const finalization = await finalizeRunFromRunning(
          runRepo,
          saved,
          log,
          routine,
          diagnostics,
        );
        saved = finalization.run;
        if (!finalization.persisted) return saved;
        await settleAfterRun(routine.id, saved.finishedAt);
        return saved;
      }

      const parallelDelegationAvailable =
        deliveryPolicy.allowPrivilegedToolSources && supportsParallelDelegation(model.authMode);
      const unavailableCodingTools =
        !deliveryPolicy.allowPrivilegedToolSources || !codingRuntimeAvailability().available
          ? [...CODING_TOOL_NAMES]
          : config.agent.codingTools.executionMode === "bubblewrap"
            ? CODING_TOOL_NAMES.filter((name) => name !== "bash")
            : [];
      const unavailableSkillTools = [
        ...(parallelDelegationAvailable ? [] : ["delegate_parallel_work"]),
        ...unavailableCodingTools,
      ];
      const repositoryMaterializationAllowed =
        deliveryPolicy.allowPrivilegedToolSources &&
        shouldMaterializeRepositoriesForTurn(model.authMode);
      const memoryContext = await composeMemoryContext(emp.id);
      const goalsContext = await composeGoalsContext(co.id, emp.id);
      const policiesContext = await composePoliciesContext(co.id);
      const cwd = employeeDir(co.slug, emp.slug);
      ensureDir(cwd);
      let repositoriesContext = "";
      if (repositoryMaterializationAllowed) {
        const prepared = await materializeEmployeeRepositoryContext({ employeeId: emp.id, cwd });
        repositoriesContext = prepared.context;
        for (const r of prepared.forgeSync.repos) {
          log.line(`[repos] synced ${r.owner}/${r.name}@${r.defaultBranch}`);
        }
        for (const e of prepared.forgeSync.errors) log.line(`[repos] ${e.scope}: ${e.message}`);
        for (const r of prepared.repositorySync.repos) {
          log.line(`[repositories] synced ${r.slug}@${r.defaultBranch} (${r.accessLevel})`);
        }
        for (const e of prepared.repositorySync.errors)
          log.line(`[repositories] ${e.scope}: ${e.message}`);
      } else {
        log.line("[repos] automatic repository sync is disabled for this Run");
      }
      const financeContext = await composeFinanceContext(emp.id);
      const [signingContext, revenueContext, marketingContext] = await Promise.all([
        composeSigningContext({ companyId: co.id, employeeId: emp.id }),
        composeRevenueContext(emp.id),
        composeMarketingContext(emp.id),
      ]);
      if (deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      let system = composeEmployeeSystemPrompt({
        co,
        emp,
        skills,
        memoryContext,
        goalsContext,
        policiesContext,
        repositoriesContext,
        financeContext,
        signingContext,
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
      if (proactiveApproval) system += `\n\n${proactiveApproval.brief}`;
      const goalBlock = await goalBriefBlock(co.id, routine.goalId);
      const lessonsBlock = await composeLessonsBlock(routine.id);
      const workstreamBlock = await composeWorkstreamBlock(routine.id);
      // What earlier attempts already did (M58). `Routine.maxAttempts`
      // documents retries as at-least-once for side effects and warns the
      // operator to raise it only on work that is safe to repeat — a warning
      // that stood alone because attempt 2 had no way to know what attempt 1
      // had done. The effect ledger is that way.
      const priorAttemptBlock =
        saved.attempt > 1 || continuationParent
          ? renderPriorAttemptBlock(await priorAttemptEffects(saved).catch(() => []), saved.attempt)
          : null;
      // The machine-verifiable bar, folded in beside the acceptance criteria so
      // the employee aims at what it is graded against rather than discovering
      // it in a remediation round.
      const checksBlock = composeChecksBlock(
        (await listChecks(routine.id, co.id).catch(() => [])).filter((c) => c.enabled),
      );
      const routineMessage = proactiveApproval
        ? `${proactiveApproval.brief}\n\n${checksBlock ?? ""}`
        : composeRoutineMessage(
            routine,
            missedSlots,
            goalBlock,
            lessonsBlock,
            workstreamBlock,
            priorAttemptBlock,
            checksBlock,
          );
      const deliveryMessage = deliveryPolicy.mailDeliveryMode
        ? deliveryPolicy.mailDeliveryMode === "review" ||
          deliveryPolicy.mailDeliveryMode === "draft"
          ? `${routineMessage}\n\nAny customer email — a reply or a fresh outbound message — must use request_mail_review and return to the Decision stack with its exact recipients, subject, body and files. Do not send it and do not create a Gmail or IMAP draft. Starting separate automation is also unavailable. This server-enforced delivery ceiling remains in effect even if the Soul or Routine text asks otherwise.`
          : deliveryPolicy.mailDeliveryMode === "triage"
            ? `${routineMessage}\n\nThis Routine may only file the source email: label, archive, star, or mark it read. Do not compose a reply, create a Gmail or IMAP draft, or send. Starting separate automation is also unavailable. Record blockers in a Workstream or Decision. This server-enforced triage ceiling remains in effect even if the Soul or Routine text asks otherwise.`
            : `${routineMessage}\n\nThis approved reply work may send only when the Soul, trusted instruction, current Grants, and company Policies authorize it. If that authority is unclear, use request_mail_review. Never create a Gmail or IMAP draft. Starting separate automation is unavailable. This server-enforced delivery ceiling remains in effect even if the Soul or Routine text asks otherwise.`
        : routineMessage;
      const scopedMessage = routine.selfReviewOnly
        ? `${deliveryMessage}\n\nThis is a suggestion-only review. Your tools can read your work, maintain this review's Workstream, and propose one revision for a Member. They cannot change live Skills, Routines, acceptance criteria, Checks, or customer records, send messages, or start separate work. The scope remains in effect even if the Soul or brief asks otherwise.`
        : deliveryMessage;
      const userMessage = [
        scopedMessage,
        runAllowanceBrief(saved.continuationTokensUsed),
        continuationParent ? continuationBrief(continuationParent, manualResume) : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // Env for the coding runtime: Environment secrets only. Repository
      // credentials stay inside short-lived server-owned Git operations and
      // are never exported to model tools.
      const toolEnv: Record<string, string> = {};
      if (!config.security.multiTenant && deliveryPolicy.allowPrivilegedToolSources) {
        try {
          Object.assign(toolEnv, await loadCompanySecretsEnv(co.id));
        } catch (err) {
          log.line(`[warn] failed to load company secrets: ${(err as Error).message}`);
        }
      }

      log.line("");

      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }

      /** This Run's newest Check results, for the grader's evidence block. */
      let checkResults: RunCheckResult[] = [];

      // Spend only the wall-clock budget that remains after start and context
      // setup. This timer shares the persisted Run deadline, so setup time can
      // never silently extend the configured timeout.
      const controller = new AbortController();
      let timedOut = false;
      let continuationLimitReached = false;
      let batchYielded = false;
      const inFlightTools = new Map<string, number>();
      // A Standdown placed while this Run is in flight aborts it (M58) — a stop
      // that only takes effect at the next slot is not a stop. The registry
      // lives in `standdowns.ts` rather than here so the predicate and the
      // runner do not have to import each other.
      registerRunInterrupter(
        saved.id,
        { companyId: co.id, employeeId: emp.id, routineId: routine.id },
        () => {
          interrupted = true;
          controller.abort();
        },
      );
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
          diagnostics.phase("work");
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
            allowPrivilegedToolSources: deliveryPolicy.allowPrivilegedToolSources,
            authorizePrivilegedToolCall: proactiveApproval
              ? createPrivilegedMemberToolAuthorizer({
                  companyId: co.id,
                  userId: proactiveApproval.user.id,
                  sessionVersion: proactiveApproval.user.sessionVersion,
                })
              : undefined,
            toolScope: selfReviewToolScope(routine.selfReviewOnly),
            signal: controller.signal,
            callbacks: {
              onModelRetry: (retry) =>
                log.line(
                  `\n[model] ${retry.reason}; retrying attempt ${retry.attempt}${retry.maxAttempts === null ? "" : ` of ${retry.maxAttempts}`} in ${(retry.delayMs / 1000).toFixed(1)}s`,
                ),
              onText: (delta) => {
                streamedAny = true;
                log.write(delta);
              },
              onToolUse: (name, input, callId) => {
                const key = callId ?? name;
                inFlightTools.set(key, (inFlightTools.get(key) ?? 0) + 1);
                diagnostics.toolStarted(name, callId);
                log.line(`\n[tool] ${name} ${previewArgs(input)}`);
              },
              // The result, not just its shape. The loop already hands over the
              // content and the transcript threw it away, which is why the
              // outcome checker was told to look for "supporting tool activity"
              // that had never been written down.
              onToolResult: (name, r, callId) => {
                const key = callId ?? name;
                const pending = inFlightTools.get(key) ?? 0;
                if (pending > 1) inFlightTools.set(key, pending - 1);
                else inFlightTools.delete(key);
                diagnostics.toolFinished(name, r, callId);
                log.line(formatToolResultLine(name, r));
                if (
                  !controller.signal.aborted &&
                  inFlightTools.size === 0 &&
                  shouldYieldRunBatch({
                    toolName: name,
                    result: r,
                    tokensThisRun: saved.tokensIn + saved.tokensOut,
                    previousTokens: saved.continuationTokensUsed,
                    continuationCount: saved.continuationCount,
                    deadlineAtMs,
                    canContinue:
                      routine.enabled &&
                      !routine.requiresApproval &&
                      !routine.selfReviewOnly &&
                      !proactiveApproval,
                  })
                ) {
                  batchYielded = true;
                  log.line(
                    "\n[continuation] Batch progress saved; handing unfinished work to a fresh Run within the remaining allowance.",
                  );
                  controller.abort();
                }
              },
              onUsage: (u) => {
                // Every turn's prompt is billed in full, so the Run's cost is
                // the sum across turns — accumulated here, persisted with the
                // terminal status.
                saved.tokensIn += u.inputTokens;
                saved.tokensOut += u.outputTokens;
                if (
                  saved.continuationTokensUsed + saved.tokensIn + saved.tokensOut >=
                  CONTINUATION_TOKEN_LIMIT
                ) {
                  continuationLimitReached = true;
                  controller.abort();
                }
                log.line(usageLine(u, model.contextWindow));
              },
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
        if (!timedOut && !deadlineReached() && !continuationLimitReached && !batchYielded)
          throw err;
      } finally {
        clearTimeout(timer);
      }

      if (timedOut || deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      if (continuationLimitReached || batchYielded) {
        saved.status = "failed";
        saved.errorKind = null;
        saved.exitCode = null;
        saved.finishedAt = new Date();
        saved.continuationStopReason = continuationLimitReached
          ? "The shared token limit for automatic continuation was reached."
          : null;
        const finalization = await finalizeRunFromRunning(
          runRepo,
          saved,
          log,
          routine,
          diagnostics,
        );
        saved = finalization.run;
        if (finalization.persisted) {
          await settleAfterRun(routine.id, saved.finishedAt);
          await journalQuietly(emp.id, routine, saved);
          await updateRoutineBreaker(saved, routine, co.id, emp.id);
        }
        return saved;
      }
      if (!result) throw new Error("The AI Model returned no Run result.");

      saved.finishedAt = new Date();
      if (interrupted || (result.status === "ok" && result.stopReason === "aborted")) {
        log.line("\n[interrupted] The Run was stopped before its work finished.");
        saved.status = "error";
        saved.errorKind = "interrupted";
        diagnostics.fail("The Run was stopped before its work finished.", "interrupted");
        saved.exitCode = null;
      } else if (result.status === "error") {
        diagnostics.fail(result.error, "model");
        log.line(`\n[error] ${result.error}`);
        saved.status = "error";
        saved.errorKind = "runtime";
        saved.exitCode = null;
      } else if (result.stopReason === "max_steps") {
        // The runaway backstop stopped the loop, not the model deciding it was
        // done. Calling that "completed" made confident non-finishes read as
        // green checkmarks; it is a failure, and the retry policy treats it
        // like any other.
        if (!streamedAny && result.finalText.trim()) log.line("\n" + result.finalText.trim());
        log.line(
          `\n[failed] Stopped after reaching the ${RUN_MAX_STEPS}-turn step limit without finishing.`,
        );
        saved.status = "failed";
        diagnostics.fail(
          `The ${RUN_MAX_STEPS}-turn step limit was reached before the work finished.`,
          "work",
        );
        saved.exitCode = null;
      } else {
        if (!streamedAny && result.finalText.trim()) log.line("\n" + result.finalText.trim());
        saved.status = proactiveReview ? "reviewed" : "completed";
        saved.exitCode = 0;
        log.line(workSummaryLogLine(result.finalText));
        if (proactiveReview) {
          saved.outcomeVerdict = "unverified";
          saved.outcomeNote =
            "Evidence reviewed and permitted preparation recorded. Consequential work remains subject to human approval. The intended outcome is not independently verified; delivery Checks have not run.";
          log.line(`\n[reviewed] ${saved.outcomeNote}`);
        }
      }

      // The employee's report is durable tool output, not part of the stale
      // Run object captured before the model turn. A recovered terminal row
      // wins before we spend more work on Checks or remediation.
      const afterWork = await runRepo.findOneBy({ id: saved.id });
      if (!afterWork || afterWork.status !== "running") return afterWork ?? saved;
      saved.failureReason = afterWork.failureReason;
      saved.checkpointJson = afterWork.checkpointJson;
      saved.requiredToolsJson = afterWork.requiredToolsJson;
      const checkpoint = readRunCheckpoint(saved);
      if (
        !checkpoint &&
        saved.triggerKind === "continuation" &&
        (saved.status === "completed" || saved.status === "reviewed")
      ) {
        saved.status = "failed";
        saved.continuationStopReason =
          "The continuation ended without recording whether the remaining work was completed.";
      }
      if (
        checkpoint &&
        checkpoint.state !== "complete" &&
        (saved.status === "completed" || saved.status === "reviewed")
      ) {
        saved.status = "failed";
        log.line(`\n[unfinished] ${checkpoint.remaining}`);
      }
      if (saved.failureReason && (saved.status === "completed" || saved.status === "reviewed")) {
        saved.status = "failed";
        log.line(`\n[failed] ${saved.failureReason}`);
      }

      // ---- Checks (M58) ----
      //
      // The bar no model has a say in, run before the Run is allowed to
      // finalize green. It sits here, above `stampRetry` and the terminal
      // save, because a Run that failed its Checks is a Run whose retry policy
      // should see the failure. The Check verdict remains independent evidence
      // of why the intended work did not complete.
      //
      // Remediation is a fresh briefed turn rather than a resumption of the
      // same transcript. That is the fourth time this codebase has made that
      // call (decision pickups, handoff and todo kickoffs, AI review sessions),
      // and the reason is the same each time: each runtime turn has its own
      // session and returns final text rather than a resumable conversation.
      // A fresh brief carries the Check evidence across that boundary for both
      // OpenCode and the Codex subscription runtime.
      if (saved.status === "completed") {
        diagnostics.phase("checks");
        const checkPhase = await runCheckPhase({
          run: saved,
          routine,
          emp,
          co,
          model,
          cwd,
          toolEnv,
          system,
          mcpToken,
          log,
          deadlineAtMs,
          deadlineReached,
          diagnostics,
          skills,
          unavailableSkillTools,
        });
        saved.checksVerdict = checkPhase.verdict;
        saved.checkRemediations = checkPhase.remediations;
        checkResults = checkPhase.results;
        saved.tokensIn += checkPhase.tokensIn;
        saved.tokensOut += checkPhase.tokensOut;
        if (deadlineReached()) return await finalizeTimedOutRun();
        if (checkPhase.errorKind) {
          saved.status = "error";
          saved.errorKind = checkPhase.errorKind;
          saved.exitCode = null;
        } else if (checkPhase.verdict === "failed" || checkPhase.incomplete) {
          saved.status = "failed";
          const failedChecks = checkPhase.results
            .filter((check) => check.required && !check.passed)
            .map((check) => check.name);
          diagnostics.fail(
            checkPhase.verdict === "failed"
              ? `Required Checks did not pass: ${failedChecks.join(", ") || "Check evidence is unavailable"}.`
              : saved.continuationStopReason ||
                  "Check remediation stopped before the work finished.",
            checkPhase.verdict === "failed" ? "check" : "work",
          );
        }
      }

      saved.finishedAt = new Date();
      const finalization = await finalizeRunFromRunning(runRepo, saved, log, routine, diagnostics);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      // Deliberately not inside the try that owns the status: a throw from
      // either of these used to fall into the catch below, which unconditionally
      // rewrote an already-persisted `completed` run to `failed`. That matters
      // far more now that `failed` can mean "retry this", i.e. spend money.
      // Re-anchor the schedule *before* the outcome check. The check is a
      // model turn worth up to two minutes, and `touchRoutine` writes
      // `nextRunAt` derived from this run's `finishedAt` — so running it
      // afterwards would let a heartbeat dispatch the next slot in between and
      // then rewind the schedule behind it, firing that slot a second time.
      await settleAfterRun(routine.id, saved.finishedAt);
      if (saved.status === "completed") {
        await assessOutcomeQuietly(saved, routine, emp, model, checkResults);
      }
      await journalQuietly(emp.id, routine, saved);
      // The improvement loop (M52): a failed, off-goal, or check-failing Run
      // earns one reflection turn. After the journal so the lesson never
      // delays the page a human is owed; rate-limited inside so retry chains
      // stay quiet. The same Runs contract earned autonomy (M53): demotion is
      // automatic and only tightens, so it runs before the reflection spends a
      // model turn — the gates must re-arm even if reflection cannot run.
      const reflect = shouldReflect(
        saved.status,
        saved.outcomeVerdict,
        saved.checksVerdict,
        saved.errorKind,
      );
      if (!saved.retryAt && (saved.status === "error" || saved.status === "failed" || reflect)) {
        await contractAutonomyOnBadRun({ run: saved, employee: emp });
      }
      if (reflect && !saved.retryAt) {
        await reflectOnRun({ run: saved, routine, employee: emp, model });
      }
      // The breaker (M58). Same seam and same reasoning as the demotion above:
      // tightening happens where the evidence appears, never on a sweep that
      // might not run.
      await updateRoutineBreaker(saved, routine, co.id, emp.id);
      return saved;
    } catch (err) {
      if (deadlineReached()) {
        const timedOutRun = await finalizeTimedOutRun();
        return timedOutRun;
      }
      diagnostics.fail(err, interrupted ? "interrupted" : "application");
      log.line(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
      saved.finishedAt = new Date();
      saved.status = "error";
      saved.errorKind = interrupted ? "interrupted" : "runtime";
      saved.exitCode = null;
      const finalization = await finalizeRunFromRunning(runRepo, saved, log, routine, diagnostics);
      saved = finalization.run;
      if (!finalization.persisted) return saved;
      await settleAfterRun(routine.id, saved.finishedAt);
      await journalQuietly(emp.id, routine, saved);
      await contractAutonomyOnBadRun({ run: saved, employee: emp });
      // Same reason as the timeout path: a Run that threw is a failed Run, and
      // a Routine whose every attempt throws is precisely what the breaker is
      // watching for.
      await updateRoutineBreaker(saved, routine, co.id, emp.id);
      return saved;
    } finally {
      if (mcpToken) revokeMcpToken(mcpToken);
      unregisterRunInterrupter(saved.id);
      // Once the row has the final logContent, the live buffer is no longer the
      // source of truth — drop it so subsequent /log reads hit the DB.
      liveBuffers.delete(saved.id);
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
  routine: Routine,
  diagnostics: RunDiagnosticRecorder,
): Promise<{ run: Run; persisted: boolean }> {
  try {
    await finalizeBrowserRecordingsForRun(run.id);
  } catch {
    // A recording is an auxiliary Run artifact. Its encoder, filesystem, or
    // browser can fail without changing the Routine verdict or retry policy.
    // Do not mention it in the shared Run log: recording metadata is restricted
    // to browser owners/admins, while Run logs also allow API-key readers.
  }
  try {
    await log.stopCheckpointing();
  } catch (err) {
    // The terminal compare-and-set below carries the complete in-memory log,
    // so a failed progress checkpoint must not strand the row as `running`.
    log.line(`\n[warn] A progress checkpoint failed while finalizing: ${errorMessage(err)}`);
  }
  // mark_run_failed writes once while the model turn is active. Re-read after
  // remediation/recording shutdown, then include its value in the terminal
  // compare-and-set. If a report lands between read and write, retry once with
  // that durable reason; if recovery finalized the Run, its verdict wins.
  const originalStatus = run.status;
  const originalStopReason = run.continuationStopReason;
  for (;;) {
    const current = await runRepo.findOneBy({ id: run.id });
    if (!current || current.status !== "running") {
      releaseBrowserRecordingRunFinalizing(run.id);
      return { run: current ?? run, persisted: false };
    }
    run.failureReason = current.failureReason;
    run.checkpointJson = current.checkpointJson;
    run.requiredToolsJson = current.requiredToolsJson;
    run.status = originalStatus;
    run.retryAt = null;
    run.continuationStopReason = originalStopReason;
    if (run.failureReason && (run.status === "completed" || run.status === "reviewed")) {
      run.status = "failed";
      log.line(`\n[failed] ${run.failureReason}`);
    }
    const checkpoint = readRunCheckpoint(run);
    if (
      checkpoint &&
      checkpoint.state !== "complete" &&
      (run.status === "completed" || run.status === "reviewed")
    ) {
      run.status = "failed";
    }
    if (checkpoint?.state === "continue" && !run.errorKind && run.status === "failed") {
      run.continuationDeadlineAt ??= new Date(run.startedAt.getTime() + routine.timeoutSec * 1000);
      if (run.triggerKind === "continuation" && run.parentRunId) {
        const parent = await runRepo.findOneBy({ id: run.parentRunId, routineId: run.routineId });
        const previous = parent ? readRunCheckpoint(parent) : null;
        if (!previous || !checkpointAdvanced(checkpoint, previous)) {
          run.continuationStopReason =
            "The continuation made no measurable progress from its saved checkpoint.";
        }
      }
      const eligible = continuationEligibility(run, routine);
      run.retryAt = eligible.eligible ? new Date(Date.now() + CONTINUATION_DELAY_MS) : null;
      run.continuationStopReason = eligible.reason;
      log.line(
        eligible.eligible
          ? "\n[continuation] Unfinished work saved; continuation queued automatically."
          : `\n[continuation] ${eligible.reason}`,
      );
    } else if (checkpoint?.state === "blocked") {
      run.retryAt = null;
      run.continuationStopReason = `Blocked: ${checkpoint.remaining}`;
    } else if (
      run.triggerKind === "continuation" &&
      run.status !== "completed" &&
      run.status !== "reviewed"
    ) {
      run.retryAt = null;
      run.continuationStopReason ??=
        "The continuation stopped without a new actionable checkpoint.";
    } else if (
      run.triggerKind !== "continuation" &&
      !run.continuationStopReason &&
      (!checkpoint || checkpoint.state === "complete")
    )
      stampRetry(run, routine, log);
    run.logContent = log.value();
    run.diagnosticsJson = diagnostics.json();
    run.diagnosticsJson = JSON.stringify(readRunDiagnostics(run));
    const result = await runRepo.update(
      {
        id: run.id,
        status: "running",
        failureReason: current.failureReason ?? IsNull(),
        checkpointJson: current.checkpointJson ?? IsNull(),
      },
      {
        // ResourceChangeSubscriber routes this update to its Routine stream.
        routineId: run.routineId,
        finishedAt: run.finishedAt,
        status: run.status,
        errorKind: run.errorKind,
        diagnosticsJson: run.diagnosticsJson,
        // failureReason is tool-owned. The CAS protects it without replacing it.
        logContent: run.logContent,
        exitCode: run.exitCode,
        retryAt: run.retryAt,
        continuationDeadlineAt: run.continuationDeadlineAt,
        continuationStopReason: run.continuationStopReason,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        checksVerdict: run.checksVerdict,
        checkRemediations: run.checkRemediations,
        ...(run.status === "reviewed"
          ? { outcomeVerdict: run.outcomeVerdict, outcomeNote: run.outcomeNote }
          : {}),
      },
    );
    if (result.affected !== 1) continue;
    releaseBrowserRecordingRunFinalizing(run.id);
    if (
      (run.status === "failed" || run.status === "error" || run.status === "timeout") &&
      !run.retryAt
    ) {
      // An alerting outage must never change the Run's verdict.
      void notifyRunFailure(run).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[runner] failed to notify about run ${run.id}:`, err);
      });
    }
    return { run, persisted: true };
  }
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
  const pct = contextUsagePercent(u.inputTokens, contextWindow);
  // Say "unknown" rather than implying a ceiling we were never told. This is
  // also a nudge: with no window there's no budget, so the loop can only react
  // to an overflow after the fact instead of preventing one.
  if (pct === null) {
    return `${base} (context window unknown — set it on the model to let this run budget its context)`;
  }
  const line = `${base} — ${pct}% of ${contextWindow}`;
  return isContextUsageHigh(pct)
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
  if (c.evicted === null)
    return "[compact] OpenCode compacted the conversation to fit the model context window.";
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
    run.status === "reviewed"
      ? "was reviewed; proposed work needs human approval"
      : run.status === "completed"
        ? "completed"
        : run.status === "error"
          ? "ended with an error"
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
  if (run.failureReason) bodyLines.push(`unfinished work: ${run.failureReason}`);
  // The verdict is what makes this entry teachable: the 7-day journal
  // injection used to say only that runs finished, never whether they worked.
  if (run.outcomeVerdict) {
    bodyLines.push(
      `outcome: ${run.outcomeVerdict}${run.outcomeNote ? ` — ${run.outcomeNote}` : ""}`,
    );
  }
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
 * The check phase: run the Routine's Checks, and give a failing Run a bounded
 * number of briefed rounds to fix what the server could not verify.
 *
 * Two bounds, and both matter. `ROUTINE_CHECK_REMEDIATION_MAX` stops the loop
 * from becoming a second, unbudgeted agent run. The Run's own absolute
 * `deadlineAtMs` stops remediation from extending `Routine.timeoutSec`, which
 * is the hazard that forced `settleAfterRun` to run before the outcome check in
 * the first place — a Run that quietly ran twice as long as configured would
 * let the heartbeat dispatch its next slot underneath it.
 */
async function runCheckPhase(args: {
  run: Run;
  routine: Routine;
  emp: AIEmployee;
  co: Company;
  model: AIModel;
  cwd: string;
  toolEnv: Record<string, string>;
  system: string;
  mcpToken: string;
  log: DurableRunLog;
  deadlineAtMs: number;
  deadlineReached: () => boolean;
  diagnostics: RunDiagnosticRecorder;
  skills: Skill[];
  unavailableSkillTools: string[];
}): Promise<{
  verdict: Run["checksVerdict"];
  results: RunCheckResult[];
  remediations: number;
  tokensIn: number;
  tokensOut: number;
  errorKind: RunErrorKind | null;
  incomplete: boolean;
}> {
  const { log } = args;
  let tokensIn = 0;
  let tokensOut = 0;
  let remediations = 0;
  let errorKind: RunErrorKind | null = null;
  let incomplete = false;
  const continuationLimitReached = () =>
    args.run.continuationTokensUsed +
      args.run.tokensIn +
      args.run.tokensOut +
      tokensIn +
      tokensOut >=
    CONTINUATION_TOKEN_LIMIT;

  const base = {
    run: args.run,
    routine: args.routine,
    employee: args.emp,
    companyId: args.co.id,
    cwd: args.cwd,
    toolEnv: args.toolEnv,
    deadlineAtMs: args.deadlineAtMs,
  };

  let phase = await runChecksForRun({ ...base, attempt: 0 });
  if (phase.verdict === "not_run")
    return {
      verdict: "not_run",
      results: [],
      remediations: 0,
      tokensIn,
      tokensOut,
      errorKind,
      incomplete,
    };
  log.line(`\n[checks] ${describeCheckPhase(phase)}`);

  while (
    phase.verdict === "failed" &&
    remediations < ROUTINE_CHECK_REMEDIATION_MAX &&
    !args.deadlineReached() &&
    !continuationLimitReached()
  ) {
    const remainingMs = args.deadlineAtMs - Date.now();
    // A round with no time to work in is not a round. Say so rather than
    // starting a turn that is certain to be aborted mid-tool-call — and break
    // *before* counting it, because `checkRemediations` is what a human reads
    // to judge how much trouble a Run was in, and a Run that claims a fix
    // attempt it never made is overstating in the direction that matters.
    if (remainingMs < 10_000) {
      log.line("[checks] no time left in this Run's budget for another attempt.");
      break;
    }
    remediations += 1;
    log.line(
      `\n[checks] remediation ${remediations} of ${ROUTINE_CHECK_REMEDIATION_MAX} — asking for a fix.`,
    );
    // A fix round can change the work and then fail or be interrupted. The
    // previous report no longer describes that state unless a new one returns.
    log.line(workSummaryLogLine(""));
    const controller = new AbortController();
    registerRunInterrupter(
      args.run.id,
      { companyId: args.co.id, employeeId: args.emp.id, routineId: args.routine.id },
      () => {
        errorKind = "interrupted";
        controller.abort();
      },
    );
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const tokenAuthority = resolveMcpToken(args.mcpToken);
      const result = await runEmployeeAgent({
        model: args.model,
        employeeId: args.emp.id,
        system: args.system,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: composeRemediationMessage(phase.results) }],
          },
        ],
        cwd: args.cwd,
        toolEnv: args.toolEnv,
        genosynToken: args.mcpToken,
        bashTimeoutMs: Math.min(remainingMs, 5 * 60 * 1000),
        maxSteps: ROUTINE_CHECK_REMEDIATION_STEPS,
        skillToolset: residentNamesForSkills(args.skills, args.unavailableSkillTools),
        routineId: args.routine.id,
        runId: args.run.id,
        allowPrivilegedToolSources: routineDeliveryPolicy(
          args.routine,
          Boolean(tokenAuthority?.proactiveReview),
          tokenAuthority?.mailDeliveryMode ?? null,
        ).allowPrivilegedToolSources,
        authorizePrivilegedToolCall:
          tokenAuthority?.authority === "member" &&
          tokenAuthority.requesterUserId &&
          tokenAuthority.requesterSessionVersion !== null
            ? createPrivilegedMemberToolAuthorizer({
                companyId: args.co.id,
                userId: tokenAuthority.requesterUserId,
                sessionVersion: tokenAuthority.requesterSessionVersion,
              })
            : undefined,
        toolScope: selfReviewToolScope(args.routine.selfReviewOnly),
        signal: controller.signal,
        callbacks: {
          onText: (delta) => log.write(delta),
          onToolUse: (name, input, callId) => {
            args.diagnostics.toolStarted(name, callId);
            log.line(`\n[tool] ${name} ${previewArgs(input)}`);
          },
          onToolResult: (name, r, callId) => {
            args.diagnostics.toolFinished(name, r, callId);
            log.line(formatToolResultLine(name, r));
          },
          onUsage: (u) => {
            tokensIn += u.inputTokens;
            tokensOut += u.outputTokens;
            if (continuationLimitReached()) controller.abort();
          },
        },
      });
      if (continuationLimitReached()) {
        incomplete = true;
        args.run.continuationStopReason =
          "The shared token limit for automatic continuation was reached during Check remediation.";
        log.line(`\n[checks] ${args.run.continuationStopReason}`);
      } else if (
        controller.signal.aborted ||
        (result.status === "ok" && result.stopReason === "aborted")
      ) {
        errorKind = args.deadlineReached() ? "timeout" : "interrupted";
        args.diagnostics.fail("Check remediation stopped before finishing.", errorKind);
        log.line("\n[checks] remediation was interrupted before finishing.");
        log.line(workSummaryLogLine(""));
      } else if (result.status === "error") {
        errorKind = "runtime";
        args.diagnostics.fail(result.error, "model");
        log.line(`\n[checks] remediation turn failed: ${result.error}`);
        log.line(workSummaryLogLine(""));
      } else if (result.stopReason !== "max_steps" && result.stopReason !== "aborted") {
        log.line(workSummaryLogLine(result.finalText));
      } else {
        incomplete = true;
        log.line(workSummaryLogLine(""));
      }
    } catch (err) {
      if (continuationLimitReached()) {
        incomplete = true;
        args.run.continuationStopReason =
          "The shared token limit for automatic continuation was reached during Check remediation.";
        log.line(`\n[checks] ${args.run.continuationStopReason}`);
      } else {
        errorKind ??= args.deadlineReached() ? "timeout" : "runtime";
        args.diagnostics.fail(
          err,
          errorKind === "timeout"
            ? "timeout"
            : errorKind === "interrupted"
              ? "interrupted"
              : "application",
        );
        // Preserve the prior Check evidence while recording the runtime error.
        log.line(`\n[checks] remediation turn failed: ${errorMessage(err)}`);
        log.line(workSummaryLogLine(""));
      }
    } finally {
      clearTimeout(timer);
      unregisterRunInterrupter(args.run.id);
    }
    phase = await runChecksForRun({ ...base, attempt: remediations });
    log.line(`\n[checks] ${describeCheckPhase(phase)}`);
    const current = await AppDataSource.getRepository(Run).findOneBy({ id: args.run.id });
    if (errorKind || incomplete || current?.failureReason || current?.status !== "running") break;
  }

  if (phase.verdict === "failed" && continuationLimitReached()) {
    incomplete = true;
    args.run.continuationStopReason ??=
      "The shared token limit leaves no room for Check remediation.";
  }

  return {
    verdict: phase.verdict,
    results: phase.results,
    remediations,
    tokensIn,
    tokensOut,
    errorKind,
    incomplete,
  };
}

function describeCheckPhase(phase: {
  verdict: Run["checksVerdict"];
  results: RunCheckResult[];
}): string {
  const passed = phase.results.filter((r) => r.passed).length;
  const failed = phase.results.filter((r) => !r.passed);
  const head = `${passed}/${phase.results.length} passed`;
  if (failed.length === 0) return `${head}.`;
  return (
    `${head}. Not passed: ` +
    failed.map((r) => `"${r.name}"${r.required ? "" : " (advisory)"}`).join(", ") +
    "."
  );
}

/**
 * The circuit breaker (M58).
 *
 * A Routine that is permanently broken — a deleted integration, a renamed
 * report, a Connection whose token expired — used to fire on its cron forever,
 * failing identically and burning model spend every slot for as long as nobody
 * looked. The counter lives on the row so it survives a restart, and it is
 * maintained here rather than on a sweep for the same reason autonomy demotion
 * is: the evidence exists exactly once, at this moment.
 */
async function updateRoutineBreaker(
  run: Run,
  routine: Routine,
  companyId: string,
  employeeId: string,
): Promise<void> {
  try {
    // A retry is still owed: the chain has not finished failing yet, and
    // counting each attempt would trip the breaker in a single bad hour.
    if (run.retryAt) return;
    const clean =
      run.status === "completed" &&
      run.checksVerdict !== "failed" &&
      run.outcomeVerdict !== "off_goal";
    const repo = AppDataSource.getRepository(Routine);
    if (clean) {
      if (routine.consecutiveFailures === 0) return;
      await repo.update({ id: routine.id }, { consecutiveFailures: 0 });
      return;
    }
    // Defensive rather than reachable: `startRoutineRun` returns a skipped Run
    // long before this point. Kept because "no model connected" is not a
    // failure of the Routine's own work, and a future caller that does reach
    // here with one must not trip the breaker on it.
    if (run.status === "skipped" || run.status === "reviewed") return;
    const threshold = getContainmentSettings().routineBreakerThreshold;
    const next = (routine.consecutiveFailures ?? 0) + 1;
    await repo.update({ id: routine.id }, { consecutiveFailures: next });
    if (threshold <= 0 || next < threshold) return;
    await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: routine.id,
      source: "breaker",
      reason:
        `${next} consecutive failed Runs — the most recent finished ${run.status}` +
        `${run.checksVerdict === "failed" ? " with failing checks" : ""}` +
        `${run.outcomeVerdict === "off_goal" ? " and off goal" : ""}. ` +
        "Fix the cause and return this Routine to work.",
      placedByUserId: null,
    });
  } catch (err) {
    // The breaker is a safety net. A net that can fail a Run it was watching
    // would be worse than no net.
    // eslint-disable-next-line no-console
    console.error(`[runner] breaker update failed for routine ${routine.id}:`, err);
    void employeeId;
  }
}

/**
 * Grade the finished Run, without letting the check delay anything.
 *
 * The body moved to `services/runGrading.ts` when the re-grade sweep needed
 * the identical path: two graders that drifted would produce two different
 * meanings for the same verdict column.
 */
async function assessOutcomeQuietly(
  run: Run,
  routine: Routine,
  emp: AIEmployee,
  model: AIModel,
  checkResults: RunCheckResult[],
): Promise<void> {
  await gradeAndPersistRunOutcome({
    run,
    routine,
    employee: emp,
    model,
    // Both already in hand from the check phase — passing them saves the
    // grader two reads and, more importantly, guarantees it grades against
    // exactly the evidence the checks were evaluated on.
    effects: await continuationEffects(run, { companyId: emp.companyId }).catch(() => undefined),
    checkResults: checkResults.map((r) => ({
      name: r.name,
      required: r.required,
      passed: r.passed,
      detail: r.detail,
    })),
  });
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
      errorKind: run.errorKind,
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
    errorKind: run.errorKind,
    attempt: run.attempt,
    maxAttempts: routine.maxAttempts,
    baseMs: routine.retryBackoffSec * 1000,
  });
  run.retryAt = new Date(Date.now() + delay);
  log.line(
    `\n[retry] attempt ${run.attempt + 1} of ${automaticRetryLimit(run.status, routine.maxAttempts, run.errorKind)} scheduled in ~${Math.round(delay / 1000)}s`,
  );
}

function composeRoutineMessage(
  routine: Routine,
  missedSlots: number,
  goalBlock: string | null,
  lessonsBlock: string,
  workstreamBlock: string,
  priorAttemptBlock: string | null,
  checksBlock: string | null,
): string {
  return [
    `## Routine: ${routine.name}`,
    "",
    routine.body,
    // What an earlier attempt of this same Run already changed (M58). High in
    // the brief on purpose: it changes what the work *is*, not merely how it
    // should be reported.
    ...(priorAttemptBlock ? ["", priorAttemptBlock] : []),
    // The objective this work serves, when the Routine declares one — folded
    // beside the criteria so the employee aims at the goal it is graded on.
    ...(goalBlock ? ["", "## Goal", goalBlock] : []),
    // Where multi-Run work stands (M54) — the employee's own state document,
    // so a long job resumes instead of re-deriving itself from the journal.
    ...(workstreamBlock ? ["", workstreamBlock] : []),
    // What earlier graded-bad Runs taught (M52) — advice from the routine's
    // own retrospectives, so the next attempt starts past the last stumble.
    ...(lessonsBlock ? ["", lessonsBlock] : []),
    // The bar the Run will be judged against. Folding it into the brief means
    // the employee is aiming at the same criteria the outcome check grades.
    ...(routine.acceptanceCriteria.trim()
      ? [
          "",
          "## Acceptance criteria",
          routine.acceptanceCriteria.trim(),
          "",
          "This run's transcript is graded against the criteria above after it finishes. " +
            "Make sure the transcript shows they were met — do the work, don't just claim it.",
        ]
      : []),
    // The Checks that will grade this Run mechanically. Shown after the
    // criteria because they are narrower: the criteria say what good work is,
    // the Checks say what the server will be able to see of it.
    ...(checksBlock ? ["", checksBlock] : []),
    "",
    "---",
    "Run this routine now. Produce the expected output.",
    "Begin your final report with one or two short sentences saying what you accomplished, " +
      "including concrete results and anything left unfinished. Describe the work's outcome " +
      "in plain language, without tool names, Connection counts, or a list of steps. " +
      "Put any supporting detail after that summary. Do not claim work you did not complete.",
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
