/** Shared business ownership is stable; personal review and follow-through stay per employee. */
export function proactiveScopeKind(recipeId: string): "mailbox" | "company" | "employee" {
  if (["work-followthrough", "improve-own-work", "advance-responsibilities"].includes(recipeId))
    return "employee";
  if (
    [
      "quote-requests",
      "customer-code-issues",
      "new-sales-enquiries",
      "spam-cleanup",
      "newsletter-cleanup",
      "customer-commitments",
    ].includes(recipeId)
  )
    return "mailbox";
  return "company";
}

export function proactiveScope(
  recipeId: string,
  accountId: string | null,
  employeeId: string,
): string {
  const kind = proactiveScopeKind(recipeId);
  return JSON.stringify([
    recipeId,
    kind,
    kind === "mailbox" ? accountId : kind === "employee" ? employeeId : null,
  ]);
}
