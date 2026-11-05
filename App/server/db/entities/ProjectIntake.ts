import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { IntakeReplyMode } from "../../../shared/projectIntake.js";

/**
 * A Project's intake: an owner's standing instruction for which incoming email
 * becomes this Project's Todos, who works them, and how far they may go. Off until
 * an owner or admin turns it on, one per Project.
 *
 * An email is a stranger's writing, so it can't grant anything. This row is how a
 * person moves the human gate ahead of time rather than removing it: they write
 * what belongs here and how far it may go, and an email only ever matches that.
 *
 * Owners and admins only, from a signed-in browser, and no AI Employee tool writes
 * one, for the same reason none writes a Check: a bar the graded party can move is
 * not a bar. See `services/todoIntake.ts`.
 */
@Entity("project_intakes")
export class ProjectIntake {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Index({ unique: true })
  @Column({ type: "varchar" })
  projectId!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  /** A Member's words on which email belongs here. The AI Employee reading mail chooses by these. */
  @Column({ type: "text", default: "" })
  whatBelongs!: string;

  /** A Member's standing brief for whoever works these Todos. Trusted, unlike the email. */
  @Column({ type: "text", default: "" })
  instruction!: string;

  /** Mailbox ids it takes mail from, as JSON. Empty means all of the company's. */
  @Column({ type: "text", default: "[]" })
  accountIdsJson!: string;

  /** Who works them. Null: the AI picks from who can work here. */
  @Column({ type: "varchar", nullable: true })
  assigneeEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  reviewerEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  reviewerUserId!: string | null;

  /** `send` lets an email-started session reply on its own thread without review. */
  @Column({ type: "varchar", default: "review" })
  replyMode!: IntakeReplyMode;

  /** Addresses and `@domain`s, one per line, whose verified mail may use tools and the browser. */
  @Column({ type: "text", default: "" })
  trustedSenders!: string;

  @Column({ type: "varchar", nullable: true })
  updatedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
