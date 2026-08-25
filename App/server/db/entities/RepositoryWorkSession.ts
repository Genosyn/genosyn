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
 *   - `running`   → one of the employee's turns is in flight.
 *   - `ready`     → the last turn finished and left commits on the branch,
 *                   waiting for a Member to review the diff and decide.
 *   - `empty`     → the last turn finished without committing anything. Not a
 *                   failure: "I read it and there is nothing to change" is a
 *                   legitimate outcome, and it needs its own state so the UI
 *                   doesn't offer a publish button for an empty branch.
 *   - `proposed`  → the branch was pushed and a pull request is open on it.
 *                   Still revisable: another turn pushes onto the same branch
 *                   and the open pull request picks the commits up.
 *   - `published` → a Member imported the branch into the server checkout,
 *                   and (for a remote repository) it was pushed.
 *   - `discarded` → a Member rejected the work.
 *   - `failed`    → the last turn errored, or the employee's checkout could not
 *                   be read afterwards. Revisable — asking again retries.
 *
 * Only `published` and `discarded` are terminal. Every other state accepts a
 * follow-up turn, which is what makes a session a conversation rather than a
 * one-shot request.
 */
export type RepositoryWorkSessionStatus =
  | "running"
  | "ready"
  | "empty"
  | "proposed"
  | "published"
  | "discarded"
  | "failed";

/** Statuses a Member may send another instruction into. */
export const REVISABLE_WORK_SESSION_STATUSES: readonly RepositoryWorkSessionStatus[] = [
  "ready",
  "empty",
  "proposed",
  "failed",
];

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

  /** The Member who opened the session. Each turn records its own asker. */
  @Column({ type: "varchar", nullable: true })
  requestedByUserId!: string | null;

  /**
   * Short label for the session list, derived from the opening instruction and
   * renameable. A list of twenty-line instructions is unreadable, and a
   * session you cannot recognise is a session you cannot switch back to.
   */
  @Column({ type: "varchar", default: "" })
  title!: string;

  /** What the session was opened with, verbatim. Turn 1 repeats it. */
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

  /** The employee's report from the most recent turn. */
  @Column({ type: "text", default: "" })
  reply!: string;

  /** Why the most recent turn failed, when it did. */
  @Column({ type: "text", default: "" })
  error!: string;

  /** How many turns the session has had, so a list row can say so. */
  @Column({ type: "int", default: 0 })
  turnCount!: number;

  @Column({ type: "int", default: 0 })
  filesChanged!: number;

  @Column({ type: "int", default: 0 })
  insertions!: number;

  @Column({ type: "int", default: 0 })
  deletions!: number;

  /** Set when the branch reached the remote, so the UI can link to it. */
  @Column({ type: "varchar", nullable: true })
  publishedBranch!: string | null;

  /** The pull request opened for this session's branch, when there is one. */
  @Column({ type: "varchar", nullable: true })
  pullRequestUrl!: string | null;

  @Column({ type: "int", nullable: true })
  pullRequestNumber!: number | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  /**
   * Set when a Member archived the session, which takes it out of the AI work
   * inbox without ending it.
   *
   * Deliberately not another `status`. A status says what happened to the
   * *work*; archiving says what a Member wants to see in a *list*. Folding the
   * two together would make "I have read this and I am done with it"
   * indistinguishable from "I threw the work away", and would have to invent
   * an answer for the question a status cannot hold — what an archived session
   * goes back to when it is restored. Keeping it separate means the status is
   * untouched, so restoring puts the row back exactly where it was.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
