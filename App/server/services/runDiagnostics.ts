import { z } from "zod";
import type { Run } from "../db/entities/Run.js";
import type { ToolResult } from "./agent/types.js";
import { redactSensitiveText } from "./approvalRedaction.js";

const phaseSchema = z.enum(["setup", "preflight", "work", "checks", "finalize"]);
const categorySchema = z.enum([
  "authorization",
  "timeout",
  "tool",
  "application",
  "model",
  "interrupted",
  "work",
  "check",
  "unknown",
]);
const stepSchema = z.object({
  tool: z.string().max(160),
  callId: z.string().max(160).nullable(),
  startedAt: z.string(),
});
const failureSchema = z.object({
  category: categorySchema,
  phase: phaseSchema,
  message: z.string().trim().min(1).max(2000),
  exception: z.string().max(160).nullable(),
  at: z.string(),
  step: stepSchema.nullable(),
});
const diagnosticsSchema = z.object({
  version: z.literal(1),
  phase: phaseSchema,
  failure: failureSchema.nullable(),
  activeSteps: z.array(stepSchema).max(20),
  toolErrors: z.array(failureSchema).max(5),
});
export type RunDiagnostics = z.infer<typeof diagnosticsSchema>;
type Phase = RunDiagnostics["phase"];
type Category = z.infer<typeof categorySchema>;
type DiagnosticRun = Pick<
  Run,
  | "diagnosticsJson"
  | "status"
  | "errorKind"
  | "failureReason"
  | "checksVerdict"
  | "outcomeVerdict"
  | "outcomeNote"
  | "continuationStopReason"
  | "finishedAt"
  | "startedAt"
>;

function safe(value: unknown, max = 2000): string {
  // Redact before slicing so truncation cannot expose the start of a secret.
  return redactSensitiveText(value instanceof Error ? value.message : String(value))
    .trim()
    .slice(0, max);
}

function categoryFor(message: string, fallback: Category): Category {
  if (fallback === "timeout" || fallback === "interrupted" || fallback === "authorization")
    return fallback;
  if (
    /\b(401|403|unauthorized|forbidden|invalid token|expired token|permission denied|access denied|missing grant|no grant)\b/i.test(
      message,
    )
  )
    return "authorization";
  if (/\b(timed? ?out|timeout|deadline exceeded)\b/i.test(message)) return "timeout";
  return fallback;
}

/** Server observations only: never records tool arguments, stacks or full results. */
export class RunDiagnosticRecorder {
  private value: RunDiagnostics = {
    version: 1,
    phase: "setup",
    activeSteps: [],
    toolErrors: [],
    failure: null,
  };

  phase(phase: Phase): void {
    this.value.phase = phase;
  }

  toolStarted(tool: string, callId?: string): void {
    this.value.activeSteps.push({
      tool: safe(tool, 160),
      callId: callId ? safe(callId, 160) : null,
      startedAt: new Date().toISOString(),
    });
    this.value.activeSteps = this.value.activeSteps.slice(-20);
  }

  toolFinished(tool: string, result: ToolResult, callId?: string): void {
    const observedTool = safe(tool, 160);
    const observedCallId = callId ? safe(callId, 160) : null;
    const index = this.value.activeSteps.findIndex(
      (step) => step.tool === observedTool && (!observedCallId || step.callId === observedCallId),
    );
    const step = index >= 0 ? this.value.activeSteps.splice(index, 1)[0] : null;
    if (result.isError) {
      const message = safe(result.content) || "The tool returned an error without details.";
      this.value.toolErrors.push({
        category: categoryFor(message, "tool"),
        phase: this.value.phase,
        message,
        exception: null,
        at: new Date().toISOString(),
        step,
      });
      this.value.toolErrors = this.value.toolErrors.slice(-5);
    }
  }

  fail(error: unknown, fallback: Category, phase?: Phase): void {
    if (error instanceof Error && error.name === "RetryPreflightError") {
      phase = "preflight";
      fallback = "authorization";
    }
    const message = safe(error) || "The Run stopped without an exception message.";
    this.value.failure = {
      category: categoryFor(message, fallback),
      phase: phase ?? this.value.phase,
      message,
      exception: error instanceof Error ? safe(error.name, 160) : null,
      at: new Date().toISOString(),
      step: this.value.activeSteps.at(-1) ?? null,
    };
  }

  json(): string {
    return JSON.stringify(this.value);
  }
}

/** Old and recovered Runs get an honest nonempty summary, not invented exception evidence. */
export function readRunDiagnostics(run: DiagnosticRun): RunDiagnostics {
  let parsed: RunDiagnostics | null = null;
  try {
    const result = diagnosticsSchema.safeParse(JSON.parse(run.diagnosticsJson ?? "null"));
    if (result.success) parsed = result.data;
  } catch {
    /* A damaged or legacy record still has its server verdict. */
  }
  const value = parsed ?? {
    version: 1 as const,
    phase: "finalize" as const,
    activeSteps: [],
    toolErrors: [],
    failure: null,
  };
  if (!value.failure && ["failed", "error", "timeout", "interrupted"].includes(run.status)) {
    const reportedReason =
      safe(run.failureReason ?? "") ||
      safe(run.continuationStopReason ?? "") ||
      (run.outcomeVerdict === "off_goal"
        ? safe(run.outcomeNote ?? "") ||
          "The outcome assessment found that the intended work was not achieved."
        : "");
    const category: Category =
      run.errorKind === "timeout" || run.status === "timeout"
        ? "timeout"
        : run.errorKind === "interrupted" || run.status === "interrupted"
          ? "interrupted"
          : run.checksVerdict === "failed"
            ? "check"
            : reportedReason
              ? "work"
              : "unknown";
    const message =
      reportedReason ||
      (category === "check"
        ? "A required Check did not pass. Inspect the Check evidence."
        : category === "timeout"
          ? "The Run exceeded its time budget."
          : category === "interrupted"
            ? "The Run stopped before finishing; no exception was recorded."
            : "The Run did not finish successfully. Detailed exception evidence was not recorded for this Run.");
    value.failure = {
      category,
      phase: value.phase,
      message: safe(message),
      exception: null,
      at: (run.finishedAt ?? run.startedAt).toISOString(),
      step: value.activeSteps.at(-1) ?? null,
    };
  }
  return value;
}
