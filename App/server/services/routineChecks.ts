import { z } from "zod";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import type { Run, RunChecksVerdict } from "../db/entities/Run.js";
import { RoutineCheck, type RoutineCheckKind } from "../db/entities/RoutineCheck.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
import {
  messageOf,
  spawnSandboxedCommand,
  type SandboxCommandResult,
} from "./agent/sandboxCommandRun.js";
import { buildSandboxShellInvocation } from "./agent/sandboxShell.js";
import { MAX_SESSION_COMMAND_LENGTH, parseCommandSegments } from "./repositoryCommandPolicy.js";
import { countEffects } from "./runEffects.js";

/**
 * **Checks** — the assertions a Run has to pass before it may finalize green.
 *
 * Everything else the platform knows about a Run comes from the Run. `status`
 * says the agent loop returned. The transcript is the model's account of its
 * own work. The outcome verdict is a second model reading that account. A
 * Check is the first thing in the chain the graded party did not write: the
 * server ran a command and read its exit status, or counted rows in the effect
 * ledger that the server itself wrote at each write seam.
 *
 * Three design calls this module exists to hold, all of them stated in the
 * entity JSDoc and all of them easy to lose in a refactor:
 *
 *  1. **The graded party cannot author the bar.** There is no MCP tool that
 *     creates, edits, or deletes a Check; mutation is admin-gated at the route.
 *     The employee is *shown* its Routine's Checks — {@link composeChecksBlock}
 *     folds them into the brief — so it can aim at the bar rather than discover
 *     it afterwards. Reading the bar is not authoring it.
 *  2. **A check that could not run is a check that failed.** Not skipped, not
 *     absent, not "inconclusive". M58 exists because "we could not verify" was
 *     recorded with the same word as "verified" and every consumer read both as
 *     fine; reintroducing that inside the fix would be absurd.
 *  3. **A Check that can never pass must never be created.** `command` checks
 *     are bubblewrap-only for the same reason `bash` is, so
 *     {@link createCheck} refuses one where the sandbox cannot start, with the
 *     reason inline instead of a Run failing forever on a check nobody could
 *     have known was doomed.
 *
 * `effect` checks are what keep the whole primitive from being a
 * bubblewrap-only luxury: two queries against the ledger, no shell, no model,
 * working on a stock `disabled`-mode install.
 */

/** The 400-able one. Everything a Member can get wrong writing a Check. */
export class RoutineCheckError extends Error {}

/**
 * How many Checks one Routine may carry.
 *
 * Low on purpose. Checks run inside the Run's own deadline, and a Routine that
 * needed thirty assertions is describing a Run that should have been three
 * Routines. The cap is also what stops a `command` check list from quietly
 * becoming a second, unbudgeted test suite on every tick.
 */
export const MAX_CHECKS_PER_ROUTINE = 10;

export const MIN_CHECK_TIMEOUT_SEC = 1;
export const MAX_CHECK_TIMEOUT_SEC = 900;
export const DEFAULT_CHECK_TIMEOUT_SEC = 120;

/** Longest a check's name may be. Matches what the result strip can render. */
export const MAX_CHECK_NAME_LENGTH = 80;

/**
 * How much of a command's output survives into `detail`.
 *
 * The tail rather than the head: a check answers one question, and the sentence
 * that says why the answer was no is the last thing a test runner or a linter
 * prints. The full output is bounded again by the sandbox itself; this is the
 * slice that lands in a database column a person reads.
 */
export const CHECK_DETAIL_MAX_BYTES = 8 * 1024;

/**
 * The `effect` kind's assertion, in the shape it is stored.
 *
 * Deliberately arithmetic rather than expressive. A predicate language would
 * invite Checks that are themselves programs needing their own review; the
 * whole value here is that a human can read one line and know exactly what the
 * server will count.
 */
export type EffectCheckSpec = {
  action: string;
  targetType?: string;
  min: number;
  max?: number;
};

