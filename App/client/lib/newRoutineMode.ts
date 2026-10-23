/**
 * Which way New routine opens.
 *
 * The form is the page: Name, Assigned to, Schedule and the brief, and every
 * New routine button opens it — the Routines list and its sidebar, a folder,
 * one employee's routines, Running, Proactive, ⌘K. Describing the work to an
 * AI Employee is the other way in, one link under the form. While it is open
 * the page's address says so with `?describe=1`, so a reload or a link that
 * is about describing lands back on it, and a plain New routine never does.
 * Nothing opens it while no AI Employee can answer a Chat.
 */

export type NewRoutineMode = "form" | "describe";

/** The query parameter that asks for the describe view; `1` is the only value that does. */
export const DESCRIBE_PARAM = "describe";

/**
 * The view to show for this address. `canDescribe` is whether any AI Employee
 * can be asked; the presets beside the parameter (`?employee=`, `?folder=`)
 * never change the answer.
 */
export function newRoutineMode(search: URLSearchParams, canDescribe: boolean): NewRoutineMode {
  return canDescribe && search.get(DESCRIBE_PARAM) === "1" ? "describe" : "form";
}

/**
 * The address once the person switches to `mode`. Everything else in it stays,
 * so the employee and folder the list was narrowed to survive switching either
 * way and back.
 */
export function withNewRoutineMode(search: URLSearchParams, mode: NewRoutineMode): URLSearchParams {
  const next = new URLSearchParams(search);
  if (mode === "describe") next.set(DESCRIBE_PARAM, "1");
  else next.delete(DESCRIBE_PARAM);
  return next;
}
