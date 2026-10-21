import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type ApplicationEventKind =
  | "applied"
  | "added"
  | "stage_changed"
  | "note"
  | "scored"
  | "screen_failed"
  | "email_sent"
  | "email_failed"
  | "email_skipped"
  | "criteria_drafted";

export type ApplicationEventActorKind = "candidate" | "member" | "employee" | "system";

/**
 * One line in an Application's story: it arrived, it was scored, someone
 * moved it, someone wrote a note, an email went out.
 *
 * The timeline is what makes an Application legible to a person and an AI
 * Employee alike — the same rows render on the Application page and come back
 * from `get_application`. Rows are written by the server as things happen and
 * are never edited; the actor's name is copied in so the story still reads
 * after a Member leaves or an AI Employee is retired.
 */
@Entity("recruiting_application_events")
@Index(["applicationId", "occurredAt"])
@Index(["companyId", "occurredAt"])
export class RecruitingApplicationEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  openingId!: string;

  @Column({ type: "varchar" })
  applicationId!: string;

  @Column({ type: "varchar" })
  kind!: ApplicationEventKind;

  @Column({ type: "varchar" })
  actorKind!: ApplicationEventActorKind;

  @Column({ type: "varchar", nullable: true })
  actorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorEmployeeId!: string | null;

  @Column({ type: "varchar", default: "" })
  actorName!: string;

  @Column({ type: "varchar", nullable: true })
  fromStage!: string | null;

  @Column({ type: "varchar", nullable: true })
  toStage!: string | null;

  /**
   * When it happened, to the millisecond and never repeating within a process,
   * so a timeline written in one burst — applied, emailed, scored — reads in
   * the order it happened. `createdAt` has only the database's precision.
   */
  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  /** Small structured detail: a Scorecard id, an email's subject and status. */
  @Column({ type: "text", default: "{}" })
  metaJson!: string;

  /** A note's text, or the reason given for a move. */
  @Column({ type: "text", default: "" })
  body!: string;
}