export const effectCheckSpecSchema = z
  .object({
    action: z.string().trim().min(1).max(80),
    targetType: z.string().trim().max(40).optional(),
    min: z.number().int().min(0).default(1),
    max: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Read a stored `effect` spec, or say why it cannot be read.
 *
 * A guarded reader like every other JSON column in this codebase, with one
 * difference that matters: callers must not fall back to a permissive default.
 * A spec that no longer parses is a Check whose meaning nobody knows, and the
 * only safe reading of an unknown assertion is that it did not pass.
 */
export function parseEffectSpec(raw: string): EffectCheckSpec {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw || "{}");
  } catch {
    return failSpec("it is not valid JSON");
  }
  const parsed = effectCheckSpecSchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failSpec(
      issue
        ? `${issue.path.join(".") || "spec"}: ${issue.message.toLowerCase()}`
        : "it is malformed",
    );
  }
  const spec = parsed.data;
  if (spec.max !== undefined && spec.max < spec.min) {
    // A window that excludes every number is a Check that can never pass, and
    // the same rule that refuses a `command` check with no sandbox refuses it.
    return failSpec(`max (${spec.max}) is below min (${spec.min}), so nothing could satisfy it`);
  }
  return spec;
}

function failSpec(why: string): never {
  throw new RoutineCheckError(`This check's definition could not be read: ${why}.`);
}

/**
 * Whether a `command` check can run on this installation, and why not.
 *
 * A thin wrapper on the shared coding-runtime decision, and thin on purpose:
 * duplicating the policy is how the shell and repository Git would come to
 * disagree about whether a child process is allowed at all.
 */
export function commandChecksAvailable():
  | { available: true }
  | { available: false; reason: string } {
  const runtime = codingRuntimeAvailability();
  if (!runtime.available) return { available: false, reason: runtime.reason };
  // Bubblewrap or nothing, exactly as `bash` and `repository_run_command` are.
  // A host shell runs as the App's own OS user, where a working directory is a
  // convention rather than a boundary — and a Check is not the place to hand an
  // AI Employee's Routine a same-UID shell for the first time.
  // Read late rather than cached: boot may fall back from the shipped
  // bubblewrap default after this module is first loaded.
  if (config.agent.codingTools.executionMode !== "bubblewrap") {
    return {
      available: false,
      reason:
        "Command checks run only behind bubblewrap isolation, and this Genosyn installation is not using it.",
    };
  }
  return { available: true };
}

/* ------------------------------------------------------------------ reads */

/**
 * The Routine, resolved through the company that owns it.
 *
 * A Routine has no `companyId` of its own — it belongs to a company through
 * its AI Employee, the same hop `routes/routines.ts` makes for every other
 * routine-scoped resource. Doing it here rather than in the route is what keeps
 * a future second caller from scoping by `routineId` alone.
 */
export async function resolveCheckRoutine(companyId: string, routineId: string): Promise<Routine> {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: routineId });
  if (!routine) throw new RoutineCheckError("That routine no longer exists.");
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
    companyId,
  });
  if (!employee) throw new RoutineCheckError("That routine no longer exists.");
  return routine;
}

/** Every Check on a Routine, in the order the runner will run them. */
export async function listChecks(routineId: string, companyId?: string): Promise<RoutineCheck[]> {
  return AppDataSource.getRepository(RoutineCheck).find({
    where: companyId ? { routineId, companyId } : { routineId },
    order: { position: "ASC", createdAt: "ASC" },
  });
}

/** One Check, scoped to the company that may see it. */
export async function getCheck(companyId: string, checkId: string): Promise<RoutineCheck | null> {
  return AppDataSource.getRepository(RoutineCheck).findOneBy({ id: checkId, companyId });
}

/* ----------------------------------------------------------------- writes */

export type CheckInput = {
  companyId: string;
  routineId: string;
  name: string;
  kind: RoutineCheckKind;
  spec: string;
  required?: boolean;
  enabled?: boolean;
  timeoutSec?: number;
  createdById: string | null;
};

export async function createCheck(input: CheckInput): Promise<RoutineCheck> {
  await resolveCheckRoutine(input.companyId, input.routineId);
  const existing = await listChecks(input.routineId, input.companyId);
  if (existing.length >= MAX_CHECKS_PER_ROUTINE) {
    throw new RoutineCheckError(
      `A routine may carry at most ${MAX_CHECKS_PER_ROUTINE} checks. Remove one before adding another.`,
    );
  }
  const name = normalizeName(input.name);
  const kind = normalizeKind(input.kind);
  const spec = validateSpec(kind, input.spec);

  const repo = AppDataSource.getRepository(RoutineCheck);
  return repo.save(
    repo.create({
      companyId: input.companyId,
      routineId: input.routineId,
      name,
      kind,
      spec,
      required: input.required ?? true,
      enabled: input.enabled ?? true,
      timeoutSec: clampTimeout(input.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC),
      position: existing.length === 0 ? 0 : Math.max(...existing.map((c) => c.position)) + 1,
      createdById: input.createdById,
    }),
  );
}

