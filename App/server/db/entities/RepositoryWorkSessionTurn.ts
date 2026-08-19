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
 * Lifecycle of one turn:
 *   - `running` → the employee is working on this instruction now.
 *   - `ok`      → the turn completed. It may still have committed nothing;
 *                 that is a legitimate answer and the commit stats say so.
 *   - `failed`  → the turn errored, and `error` says why.
 */
export type RepositoryWorkSessionTurnStatus = "running" | "ok" | "failed";

/**
 * One exchange inside a {@link RepositoryWorkSession}: what a Member asked for
 * and what the employee did about it.
 *
 * A session used to be a single request with a single answer, so asking for a
 * change meant starting again from the trunk and losing everything the
 * employee had already worked out. Turns are what make a session a
 * conversation instead: every follow-up runs in the *same* worktree on the
 * *same* branch, with the previous turns replayed as history, so "nearly — now
 * also handle the empty case" costs one instruction rather than a re-run.
 *
 * The per-turn commit range is recorded as well as the session-wide one. They
 * answer different questions: the session's range is what a Member merges, and
 * the turn's range is what changed *because of this instruction*, which is the
 * only way to review a revision without re-reading the whole diff.
 */
@Entity("repository_work_session_turns")
@Index(["sessionId", "ordinal"])
@Index(["companyId"])
export class RepositoryWorkSessionTurn {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  sessionId!: string;

  /** 1-based position in the session, so the transcript has a stable order. */
  @Column({ type: "int", default: 1 })
  ordinal!: number;

  /** What was asked for on this turn, verbatim. */
  @Column({ type: "text" })
  instruction!: string;

  /** The employee's own report of what it did on this turn. */
  @Column({ type: "text", default: "" })
  reply!: string;

  @Column({ type: "varchar", default: "running" })
  status!: RepositoryWorkSessionTurnStatus;

  @Column({ type: "text", default: "" })
  error!: string;

  /** The Member who asked. Their access is what this turn runs with. */
  @Column({ type: "varchar", nullable: true })
  requestedByUserId!: string | null;

  /** Branch head before this turn ran, so the turn's own diff has a base. */
  @Column({ type: "varchar", nullable: true })
  baseCommit!: string | null;

  @Column({ type: "varchar", nullable: true })
  headCommit!: string | null;

  @Column({ type: "int", default: 0 })
  filesChanged!: number;

  @Column({ type: "int", default: 0 })
  insertions!: number;

  @Column({ type: "int", default: 0 })
  deletions!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
