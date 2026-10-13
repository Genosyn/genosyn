import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { PhoneCallMode, PhoneTextMode } from "../../../shared/phone.js";

/**
 * A **Phone number** — a Twilio number the company reserved (or brought in from
 * its Twilio account) and gave to one AI Employee, so the employee can text,
 * read the texts that arrive (verification codes included), answer calls and
 * place them.
 *
 * The number belongs to the company, not to the employee: `employeeId` is the
 * assignment, and it is the employee's only authority over the number. There is
 * no separate Grant row — "this is your number" is the Grant, and moving the
 * number to another employee moves every capability with it. An unassigned
 * number declines calls and keeps texts for whoever is given it next.
 *
 * Credentials never live here. The number points at the Twilio
 * `IntegrationConnection` whose Account SID and Auth Token reserved it, and
 * every API call and every webhook signature check goes through that
 * Connection. `providerSid` is Twilio's id for the number (`PN…`) and is unique
 * across the install, so one number can only ever be pointed at one place.
 *
 * Everything a stranger can reach — the greeting, the instructions, how calls
 * and texts are handled — is written by a Member on this row. A caller or
 * texter is never verified (caller ID is trivially spoofed), so the employee
 * talks to them from these instructions alone, never from its Soul, Memory or
 * company tools.
 */
@Entity("phone_numbers")
@Index(["companyId"])
@Index(["employeeId"])
@Index(["connectionId"])
@Index(["providerSid"], { unique: true })
export class PhoneNumber {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The Twilio Connection that owns the number in Twilio. */
  @Column({ type: "varchar" })
  connectionId!: string;

  /** The AI Employee this number belongs to. Null while unassigned. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /** The number itself, E.164 ("+15550101234"). */
  @Column({ type: "varchar" })
  e164!: string;

  /** Twilio's IncomingPhoneNumber sid (`PN…`). */
  @Column({ type: "varchar" })
  providerSid!: string;

  /** A Member's name for the number ("Support line"). Empty shows the number. */
  @Column({ type: "varchar", default: "" })
  label!: string;

  /** ISO 3166 country of the number, when Twilio said. */
  @Column({ type: "varchar", default: "" })
  country!: string;

  /** Where the number is from ("San Francisco, CA"), display only. */
  @Column({ type: "varchar", default: "" })
  locality!: string;

  @Column({ type: "boolean", default: true })
  voiceEnabled!: boolean;

  @Column({ type: "boolean", default: true })
  smsEnabled!: boolean;

  @Column({ type: "boolean", default: false })
  mmsEnabled!: boolean;

  /** What an incoming call does. See {@link PhoneCallMode}. */
  @Column({ type: "varchar", default: "answer" })
  callMode!: PhoneCallMode;

  /** Where `forward` calls ring, E.164. */
  @Column({ type: "varchar", nullable: true })
  forwardTo!: string | null;

  /** What an incoming text does. See {@link PhoneTextMode}. */
  @Column({ type: "varchar", default: "inbox" })
  textMode!: PhoneTextMode;

  /** The first sentence of an answered call. Empty uses the default greeting. */
  @Column({ type: "text", default: "" })
  greeting!: string;

  /**
   * What the AI Employee may say and do with people who call or text this
   * number — written by a Member, and the whole briefing a stranger's call or
   * text runs on.
   */
  @Column({ type: "text", default: "" })
  instructions!: string;

  /** Twilio `<Say>` voice, one of `PHONE_VOICES`. */
  @Column({ type: "varchar", default: "Polly.Joanna-Neural" })
  voice!: string;

  /** Outbound texts the AI Employee may send from this number per 24 hours. */
  @Column({ type: "integer", default: 50 })
  dailyTextLimit!: number;

  /** Outbound calls the AI Employee may place from this number per 24 hours. */
  @Column({ type: "integer", default: 10 })
  dailyCallLimit!: number;

  /**
   * The public URL the number's Twilio webhooks were last pointed at, or null
   * when they never were (no public URL yet). Compared with the current one so
   * the settings page can say when Twilio is still calling an old address.
   */
  @Column({ type: "varchar", nullable: true })
  webhookBaseUrl!: string | null;

  /** Why pointing the webhooks at Genosyn last failed; empty when it worked. */
  @Column({ type: "varchar", default: "" })
  webhookError!: string;

  /**
   * True when Genosyn bought the number, false when it was brought in from the
   * Twilio account. Only decides the default of "also release it from Twilio"
   * when the number is removed — a number someone already owned is not
   * released unless they ask.
   */
  @Column({ type: "boolean", default: true })
  reservedInGenosyn!: boolean;

  /** Last time inbound texts were fetched from Twilio rather than pushed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastTextSyncAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
