import type { Dept } from "@/sections/Kit";
import type { RoleDef, RoleMoment } from "@/roles/data";

/**
 * Presentation facts about each role that the registry deliberately leaves
 * out (it is pure copy): which department's hue marks it, and the initials
 * its avatar carries. One table, so the landing roster, the roles index, the
 * role page and the night console never disagree about who is who.
 */

const ROLE_DEPT: Record<string, Dept> = {
  sdr: "revenue",
  "executive-assistant": "operations",
  marketer: "marketing",
  support: "email",
  bookkeeper: "finance",
  engineer: "repositories",
  recruiter: "people",
  analyst: "workspace",
};

const INITIALS: Record<string, string> = {
  sdr: "RO",
  "executive-assistant": "AV",
  marketer: "AL",
  support: "PX",
  bookkeeper: "MI",
  engineer: "SA",
  recruiter: "NR",
  analyst: "NV",
};

export function roleDept(role: RoleDef): Dept {
  return ROLE_DEPT[role.slug] ?? "operations";
}

export function roleInitials(role: RoleDef): string {
  return INITIALS[role.slug] ?? role.person.slice(0, 2).toUpperCase();
}

export function isStop(moment: RoleMoment): moment is RoleMoment & { kind: "decision" | "approval" } {
  return moment.kind === "decision" || moment.kind === "approval";
}

export const STOP_WORD = { decision: "Decision", approval: "Approval" } as const;

/** "06:40–17:45": the span of the sample day. */
export function roleHours(role: RoleDef): string {
  return `${role.day[0].time}–${role.day[role.day.length - 1].time}`;
}

/** The stop in a role's day, if it has one. */
export function roleStop(role: RoleDef) {
  return role.day.find(isStop);
}

const PRODUCT_NAME_DEPT: Record<string, Dept> = {
  Revenue: "revenue",
  Customers: "revenue",
  Email: "email",
  Finance: "finance",
  Repositories: "repositories",
  "Paid Marketing": "marketing",
  Workspace: "workspace",
  Tasks: "workspace",
  Notes: "workspace",
  Bases: "operations",
  Resources: "workspace",
  Explore: "operations",
  Pipelines: "operations",
  "Decision stack": "operations",
};

/** The department of the product a moment of the day happens in. */
export function momentDept(moment: RoleMoment): Dept | undefined {
  return PRODUCT_NAME_DEPT[moment.where.split("·")[0].trim()];
}
