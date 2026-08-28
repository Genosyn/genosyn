import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A **Lesson** — the structured takeaway a restricted reflection turn writes
 * after a failed or off-goal Run (M52). Cause plus what to do differently,
 * scoped to the Routine that produced it, and folded into that Routine's
 * future Run briefs so the next attempt starts where this one stumbled
 * instead of rediscovering it.
 *
 * Vocabulary: this is a **Lesson**, never a "Learning" (Resources' old name),
 * an "Insight", or a "Retro" — see AGENTS.md §3. The entity is `RunLesson`
 * because a bare `Lesson` table would shadow nothing today but reads
 * ambiguously beside Skills, which are also things an employee "knows".
 *
 * A Lesson is model-written from an untrusted transcript, so everything that
 * surfaces one treats it as prose to render, never as instructions to the
 * server. Injection is bounded (the latest few undismissed per Routine) and a
 * human can dismiss a wrong lesson from the Routine page — dismissal hides it
 * from future briefs without deleting the record of what the reflection saw.
 */
@Entity("run_lessons")
@Index(["companyId", "createdAt"])
// The injection's hot query — latest undismissed lessons for one routine.
@Index(["routineId", "createdAt"])
export class RunLesson {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The employee whose Run was reflected on — the lesson is theirs. */
  @Column({ type: "varchar" })
  employeeId!: string;

  /** The Routine whose future briefs carry this lesson. Nullable because a
   * Routine can be deleted after the fact; an orphaned lesson keeps its
   * history but is never injected anywhere. */
  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  /** The Run the reflection read. Kept as a plain id — the Run row may be
   * swept with its Routine while the lesson outlives it. */
  @Column({ type: "varchar" })
  runId!: string;

  /** What actually went wrong, in one or two sentences of the checker's own
   * words. Evidence-shaped: "the digest was posted to the wrong channel",
   * not "be more careful". */
  @Column({ type: "text", default: "" })
  cause!: string;

  /** What the next Run should do differently — the part that is injected. */
  @Column({ type: "text", default: "" })
  advice!: string;

  /** Set when a human decides the lesson is wrong or stale. A dismissed
   * lesson leaves future briefs immediately but stays visible in history. */
  @Column({ type: dateTimeColumnType, nullable: true })
  dismissedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
