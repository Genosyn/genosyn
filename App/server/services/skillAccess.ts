import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { decisionStackStateOf } from "./decisionStackSettings.js";

/**
 * Which Skills an AI Employee may write through its tools: its own, and no one
 * else's.
 *
 * A Skill's body is folded into every system prompt of the employee that owns
 * it (`agent/systemPrompt.ts`), so writing one writes standing instructions for
 * every future Run and chat of that employee, carried out under that employee's
 * Grants. An employee may create, edit, and delete its own Skills, and may read
 * a teammate's (`list_skills`), but a teammate's Skills change only through a
 * Member at AI → Skills. Nothing widens this: there is no setting for it, and a
 * Member driving the turn does not lend it, because an owner or admin who
 * wants a teammate's playbook changed can change it themselves. A suggested
 * change goes to a Member. `propose_revision` still covers only the employee's
 * own Skills.
 *
 * Enforcement lives at the MCP seam (`routes/mcpInternal.ts`). The Policy/taint
 * middleware asks {@link skillWriteRefusal} before the taint gate, so a write
 * that can only be refused is never held for an Approval that could not let it
 * through, and each writer asks again once it holds the owner, so the rule
 * holds for any dispatch the middleware does not recognize. The writers are
 * taint sinks too (`taintPolicy.ts`): after a web read, even a write to the
 * employee's own Skill waits for a human.
 */

/** Every MCP tool that writes a Skill. */
export const SKILL_WRITE_TOOLS = ["create_skill", "update_skill", "delete_skill"] as const;

type CompanyRef = Pick<Company, "decisionStackEnabled">;

/** Where a refused employee sends the change. Points at the Decision stack only while it takes new questions. */
function toAMember(company: CompanyRef): string {
  return decisionStackStateOf(company).enabled
    ? "say in your reply what should change and why, or raise a Decision if it needs an owner's answer, and a Member can make the change"
    : "say in your reply or work report what should change and why, and a Member can make the change";
}

/** The 403 for `create_skill` naming a teammate as the new Skill's owner. */
export function skillCreateForTeammateError(company: CompanyRef): string {
  return `create_skill adds a Skill to your own playbooks only, so leave out employeeSlug. No AI Employee can add a Skill to a teammate: only a Member can, under AI → Skills. Do not retry this or route it through another tool; ${toAMember(company)}.`;
}

/** The 403 for `update_skill` or `delete_skill` on a teammate's Skill. */
export function skillTeammateWriteError(company: CompanyRef, ownerName: string): string {
  return `This Skill belongs to ${ownerName}. You can create, edit, and delete only your own Skills; a teammate's Skills change only through a Member, under AI → Skills. Do not retry this or route it through another tool; ${toAMember(company)}.`;
}

/**
 * Why `create_skill` may not run with this `employeeSlug`, or null when it may.
 * A Skill created through the tool always belongs to the caller, so the only
 * slug it accepts is the caller's own. Any other string is refused, whether or
 * not it names an employee. A value that is not a non-empty string is passed
 * through for the handler's schema to reject.
 */
export function skillCreateRefusal(
  company: CompanyRef,
  self: Pick<AIEmployee, "slug">,
  employeeSlug: unknown,
): string | null {
  if (typeof employeeSlug !== "string" || employeeSlug === "") return null;
  return employeeSlug === self.slug ? null : skillCreateForTeammateError(company);
}

/** Why `self` may not write a Skill `owner` holds, or null when it is `self`'s own. */
export function skillOwnerWriteRefusal(
  company: CompanyRef,
  self: Pick<AIEmployee, "id">,
  owner: Pick<AIEmployee, "id" | "name">,
): string | null {
  return owner.id === self.id ? null : skillTeammateWriteError(company, owner.name);
}

/**
 * The employee a Skill write targets, looked up the way the handler will:
 * a Skill id the handler's schema accepts, owned by an employee of this
 * company. Null otherwise, so the handler answers it exactly as it always has.
 * The id is checked before the query because Postgres rejects a malformed
 * uuid outright.
 */
async function ownerOfSkill(companyId: string, skillId: unknown): Promise<AIEmployee | null> {
  const id = z.string().uuid().safeParse(skillId);
  if (!id.success) return null;
  const skill = await AppDataSource.getRepository(Skill).findOneBy({ id: id.data });
  if (!skill) return null;
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: skill.employeeId, companyId });
}

/**
 * Why this tool call may not write the Skill it names, or null when it may,
 * and null for every tool that is not a Skill writer. Run against the raw
 * request body, before the handler's validation, from the Policy/taint
 * middleware.
 */
export async function skillWriteRefusal(args: {
  company: Pick<Company, "id" | "decisionStackEnabled">;
  employee: Pick<AIEmployee, "id" | "slug">;
  toolName: string;
  body: unknown;
}): Promise<string | null> {
  const { company, employee, toolName } = args;
  if (!(SKILL_WRITE_TOOLS as readonly string[]).includes(toolName)) return null;
  const body =
    typeof args.body === "object" && args.body !== null
      ? (args.body as Record<string, unknown>)
      : {};
  if (toolName === "create_skill") return skillCreateRefusal(company, employee, body.employeeSlug);
  const owner = await ownerOfSkill(company.id, body.skillId);
  return owner ? skillOwnerWriteRefusal(company, employee, owner) : null;
}
