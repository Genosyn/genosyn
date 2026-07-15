import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Project } from "../db/entities/Project.js";
import {
  PROJECT_ACCESS_RANK,
  ProjectAccessLevel,
  ProjectMember,
  ProjectMemberKind,
} from "../db/entities/ProjectMember.js";
import { Role } from "../db/entities/Membership.js";
import { roleAtLeast } from "../middleware/auth.js";

/**
 * The Project access model.
 *
 * Two things make this different from the `Employee*Grant` services in
 * `explore.ts` / `notes.ts`, and both are deliberate:
 *
 *   1. **Humans do not bypass it.** Every other ACL in this codebase governs
 *      only what AI employees see through MCP; a Member sees everything in
 *      their company. Here a human Member and an AI employee are the same
 *      kind of principal — a {@link ProjectActor} — and flow through the same
 *      checks. That is what the product asks for: one Access list naming both.
 *
 *   2. **Rows are only consulted when the project is `restricted`.** An
 *      `open` project has no {@link ProjectMember} rows and grants `write` to
 *      everyone in the company. So the default costs nothing, and this whole
 *      feature is inert until a human turns it on for a given project.
 *
 * The model is flat and ranked (like charts, `explore.ts`), not cascading
 * (like notes). Todos and comments inherit their project's access with no
 * ancestor walk — see {@link ProjectMember}.
 *
 * Nothing here throws. Callers get `null` / `false` / an empty Set and decide
 * whether that is a 403 (a named project you can't reach) or a filter (a list
 * that simply omits it).
 *
 * Only the access model lives here. The rest of the project logic is still
 * inline in `routes/projects.ts`; extracting it is a separate change.
 */
export type ProjectActor =
  | { kind: "user"; id: string; role: Role }
  | { kind: "ai"; id: string };

/** Narrow an actor to the columns that identify it on a `ProjectMember` row. */
function memberWhere(projectId: string, actor: ProjectActor) {
  return actor.kind === "user"
    ? { projectId, userId: actor.id }
    : { projectId, employeeId: actor.id };
}

/**
 * The actor's effective level on `project`, or `null` if they have none.
 *
 * Order matters: the owner/admin bypass comes first so a company owner can
 * always recover a project whose members locked themselves out.
 */
export async function findProjectAccess(
  project: Project,
  actor: ProjectActor,
): Promise<ProjectAccessLevel | null> {
  // `roleAtLeast` takes the threshold first, then the candidate.
  if (actor.kind === "user" && roleAtLeast("admin", actor.role)) return "write";
  if (project.accessMode === "open") return "write";
  const row = await AppDataSource.getRepository(ProjectMember).findOneBy(
    memberWhere(project.id, actor),
  );
  return row?.accessLevel ?? null;
}

export async function hasProjectAccess(
  project: Project,
  actor: ProjectActor,
  required: ProjectAccessLevel,
): Promise<boolean> {
  const level = await findProjectAccess(project, actor);
  if (!level) return false;
  return PROJECT_ACCESS_RANK[level] >= PROJECT_ACCESS_RANK[required];
}

/**
 * Every project id in the company the actor can at least read. Used by the
 * list endpoints, which filter rather than 403 — you can't be forbidden from
 * something you were never told about.
 *
 * Two queries regardless of project count: the company's projects (id +
 * mode only), and the actor's rows.
 */
export async function listAccessibleProjectIds(
  companyId: string,
  actor: ProjectActor,
): Promise<Set<string>> {
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId },
    select: ["id", "accessMode"],
  });
  if (actor.kind === "user" && roleAtLeast("admin", actor.role)) {
    return new Set(projects.map((p) => p.id));
  }

  const open = projects.filter((p) => p.accessMode === "open");
  const restricted = projects.filter((p) => p.accessMode === "restricted");
  const ids = new Set(open.map((p) => p.id));
  if (restricted.length === 0) return ids;

  const rows = await AppDataSource.getRepository(ProjectMember).find({
    where:
      actor.kind === "user"
        ? { projectId: In(restricted.map((p) => p.id)), userId: actor.id }
        : { projectId: In(restricted.map((p) => p.id)), employeeId: actor.id },
  });
  for (const r of rows) ids.add(r.projectId);
  return ids;
}

export async function listProjectMembers(
  projectId: string,
): Promise<ProjectMember[]> {
  return AppDataSource.getRepository(ProjectMember).find({
    where: { projectId },
    order: { createdAt: "ASC" },
  });
}

/** Idempotent: re-adding someone updates their level instead of duplicating. */
export async function upsertProjectMember(
  projectId: string,
  member: { kind: ProjectMemberKind; id: string },
  accessLevel: ProjectAccessLevel,
): Promise<ProjectMember> {
  const repo = AppDataSource.getRepository(ProjectMember);
  const actor: ProjectActor =
    member.kind === "user"
      ? { kind: "user", id: member.id, role: "member" }
      : { kind: "ai", id: member.id };
  const existing = await repo.findOneBy(memberWhere(projectId, actor));
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  return repo.save(
    repo.create({
      projectId,
      memberKind: member.kind,
      userId: member.kind === "user" ? member.id : null,
      employeeId: member.kind === "ai" ? member.id : null,
      accessLevel,
    }),
  );
}

/**
 * Humans with `write` on a restricted project. The UI needs at least one, or
 * nobody can administer the project — AI employees deliberately don't count,
 * since they can't open the Access tab.
 */
export async function countWriteHumans(projectId: string): Promise<number> {
  return AppDataSource.getRepository(ProjectMember).countBy({
    projectId,
    memberKind: "user",
    accessLevel: "write",
  });
}

/**
 * Flip a project to `restricted`, seeding the acting human with `write` in the
 * same transaction.
 *
 * The seed is not a nicety. Without it the project has zero members the
 * instant it is restricted, and everyone — including whoever just clicked the
 * button — is locked out.
 *
 * Rows survive a flip back to `open`, so restricted → open → restricted is
 * lossless.
 */
export async function restrictProject(
  project: Project,
  actor: ProjectActor,
): Promise<void> {
  await AppDataSource.transaction(async (m) => {
    project.accessMode = "restricted";
    await m.save(Project, project);
    if (actor.kind !== "user") return;
    const repo = m.getRepository(ProjectMember);
    const existing = await repo.findOneBy(memberWhere(project.id, actor));
    if (existing) {
      if (existing.accessLevel !== "write") {
        existing.accessLevel = "write";
        await repo.save(existing);
      }
      return;
    }
    await repo.save(
      repo.create({
        projectId: project.id,
        memberKind: "user",
        userId: actor.id,
        employeeId: null,
        accessLevel: "write",
      }),
    );
  });
}

export async function deleteMembersForProject(projectId: string): Promise<void> {
  await AppDataSource.getRepository(ProjectMember).delete({ projectId });
}
