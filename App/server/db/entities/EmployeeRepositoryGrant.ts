import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Two access levels a Member grants an AI Employee on a Repository:
 *   - `read`  → the repo is cloned into the employee's workspace and kept
 *               fetched; the agent can read, branch, and commit locally, but
 *               `git push` is blocked (the push URL is disabled on the
 *               materialized checkout).
 *   - `write` → authorizes work and pushing the employee's own completed Work
 *               session branch using the Repository's server-owned SSH key or
 *               HTTPS token. Borrowing a Connection for Git, or opening a pull
 *               request through its API, also needs a separate Grant to that
 *               exact pinned Connection. Merging and default-branch publication
 *               remain Member actions. Credentials never enter employee tools.
 *
 * `read` is the floor because a private repo can't even be cloned without
 * credentials, so withholding a grant entirely (rather than granting `read`)
 * is how you keep an employee out. The default when sharing is `write`,
 * because the point of adding a repo is usually to let the employee work on
 * it.
 *
 * Humans (members) bypass this table entirely; it only governs the AI
 * surface.
 */
export type RepositoryAccessLevel = "read" | "write";

export const REPOSITORY_ACCESS_LEVELS: RepositoryAccessLevel[] = ["read", "write"];

export const REPOSITORY_ACCESS_RANK: Record<RepositoryAccessLevel, number> = {
  read: 0,
  write: 1,
};

@Entity("employee_code_repository_grants")
@Index(["employeeId"])
@Index(["repositoryId"])
@Index(["employeeId", "repositoryId"], { unique: true })
export class EmployeeRepositoryGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  repositoryId!: string;

  @Column({ type: "varchar", default: "write" })
  accessLevel!: RepositoryAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
