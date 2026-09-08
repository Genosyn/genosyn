/** Business ownership is stable when employees change; follow-through alone is per employee. */
export function proactiveScopeKind(recipeId: string): "mailbox" | "company" | "employee" {
  if (recipeId === "work-followthrough" || recipeId === "improve-own-work") return "employee";
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
