import type { ToolScope } from "../agent/tools/index.js";

/** Exact review surface: reads, a proposed diff, and the review's own progress record. */
export const SELF_REVIEW_GENOSYN_TOOLS = [
  "get_self",
  "list_skills",
  "list_routines",
  "get_routine",
  "list_runs",
  "get_run_report",
  "get_own_work_review",
  "get_participating_routine",
  "list_workstreams",
  "get_repository_work_session",
  "get_mail_thread",
  "propose_revision",
  "create_workstream",
  "update_workstream",
] as const;

/** Shared by the visible registry and the server callback; prose cannot widen it. */
export function selfReviewToolError(
  selfReviewOnly: boolean | undefined,
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  if (!selfReviewOnly) return null;
  if (!(SELF_REVIEW_GENOSYN_TOOLS as readonly string[]).includes(toolName)) {
    return "This review can read its work, track the review, and propose a revision for a Member. It cannot perform other work or change live records.";
  }
  if (
    toolName === "propose_revision" &&
    !["soul", "skill", "routine_body"].includes(String(args.kind ?? ""))
  ) {
    return "This review may propose a Soul, Skill, or Routine brief revision. It cannot change or weaken acceptance criteria or Checks.";
  }
  return null;
}

/** Surface-only disables browser, coding, configured MCP, aliases, and delegation. */
export function selfReviewToolScope(enabled: boolean | undefined): ToolScope | undefined {
  return enabled ? { genosynTools: [...SELF_REVIEW_GENOSYN_TOOLS], surfaceOnly: true } : undefined;
}
