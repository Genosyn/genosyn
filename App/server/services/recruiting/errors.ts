/**
 * The three ways a Recruiting request is refused, each mapped to one status
 * by the routes and the MCP tools: a request that cannot be honoured as
 * written (400), a record that is not there for this company (404), and a
 * request that collides with something already true (409) — a custom domain
 * another company holds, an Opening that still has applicants.
 */
export class RecruitingValidationError extends Error {}
export class RecruitingNotFoundError extends Error {}
export class RecruitingConflictError extends Error {}

/** The HTTP status for one of the errors above, or null for anything else. */
export function recruitingErrorStatus(error: unknown): 400 | 404 | 409 | null {
  if (error instanceof RecruitingValidationError) return 400;
  if (error instanceof RecruitingNotFoundError) return 404;
  if (error instanceof RecruitingConflictError) return 409;
  return null;
}
