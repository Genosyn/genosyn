import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Authorizes one principal — a human {@link Membership} or an
 * {@link AIEmployee} — on a {@link Project}. Exactly one of `userId` /
 * `employeeId` is non-null; they stay separate columns (rather than a
 * polymorphic `memberId`) for the same reason {@link ChannelMember} does it,
 * and for the same reason `Todo` splits `assigneeUserId` / `assigneeEmployeeId`.
 *
 * Not to be confused with `Membership`, which is company-wide. A
 * `ProjectMember` row says nothing about company access — it only narrows a
 * single project.
 *
 * **Rows only matter when `Project.accessMode === "restricted"`.** An `open`
 * project (the default, and every project that existed before this table) is
 * readable and writable by every Member and every AI employee in the company,
 * and carries no rows at all. That is what keeps the common case free: no
 * backfill, no row-per-principal fan-out, and an employee hired next year sees
 * open projects without anyone having to remember to add them.
 *
 * Access **cascades down to every Todo and TodoComment in the project**. A
 * Todo has no life outside its project — `Todo.projectId` is NOT NULL and
 * `Todo.number` only means anything as `{Project.key}-{number}` — so there is
 * no `TodoMember` and no ancestor walk. The cascade is resolved at
 * access-check time in `services/projects.ts`, so removing someone takes
 * effect immediately.
 *
 * Unlike the `Employee*Grant` tables, humans do **not** bypass this one. It
 * governs the HTTP surface and the MCP surface alike.
 */
export type ProjectMemberKind = "user" | "ai";

/**
 * Two levels:
 *   - `read`  → see the project, open it, read its todos and comments
 *   - `write` → read + create / edit / move / delete todos, comment, rename
 *               or delete the project, and change who has access
 *
 * The order matches `PROJECT_ACCESS_RANK` below so `hasProjectAccess` can
 * compare with a single integer test instead of a switch.
 */
export type ProjectAccessLevel = "read" | "write";

export const PROJECT_ACCESS_LEVELS: ProjectAccessLevel[] = ["read", "write"];

export const PROJECT_ACCESS_RANK: Record<ProjectAccessLevel, number> = {
  read: 0,
  write: 1,
};

@Entity("project_members")
@Index(["projectId", "userId"], { unique: true, where: '"userId" IS NOT NULL' })
@Index(["projectId", "employeeId"], {
  unique: true,
  where: '"employeeId" IS NOT NULL',
})
@Index(["userId"])
@Index(["employeeId"])
export class ProjectMember {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  projectId!: string;

  @Column({ type: "varchar" })
  memberKind!: ProjectMemberKind;

  @Column({ type: "varchar", nullable: true })
  userId!: string | null;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: ProjectAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