export type CheckPatch = Partial<{
  name: string;
  kind: RoutineCheckKind;
  spec: string;
  required: boolean;
  enabled: boolean;
  timeoutSec: number;
}>;

export async function updateCheck(check: RoutineCheck, patch: CheckPatch): Promise<RoutineCheck> {
  const originalKind = check.kind;
  if (patch.name !== undefined) check.name = normalizeName(patch.name);
  if (patch.kind !== undefined) check.kind = normalizeKind(patch.kind);
  // Changing the kind needs a new spec in the same breath. A stored
  // `{"action":"mail.send"}` is a syntactically fine single-word command, so
  // flipping `effect` to `command` alone would leave a check that parses,
  // saves, and then fails every Run forever on a command nobody wrote.
  if (patch.kind !== undefined && patch.kind !== originalKind && patch.spec === undefined) {
    throw new RoutineCheckError("Changing a check's kind needs a new spec to go with it.");
  }
  // Re-validated against whatever the kind ends up being, not the kind it had.
  if (patch.spec !== undefined || patch.kind !== undefined) {
    check.spec = validateSpec(check.kind, patch.spec ?? check.spec);
  }
  if (patch.required !== undefined) check.required = patch.required;
  if (patch.enabled !== undefined) check.enabled = patch.enabled;
  if (patch.timeoutSec !== undefined) check.timeoutSec = clampTimeout(patch.timeoutSec);
  return AppDataSource.getRepository(RoutineCheck).save(check);
}

/**
 * Delete a Check without taking its history with it.
 *
 * Results are evidence about Runs that already happened; a Member deleting a
 * Check they no longer want should not rewrite what past Runs were graded on.
 * `checkId` goes null and the denormalized `name` / `kind` / `required` carry
 * the row's meaning forward, the stance `RunLesson` takes toward its Routine.
 */
export async function deleteCheck(check: RoutineCheck): Promise<void> {
  await AppDataSource.getRepository(RunCheckResult).update(
    { checkId: check.id, companyId: check.companyId },
    { checkId: null },
  );
  await AppDataSource.getRepository(RoutineCheck).delete({ id: check.id });
}

/**
 * Put the Routine's Checks in the given order.
 *
 * Order is load-bearing rather than cosmetic: a cheap `effect` check that
 * proves the Run did anything at all belongs before a two-minute test suite,
 * because the second one is not worth spending the Run's remaining deadline on
 * when the first has already failed.
 */
export async function reorderChecks(routineId: string, orderedIds: string[]): Promise<void> {
  const checks = await listChecks(routineId);
  const known = new Set(checks.map((c) => c.id));
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!known.has(id)) throw new RoutineCheckError("That check is not on this routine.");
    if (seen.has(id)) throw new RoutineCheckError("A check was listed twice in the new order.");
    seen.add(id);
  }
  if (seen.size !== checks.length) {
    throw new RoutineCheckError("The new order must list every check on this routine.");
  }
  const repo = AppDataSource.getRepository(RoutineCheck);
  for (const [index, id] of orderedIds.entries()) {
    await repo.update({ id }, { position: index });
  }
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new RoutineCheckError("A check needs a name.");
  if (name.length > MAX_CHECK_NAME_LENGTH) {
    throw new RoutineCheckError(`A check name may be at most ${MAX_CHECK_NAME_LENGTH} characters.`);
  }
  return name;
}

function normalizeKind(kind: string): RoutineCheckKind {
  if (kind !== "command" && kind !== "effect") {
    throw new RoutineCheckError("A check is either a command or an effect assertion.");
  }
  return kind;
}

export function clampTimeout(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CHECK_TIMEOUT_SEC;
  return Math.min(MAX_CHECK_TIMEOUT_SEC, Math.max(MIN_CHECK_TIMEOUT_SEC, Math.round(seconds)));
}

/**
 * Validate at write time so a Check cannot be stored in a state where it could
 * only ever fail — the one failure mode this primitive absolutely must not have,
 * because a Check that always fails is a Routine that can never go green again.
 */
