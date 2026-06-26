import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Two escalating capabilities a human grants an AI employee on a Code
 * Repository:
 *   - `read`  → the repo is cloned into the employee's workspace and kept
 *               fetched; the agent can read, branch, and commit locally, but
 *               `git push` is blocked (the push URL is disabled on the
 *               materialized checkout).
 *   - `write` → everything `read` allows, plus push. This is what "let this
 *               employee commit and push changes" means.
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
export type CodeRepoAccessLevel = "read" | "write";

export const CODE_REPO_ACCESS_LEVELS: CodeRepoAccessLevel[] = ["read", "write"];

export const CODE_REPO_ACCESS_RANK: Record<CodeRepoAccessLevel, number> = {
  read: 0,
  write: 1,
};

@Entity("employee_code_repository_grants")
@Index(["employeeId"])
@Index(["codeRepositoryId"])
@Index(["employeeId", "codeRepositoryId"], { unique: true })
export class EmployeeCodeRepositoryGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  codeRepositoryId!: string;

  @Column({ type: "varchar", default: "write" })
  accessLevel!: CodeRepoAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
