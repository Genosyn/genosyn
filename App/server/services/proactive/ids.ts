import { createHash } from "node:crypto";

/** The native identity stays stable across retries and automatic setup. */
export function proactiveId(
  companyId: string,
  employeeId: string,
  recipeId: string,
  accountId: string | null,
): string {
  const hex = createHash("sha1")
    .update(JSON.stringify(["genosyn-proactive-v1", companyId, employeeId, recipeId, accountId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
