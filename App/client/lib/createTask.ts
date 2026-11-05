/**
 * The parts of Create a task that decide something, kept apart from the modal
 * (`components/todos/CreateTaskModal.tsx`) so they can be tested without a
 * browser.
 */

/** Stored per company: a slug means nothing in another company. */
function lastProjectKey(companyId: string): string {
  return `genosyn.tasks.lastProject.${companyId}`;
}

/** The Project this person last filed a task in, on this browser. */
export function readLastProjectSlug(companyId: string): string | null {
  try {
    return window.localStorage.getItem(lastProjectKey(companyId));
  } catch {
    // Storage blocked: start on the first Project, as a new browser would.
    return null;
  }
}

export function writeLastProjectSlug(companyId: string, slug: string): void {
  try {
    window.localStorage.setItem(lastProjectKey(companyId), slug);
  } catch {
    // Remembering is a convenience; the task was still created.
  }
}

/** The Project a path is on, when it is on one. Its slug, as the route has it. */
export function projectSlugFromPath(pathname: string): string | null {
  return pathname.match(/^\/c\/[^/]+\/tasks\/p\/([^/]+)/)?.[1] ?? null;
}

/**
 * Which Project a new task starts on: the first of `preferred` this person can
 * file in, else the first they can. A preference can name a Project that is
 * gone or view-only, so each is only ever a suggestion. Empty when there is
 * nowhere to file it.
 */
export function startingProjectSlug(
  projects: ReadonlyArray<{ slug: string }>,
  preferred: ReadonlyArray<string | null | undefined>,
): string {
  const match = preferred.find((slug) => slug && projects.some((p) => p.slug === slug));
  return match ?? projects[0]?.slug ?? "";
}

/**
 * A person picker's value, `ai:<id>`, `user:<id>` or empty for nobody, as the
 * two columns a Todo keeps it in. Nobody is an explicit null on both, because
 * the server takes a create that names neither as "assign it to whoever asked".
 */
export function personFromValue(value: string): {
  employeeId: string | null;
  userId: string | null;
} {
  if (value.startsWith("ai:")) return { employeeId: value.slice(3), userId: null };
  if (value.startsWith("user:")) return { employeeId: null, userId: value.slice(5) };
  return { employeeId: null, userId: null };
}
