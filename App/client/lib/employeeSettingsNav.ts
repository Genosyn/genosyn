/**
 * Which pane of an employee's Settings a URL is on.
 *
 * The Settings rail keeps its less-used panes (Memory, Journal, Handoffs, …)
 * under a collapsed "Advanced" group, and opens that group by itself when the
 * current URL is one of them, so the entry you are on is never hidden. That
 * needs the pane's name out of the pathname — and company and employee slugs
 * are user-chosen, so a slug may itself be `settings` (or the start of another
 * slug). The pathname is therefore only read after the employee's own base
 * path, never searched for `/settings/`.
 *
 * Returns the pane (`"memory"` for `/c/acme/employees/ada/settings/memory`), or
 * null for anything that is not a Settings pane of this employee: Chat, the
 * bare `/settings` redirect, another employee.
 */
export function employeeSettingsPage(
  pathname: string,
  companySlug: string,
  employeeSlug: string,
): string | null {
  const base = `/c/${companySlug}/employees/${employeeSlug}`;
  if (!pathname.startsWith(base)) return null;
  const match = /^\/settings\/([^/]+)/.exec(pathname.slice(base.length));
  return match ? match[1] : null;
}