function validateSpec(kind: RoutineCheckKind, raw: string): string {
  if (kind === "effect") {
    // Round-trip through the reader that the runner will use, so what is stored
    // is exactly what will later parse: same schema, same refusals, no drift.
    const spec = parseEffectSpec(raw);
    return JSON.stringify(spec);
  }

  const command = raw.trim();
  if (!command) throw new RoutineCheckError("A command check needs a command to run.");
  if (command.length > MAX_SESSION_COMMAND_LENGTH) {
    throw new RoutineCheckError(
      `A check command may be at most ${MAX_SESSION_COMMAND_LENGTH} characters.`,
    );
  }
  const availability = commandChecksAvailable();
  if (!availability.available) {
    throw new RoutineCheckError(
      `This installation cannot run command checks, so this one could never pass. ${availability.reason}`,
    );
  }
  // The same reading `repositoryCommandPolicy.ts` applies to what an employee
  // asks to run, for the same reason: a string whose meaning cannot be read off
  // the text is a string nobody reviewed. Command substitution, redirection and
  // background jobs are refused outright rather than guessed at.
  const parsed = parseCommandSegments(command);
  if ("error" in parsed) {
    throw new RoutineCheckError(`This check's command was refused because ${parsed.error}.`);
  }
  // One check, one command. Chaining is not a limitation worth working around
  // here — a Routine's checks are already a list, and two commands joined by
  // `&&` report one exit code between them, which is exactly the ambiguity
  // Checks exist to remove.
  if (parsed.segments.length > 1) {
    throw new RoutineCheckError(
      "A check runs one command. Add a second check rather than chaining commands together.",
    );
  }
  return command;
}

/* --------------------------------------------------------------- briefing */

/**
 * The Checks, rendered for the Run brief beside `acceptanceCriteria`.
 *
 * The employee is told the bar before it works rather than after it fails. This
 * is not a leak of the grading: a Check is machine-verified against the ledger
 * or an exit code, so knowing about it can only make the work better — the one
 * way to satisfy "the ledger records a `mail.send`" is to send the mail.
 */
export function composeChecksBlock(checks: RoutineCheck[]): string | null {
  const enabled = checks.filter((c) => c.enabled);
  if (enabled.length === 0) return null;
  const lines = enabled.map((check) => {
    const label = check.required ? "required" : "advisory";
    return `- **${check.name}** (${label}) — ${describeCheck(check)}`;
  });
  return [
    "## Checks this Run must pass",
    "After you finish, the server runs the checks below itself. You cannot see, change, or run them, and saying a check is wrong does not make it pass — only doing the work does. A required check that does not pass fails this Run.",
    ...lines,
  ].join("\n");
}

/** One line saying what a Check asserts, in the operator's terms. */
export function describeCheck(check: RoutineCheck): string {
  if (check.kind === "command") {
    return `the command \`${check.spec.trim()}\` must exit 0`;
  }
  let spec: EffectCheckSpec;
  try {
    spec = parseEffectSpec(check.spec);
  } catch {
    return "its definition cannot be read, so it will not pass";
  }
  const what = `\`${spec.action}\`${spec.targetType ? ` on ${spec.targetType}` : ""}`;
  if (spec.max !== undefined) {
    return `the server's effect ledger must record between ${spec.min} and ${spec.max} ${what}`;
  }
  return `the server's effect ledger must record at least ${spec.min} ${what}`;
}

/**
 * The message the runner hands back for one bounded remediation round.
 *
 * It names the failures and stops there. It does not offer the employee a way
 * to argue with a check, because there is none — an employee cannot edit a
 * Check, and a remediation round that turned into a negotiation would be the
 * graded party grading itself again.
 */
export function composeRemediationMessage(results: RunCheckResult[]): string {
  const failed = results.filter((r) => r.required && !r.passed);
  if (failed.length === 0) return "";
  return [
    `Your work did not pass ${failed.length === 1 ? "a required check" : `${failed.length} required checks`} on this Routine. Fix the underlying work and finish again.`,
    "",
    "You cannot change a check, and you are not being asked to explain one. Each line below is what the server observed:",
    ...failed.map((r) => `- **${r.name}** — ${r.detail || "no detail was recorded."}`),
    "",
    "Do the work the checks are looking for, then finish. If something genuinely makes that impossible, say exactly what and stop — do not report success you cannot back up.",
  ].join("\n");
}

/* ------------------------------------------------------------- the runner */

export type CheckRunParams = {
  run: Pick<Run, "id">;
  routine: Pick<Routine, "id">;
  employee: Pick<AIEmployee, "id">;
  companyId: string;
  /** The employee working directory. Both the sandbox root and the cwd. */
  cwd: string;
  /** Which remediation round this is. 0 is the first pass. */
  attempt: number;
  signal?: AbortSignal;
  /** The Run's own absolute deadline. Checks never extend it. */
  deadlineAtMs: number;
  /** Company Environment secrets, when the Routine's turn had them. */
  toolEnv?: Record<string, string>;
  /**
   * Seam for tests — a `command` check is a real child process. Mirrors
   * `runVerdicts.ts`'s `runRestricted` injection rather than inventing a second
   * pattern. Injecting it also stands in for the sandbox availability gate,
   * which is what makes the check path testable on a machine with no bubblewrap.
   */
  runCommand?: (
    options: Parameters<typeof spawnSandboxedCommand>[0],
  ) => Promise<SandboxCommandResult>;
};

