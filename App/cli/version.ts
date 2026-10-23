/**
 * The CLI's version: the Genosyn release it was built with.
 *
 * `cli/build.ts` replaces `__GENOSYN_CLI_VERSION__` with the repo's `VERSION`
 * when it bundles the CLI, so the file an install serves names the release
 * it shipped in. Run from source (the tests, `npx tsx cli/main.ts`) it is
 * "development".
 */

declare const __GENOSYN_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __GENOSYN_CLI_VERSION__ === "string" ? __GENOSYN_CLI_VERSION__ : "development";

/** The oldest Node.js major the CLI supports — the repo's own runtime. */
export const MIN_NODE_MAJOR = 22;

/** An error message when `version` (a `process.versions.node` string) is too old, else null. */
export function nodeVersionProblem(version: string): string | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return null;
  return `genosyn-api needs Node.js ${MIN_NODE_MAJOR} or later; this is Node.js ${version}.`;
}
