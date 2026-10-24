/**
 * The closed Advanced line on Admin → General: whether the installation runs
 * custom JavaScript, which is the one risky setting on the page and so the one
 * that waits behind a disclosure. Anything saved is always named, so tucking it
 * away never hides that every Member's browser runs it (AGENTS.md §8).
 *
 *   ("", "")                     → "No custom JavaScript"
 *   ("<script…>\n…", same)       → "Custom JavaScript on · 3 lines"
 *   ("", "draft")                → "No custom JavaScript · unsaved changes"
 */
export function describeCustomJavaScript(saved: string, draft: string = saved): string {
  const lines = saved.trim() ? saved.trim().split(/\r?\n/).length : 0;
  const state =
    lines === 0 ? "No custom JavaScript" : `Custom JavaScript on · ${lines} line${lines === 1 ? "" : "s"}`;
  return draft === saved ? state : `${state} · unsaved changes`;
}