/**
 * Run every enabled Check for one Run, persist a result each, and say whether
 * the Run may go green.
 *
 * Never throws. Checks decide whether work is finalized, so a bug in here must
 * not be able to take down a Run that had already done its job — but it must
 * also never let one through unexamined, which is why every failure path lands
 * on a recorded, failed result rather than a silent skip.
 */
export async function runChecksForRun(
  params: CheckRunParams,
): Promise<{ verdict: RunChecksVerdict; results: RunCheckResult[] }> {
  let checks: RoutineCheck[];
  try {
    checks = (await listChecks(params.routine.id, params.companyId)).filter((c) => c.enabled);
  } catch (error) {
    // The Routine's own checks could not be read. There is nowhere honest to
    // record that — the results table is equally unreachable — so the verdict
    // carries it: an unreadable bar is an uncleared bar.
    // eslint-disable-next-line no-console
    console.error(`[checks] could not read checks for routine ${params.routine.id}:`, error);
    return { verdict: "failed", results: [] };
  }
  if (checks.length === 0) return { verdict: "not_run", results: [] };

  const results: RunCheckResult[] = [];
  for (const check of checks) {
    const startedAt = Date.now();
    let outcome: CheckOutcome;
    try {
      outcome =
        check.kind === "command"
          ? await runCommandCheck(check, params)
          : await runEffectCheck(check, params);
    } catch (error) {
      // Any escape from a check body is the check failing, never the check
      // being skipped. See the module note.
      outcome = {
        passed: false,
        exitCode: null,
        detail: `This check could not be run: ${messageOf(error)}`,
      };
    }
    const saved = await persistResult(check, params, outcome, Date.now() - startedAt);
    if (saved) results.push(saved);
  }

  const failedRequired = results.some((r) => r.required && !r.passed);
  return { verdict: failedRequired ? "failed" : "passed", results };
}

type CheckOutcome = { passed: boolean; exitCode: number | null; detail: string };

