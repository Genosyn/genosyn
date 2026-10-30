import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Which piece of AI work is waiting. Each kind's resume lives beside the
 * feature it belongs to, listed in `services/modelWaits.ts`.
 */
export type AIModelWaitKind =
  /** The read (and the instructions' steps) of an email that arrived — `mail/analysis.ts`. */
  | "mail_arrival_read"
  /** One owner's share of a group discussion's "Start the work" — `groupDiscussions.ts`. */
  | "discussion_work"
  /** The work session that starts once a Decision is answered — `decisionKickoff.ts`. */
  | "decision_pickup"
  /** The AI decider's session for a Decision a decision policy routed — `decisionRouting.ts`. */
  | "decision_routing"
  /** A Pipeline run paused at an AI step — `pipelines/executor.ts`. */
  | "pipeline_run"
  /** An answer in a customer channel — `customerChannels/replies.ts`. */
  | "customer_channel_reply"
  /** An automatic reply to a text — `phone/textReplies.ts`. */
  | "phone_text_reply"
  /** The text that follows up a call taken while the AI Model was unavailable — `phone/calls.ts`. */
  | "phone_call_follow_up"
  /** An answer on Slack, Teams, Telegram or WhatsApp — `chatSurfaces/inbound.ts`. */
  | "chat_surface_reply";

/** `waiting` until its AI Model answers; `resuming` while one process carries it on. */
export type AIModelWaitStatus = "waiting" | "resuming";

/**
 * One piece of AI work waiting for its AI Model to come back, that has no
 * queue of its own to wait in.
 *
 * A Run waits in the Routine queue and a chat message in its conversation
 * (`services/modelAvailability.ts`). Other AI work has no such place: an email's
 * arrival read, a Pipeline run stopped at an AI step, an answer owed in a
 * Slack thread, a text, a Decision's pickup. When its AI Model is unavailable
 * the feature records on its own row what a person should see (the email is
 * "waiting", the run is "paused", the Decision's pickup is "waiting") and adds
 * one of these rows, which `services/modelWaits.ts` resumes — once, when the
 * model answers again — through the feature's own code, so every rule the work
 * meets on a normal day (Grants, Standdowns, delivery limits, who may read the
 * answer) is checked at the moment it actually runs.
 *
 * `(kind, targetId)` is unique: a piece of work waits once however often it
 * meets the outage. The row is deleted when the work runs or is given up; the
 * feature's own row keeps the history. `payloadJson` holds only what that row
 * cannot — a reply's destination, a paused run's place in its graph, the
 * Member authority a Decision's pickup was given — and never a secret.
 */
@Entity("ai_model_waits")
@Index(["kind", "targetId"], { unique: true })
@Index(["status", "resumeAt"])
@Index(["companyId", "modelId"])
@Index(["kind", "groupKey"])
export class AIModelWait {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: AIModelWaitKind;

  /** The feature row this resumes: the email's analysis, the Pipeline run, the Decision… */
  @Column({ type: "varchar" })
  targetId!: string;

  /**
   * Work that is answered together — one conversation, one thread, one
   * Pipeline — so the newest waiting message can answer the ones before it.
   */
  @Column({ type: "varchar", nullable: true })
  groupKey!: string | null;

  /** The AI Employee whose AI Model the work runs on. */
  @Column({ type: "varchar" })
  employeeId!: string;

  /** The AI Model it found unavailable; the AI Models page counts what waits on each. */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  @Column({ type: "varchar", default: "waiting" })
  status!: AIModelWaitStatus;

  /** Times it was carried on and met the AI Model unavailable again. */
  @Column({ type: "integer", default: 0 })
  attempts!: number;

  /** When it is next looked at. Its AI Model answering again looks at it at once. */
  @Column({ type: dateTimeColumnType })
  resumeAt!: Date;

  /** While `resuming`: when the process carrying it on stops holding it, unless renewed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  claimedUntil!: Date | null;

  /** What the resume needs that the feature's row does not hold. After every filtered column. */
  @Column({ type: "text", default: "{}" })
  payloadJson!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
