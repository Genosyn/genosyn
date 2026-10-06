import type { Employee, Team } from "./api";

/** One card on the Employees page: an AI Employee and the team badge it wears. */
export type RosterCard = {
  employee: Employee;
  /** The employee's team, or null when it has none, or its team is archived or unknown. */
  teamName: string | null;
};

/**
 * The Employees page roster: every AI Employee exactly once, alphabetical, each
 * with the name of the live team it belongs to.
 *
 * The page used to draw an org chart from reporting lines and seat the
 * company's human Members in it as managers. Both are gone, so this is a flat
 * list of AI Employees — the people who open into Chat and Settings — and
 * Members stay where they are managed, at Settings → Members.
 *
 * Sorting is by name, case- and accent-insensitive, with the slug as a
 * tie-break so two employees sharing a display name keep a stable order on
 * every reload (the list endpoint itself promises no order). An archived
 * team's badge is hidden, the same as on the employee's own Team card, and a
 * `teams` of null — still loading — simply shows no badges yet.
 */
export function rosterCards(employees: Employee[], teams: Team[] | null): RosterCard[] {
  const liveTeams = new Map<string, string>();
  for (const team of teams ?? []) {
    if (!team.archivedAt) liveTeams.set(team.id, team.name);
  }
  const seen = new Set<string>();
  const unique = employees.filter((employee) => {
    if (seen.has(employee.id)) return false;
    seen.add(employee.id);
    return true;
  });
  return unique
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.slug.localeCompare(b.slug),
    )
    .map((employee) => ({
      employee,
      teamName: employee.teamId ? (liveTeams.get(employee.teamId) ?? null) : null,
    }));
}
