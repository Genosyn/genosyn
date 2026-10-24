/**
 * How an AI Employee's browser access is described on its Settings → Browser
 * page. Dependency-free so it runs under `node --test`.
 *
 * The allow list is free text: one host pattern per line, `#` starting a
 * comment, blank lines ignored — the same reading `browser_open` gives it on
 * the server. An empty list means no restriction.
 */

/** The host patterns an allow list holds, in order, comments and blank lines left out. */
export function allowedHostPatterns(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * The closed line of the Browser page's Advanced section: where the employee
 * may browse, and whether it asks before submitting a form — the human gate,
 * which must stay visible however folded away it is.
 */
export function browserAdvancedSummary(
  allowedHosts: string | null | undefined,
  approvalRequired: boolean,
): string {
  const count = allowedHostPatterns(allowedHosts).length;
  const where =
    count === 0 ? "Any website" : count === 1 ? "1 allowed website" : `${count} allowed websites`;
  const gate = approvalRequired ? "Asks before submitting forms" : "Submits forms without asking";
  return `${where} · ${gate}`;
}