async function persistResult(
  check: RoutineCheck,
  params: CheckRunParams,
  outcome: CheckOutcome,
  durationMs: number,
): Promise<RunCheckResult | null> {
  const repo = AppDataSource.getRepository(RunCheckResult);
  try {
    return await repo.save(
      repo.create({
        companyId: params.companyId,
        runId: params.run.id,
        checkId: check.id,
        name: check.name,
        kind: check.kind,
        required: check.required,
        passed: outcome.passed,
        exitCode: outcome.exitCode,
        detail: clipDetail(outcome.detail),
        durationMs,
        attempt: params.attempt,
      }),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[checks] could not record result for check ${check.id}:`, error);
    // Fall back to an unsaved row so the verdict still counts this check. A
    // required check whose row would not save must not become a pass.
    return repo.create({
      companyId: params.companyId,
      runId: params.run.id,
      checkId: check.id,
      name: check.name,
      kind: check.kind,
      required: check.required,
      passed: false,
      exitCode: null,
      detail: "This check's result could not be recorded.",
      durationMs,
      attempt: params.attempt,
    });
  }
}

/**
 * The `effect` kind: count what the server recorded, compare it to the window.
 *
 * The count comes from `runEffects.ts`, which reads AuditEvent rows the server
 * wrote at each write seam while this Run held the token. It is the one account
 * of the Run the model had no hand in writing, which is the entire reason this
 * kind exists.
 */
async function runEffectCheck(check: RoutineCheck, params: CheckRunParams): Promise<CheckOutcome> {
  let spec: EffectCheckSpec;
  try {
    spec = parseEffectSpec(check.spec);
  } catch (error) {
    // A spec nobody can read is an assertion nobody can claim was satisfied.
    return { passed: false, exitCode: null, detail: messageOf(error) };
  }
  const count = await countEffects(params.run.id, {
    action: spec.action,
    targetType: spec.targetType,
  });
  const what = `\`${spec.action}\`${spec.targetType ? ` on ${spec.targetType}` : ""}`;
  const passed = count >= spec.min && (spec.max === undefined || count <= spec.max);
  const expectation =
    spec.max !== undefined
      ? `expected between ${spec.min} and ${spec.max} ${what}`
      : `expected at least ${spec.min} ${what}`;
  return {
    passed,
    exitCode: null,
    detail: `${expectation}, the ledger has ${count}.`,
  };
}

/**
 * The `command` kind: run it in the same sandbox the employee's own shell uses,
 * rooted at the same working directory, and read the exit status.
 *
 * The timeout is the smaller of the check's own ceiling and whatever is left of
 * the Run's absolute deadline, so a list of checks can never extend
 * `Routine.timeoutSec` — the Routine's budget is the Run's budget, checks
 * included.
 */
async function runCommandCheck(check: RoutineCheck, params: CheckRunParams): Promise<CheckOutcome> {
  if (params.signal?.aborted) {
    return unrunnable("the Run was stopped before this check could run");
  }
  const remainingMs = params.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return unrunnable(
      "the Run had already used its whole time budget before this check was reached",
    );
  }
  if (!params.runCommand) {
    const availability = commandChecksAvailable();
    if (!availability.available) return unrunnable(availability.reason);
  }

  let invocation: ReturnType<typeof buildSandboxShellInvocation>;
  try {
    invocation = buildSandboxShellInvocation({
      workspaceRoot: params.cwd,
      cwd: params.cwd,
      command: check.spec.trim(),
      // The Routine's own turn ran with these, and a check that could not see
      // the same Environment secrets would fail on a missing API key rather
      // than on the work.
      env: params.toolEnv ?? {},
      // Not a login shell: `$HOME` is the employee working directory, which the
      // employee writes, so `bash -lc` would source a profile the graded party
      // authored — a way to make a check pass without doing the work.
      login: false,
    });
  } catch (error) {
    return unrunnable(`the sandbox could not be prepared (${messageOf(error)})`);
  }

  const spawner = params.runCommand ?? spawnSandboxedCommand;
  const result = await spawner({
    executable: invocation.executable,
    args: invocation.args,
    cwd: params.cwd,
    env: invocation.env,
    timeoutMs: Math.min(clampTimeout(check.timeoutSec) * 1000, remainingMs),
    signal: params.signal,
    abortedMessage: "The check was stopped because the Run ended.",
  });

  const passed = result.exitCode === 0;
  const detail =
    result.output.trim() || (passed ? "The command exited 0 and printed nothing." : "");
  return {
    passed,
    exitCode: result.exitCode,
    detail:
      detail || `The command exited ${result.exitCode ?? "without a status"} and printed nothing.`,
  };
}

/**
 * A check that could not be run, recorded as a failure with its reason.
 *
 * The single most important four lines in this module. See design call 2 in the
 * module note: a skipped check is how "we could not verify" becomes "verified".
 */
function unrunnable(why: string): CheckOutcome {
  return { passed: false, exitCode: null, detail: `This check could not be run: ${why}.` };
}

/** Keep the tail — the part that says why. See {@link CHECK_DETAIL_MAX_BYTES}. */
function clipDetail(detail: string): string {
  const buffer = Buffer.from(detail, "utf8");
  if (buffer.length <= CHECK_DETAIL_MAX_BYTES) return detail;
  const kept = buffer.subarray(buffer.length - CHECK_DETAIL_MAX_BYTES).toString("utf8");
  return `… [${buffer.length - CHECK_DETAIL_MAX_BYTES} earlier bytes omitted]\n${kept}`;
}

/* ------------------------------------------------------------ serializing */

export function serializeCheck(check: RoutineCheck): Record<string, unknown> {
  return {
    id: check.id,
    routineId: check.routineId,
    name: check.name,
    kind: check.kind,
    spec: check.spec,
    required: check.required,
    enabled: check.enabled,
    timeoutSec: check.timeoutSec,
    position: check.position,
    createdById: check.createdById,
    createdAt: check.createdAt?.toISOString() ?? null,
    updatedAt: check.updatedAt?.toISOString() ?? null,
  };
}

export function serializeCheckResult(result: RunCheckResult): Record<string, unknown> {
  return {
    id: result.id,
    runId: result.runId,
    checkId: result.checkId,
    name: result.name,
    kind: result.kind,
    required: result.required,
    passed: result.passed,
    exitCode: result.exitCode,
    detail: result.detail,
    durationMs: result.durationMs,
    attempt: result.attempt,
    createdAt: result.createdAt?.toISOString() ?? null,
  };
}
