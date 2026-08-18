import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Lifecycle of one session:
 *   - `running`   → the employee's turn is in flight.
 *   - `ready`     → the turn finished and left commits on its branch, waiting
 *                   for a Member to review the diff and decide.
 *   - `empty`     → the turn finished without committing anything. Not a
 *                   failure: "I read it and there is nothing to change" is a
 *                   legitimate outcome, and it needs its own state so the UI
 *                   doesn't offer a publish button for an empty branch.
 *   - `published` → a Member imported the branch into the server checkout,
 *                   and (for a remote repository) it was pushed.
 *   - `discarded` → a Member rejected the work.
 *   - `failed`    → the turn errored, or the employee's checkout could not be
 *                   read afterwards.
 */
export type RepositoryWorkSessionStatus =
  | "running"
  | "ready"
  | "empty"
  | "published"
  | "discarded"
  | "failed";

/**
 * One request to an AI Employee to do work in a Repository, and the reviewable
 * result of that request.
 *
 * This row is the join between the two checkouts the feature keeps apart. The
 * employee works only in its own materialized checkout, which never holds a
 * credential; when its turn ends the server reads `git log` / `git diff` out
 * of that checkout and records what changed here. A Member then reviews the
 * diff in the Repository UI and publishes it, at which point the server —
 * which does hold the credentials — fetches the branch across into the
 * App-owned checkout and pushes it.
 *
 * That is the "governed server-side or Member publish step" the repository
 * prompt context has always promised employees would exist. Before this
 * entity there was no way to take an employee up on it.
 */
@Entity("repository_work_sessions")
@Index(["companyId"])
@Index(["repositoryId", "createdAt"])
@Index(["employeeId"])
export class RepositoryWorkSession {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  repositoryId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  /** The Member who asked for the work. Their access is what the turn runs with. */
  @Column({ type: "varchar", nullable: true })
  requestedByUserId!: string | null;

  /** What the Member asked for, verbatim. */
  @Column({ type: "text" })
  instruction!: string;

  @Column({ type: "varchar", default: "running" })
  status!: RepositoryWorkSessionStatus;

  /** Branch the employee committed on, once the turn has ended. */
  @Column({ type: "varchar", nullable: true })
  branch!: string | null;

  /** Commit the branch started from, so the diff has a stable base. */
  @Column({ type: "varchar", nullable: true })
  baseCommit!: string | null;

  @Column({ type: "varchar", nullable: true })
  headCommit!: string | null;

  /** The employee's own report of what it did. */
  @Column({ type: "text", default: "" })
  reply!: string;

  /** Why the session failed, when it did. */
  @Column({ type: "text", default: "" })
  error!: string;

  @Column({ type: "int", default: 0 })
  filesChanged!: number;

  @Column({ type: "int", default: 0 })
  insertions!: number;

  @Column({ type: "int", default: 0 })
  deletions!: number;

  /** Set when the branch reached the remote, so the UI can link to it. */
  @Column({ type: "varchar", nullable: true })
  publishedBranch!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
