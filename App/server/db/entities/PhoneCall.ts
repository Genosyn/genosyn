import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type PhoneCallDirection = "inbound" | "outbound";

/** Twilio's call lifecycle, as its status callback reports it. */
export type PhoneCallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed"
  | "canceled";

export const FINISHED_CALL_STATUSES: readonly PhoneCallStatus[] = [
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
];

/**
 * Who dealt with the call.
 *
 *  - `employee`    — the AI Employee talked.
 *  - `forwarded`   — the number's call handling rang a person instead.
 *  - `declined`    — the number's call handling refused it.
 *  - `unavailable` — the AI Employee could not take it (none assigned, a
 *                    Standdown, no AI Model, a daily limit), so the caller was
 *                    told so and the call ended.
 *  - `message`     — the AI Employee's AI Model was unavailable (its service
 *                    down or overloaded), so it said so briefly and took a
 *                    message, which is in the transcript; a text follows it up
 *                    once the model is back when the number replies to texts.
 */
export type PhoneCallHandling = "employee" | "forwarded" | "declined" | "unavailable" | "message";

/**
 * Where the employee's next spoken reply is. A call is a loop of HTTP requests
 * from Twilio — each one has to be answered within seconds — while a model
 * turn can take longer, so the reply is produced in the background and the
 * row is the rendezvous: the request that started the turn and any request
 * that comes back for the answer read it here, on whichever replica they
 * land. `unavailable` is a turn that met the AI Model unavailable: the call
 * apologises and, when someone called in, takes a message.
 */
export type PhoneCallReplyState = "idle" | "thinking" | "ready" | "failed" | "unavailable";

export type PhoneCallTranscriptTurn = {
  /** `caller` is the other party on either direction of call. */
  speaker: "caller" | "employee";
  text: string;
  /** ISO timestamp. */
  at: string;
  /** Keys pressed on the line by the employee, when it pressed any. */
  digits?: string;
};

/**
 * One phone call on a {@link PhoneNumber}, answered or placed by its AI
 * Employee, with the transcript of what both sides said.
 *
 * No audio is recorded. What was said reaches Genosyn as Twilio's speech
 * recognition, and what the employee says leaves as text-to-speech; the
 * transcript is those two streams of text. `brief` and `openingLine` are what
 * the employee wrote when it placed an outbound call — the only briefing that
 * call runs on.
 *
 * `transcriptJson` sits after every column a list filters or sorts on, and the
 * list reads through the `(phoneNumberId, createdAt, id)` index without
 * selecting it, so a long transcript is never read to build a page of calls.
 */
@Entity("phone_calls")
// Ends in `id`, so a page of one number's calls — keyset on (createdAt, id) —
// is read in index order, ties and all.
@Index(["phoneNumberId", "createdAt", "id"])
@Index(["companyId", "createdAt"])
@Index(["providerSid"], { unique: true, where: '"providerSid" IS NOT NULL' })
export class PhoneCall {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  phoneNumberId!: string;

  /** The AI Employee the number belonged to when the call happened. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar" })
  direction!: PhoneCallDirection;

  @Column({ type: "varchar" })
  fromNumber!: string;

  @Column({ type: "varchar" })
  toNumber!: string;

  /** Twilio's call sid (`CA…`). Null until Twilio accepts an outbound call. */
  @Column({ type: "varchar", nullable: true })
  providerSid!: string | null;

  @Column({ type: "varchar", default: "queued" })
  status!: PhoneCallStatus;

  @Column({ type: "varchar", default: "employee" })
  handling!: PhoneCallHandling;

  /** Answered — the moment the conversation could start. */
  @Column({ type: dateTimeColumnType, nullable: true })
  answeredAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  /** Twilio's billed duration, once the call has ended. */
  @Column({ type: "integer", nullable: true })
  durationSec!: number | null;

  /** Why the conversation ended, in a few words ("The employee hung up"). */
  @Column({ type: "varchar", default: "" })
  endReason!: string;

  @Column({ type: "varchar", default: "" })
  errorMessage!: string;

  /** The Run that placed an outbound call, for provenance. */
  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  /** Member who placed it from the app; null when the AI Employee did. */
  @Column({ type: "varchar", nullable: true })
  placedByUserId!: string | null;

  @Column({ type: "integer", default: 0 })
  turnCount!: number;

  /** Consecutive turns in which the other side said nothing. */
  @Column({ type: "integer", default: 0 })
  silenceCount!: number;

  @Column({ type: "varchar", default: "idle" })
  replyState!: PhoneCallReplyState;

  /** Identifies the turn being produced, so a late turn cannot overwrite a newer one. */
  @Column({ type: "varchar", nullable: true })
  replyTurnId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  replyStartedAt!: Date | null;

  /** The employee asked to hang up after this reply. */
  @Column({ type: "boolean", default: false })
  replyEndsCall!: boolean;

  /** Keys to press before speaking, for a phone menu on an outbound call. */
  @Column({ type: "varchar", default: "" })
  replyDigits!: string;

  @Column({ type: "text", default: "" })
  replyText!: string;

  /** What the employee wrote about why it is calling — outbound only. */
  @Column({ type: "text", default: "" })
  brief!: string;

  /** The sentence the employee says when an outbound call connects. */
  @Column({ type: "text", default: "" })
  openingLine!: string;

  /** JSON array of {@link PhoneCallTranscriptTurn}. */
  @Column({ type: "text", default: "[]" })
  transcriptJson!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
