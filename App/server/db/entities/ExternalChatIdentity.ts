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
 * One person on an external chat surface, and the Genosyn {@link User} they
 * proved they are.
 *
 * External chat (Slack, Microsoft Teams, WhatsApp, Telegram) reaches
 * `chatWithEmployee` with no browser session, so without this row the turn
 * runs under `toolAuthority: "untrusted"` — no Soul, no Skills, no Goals, no
 * company tools (see `resolveInteractiveChatContextAccess` in
 * `services/chat.ts`). That is the correct posture for a stranger who found
 * a public bot, and the wrong one for a colleague in the company Slack. This
 * row is the difference: once `userId` is set, the surface passes
 * `requesterUserId` and the turn gets exactly the web product's authority —
 * the Member's own access intersected with the employee's Grants.
 *
 * **Binding is never inferred from a platform-supplied email.** A Slack
 * Connect guest belongs to somebody else's workspace, and their email is
 * verified by that workspace, not by this company; auto-matching on it would
 * be a privilege-escalation path into the company's tools. Instead the bot
 * replies to an unknown sender with a one-time link, the human opens it in a
 * browser where they are already signed in to Genosyn, and the click is the
 * proof. `linkTokenHash` holds the sha256 of that single-use token and
 * `linkExpiresAt` bounds it.
 *
 * A row exists from the *first sighting* of an external user, with `userId`
 * null, so a pending sender is visible and a link can be re-minted without
 * losing the label. Unbinding clears `userId` rather than deleting the row.
 *
 * Revocation: the binding is a long-lived credential like an API key, not a
 * browser session, so bumping `User.sessionVersion` does not revoke it —
 * unbinding does, and so does losing the {@link Membership}, which the
 * inbound path re-checks on every turn.
 */
export type ExternalChatBindMethod = "link";

@Entity("external_chat_identities")
@Index(["companyId"])
@Index(["userId"])
@Index(["connectionId", "externalUserId"], { unique: true })
export class ExternalChatIdentity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Provider id of the owning Connection — "slack", "microsoft-teams", … */
  @Column({ type: "varchar" })
  provider!: string;

  /** The {@link IntegrationConnection} this sighting came through. Two bots
   * in the same workspace are two separate bindings on purpose. */
  @Column({ type: "varchar" })
  connectionId!: string;

  /** Upstream user id — Slack `U…`, Teams `aadObjectId`, WhatsApp phone
   * number, Telegram numeric user id. Opaque to everything but its adapter. */
  @Column({ type: "varchar" })
  externalUserId!: string;

  /** Best-effort display name for the pending/bound list. Never trusted for
   * authorization — only `userId` is. */
  @Column({ type: "varchar", nullable: true })
  externalUserLabel!: string | null;

  /** The proven Genosyn Member. NULL means seen but unbound: the surface
   * keeps answering that sender under untrusted authority. */
  @Column({ type: "varchar", nullable: true })
  userId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  boundAt!: Date | null;

  /**
   * The Member's auth epoch (`User.sessionVersion`) at the moment they proved
   * themselves, re-checked on every turn.
   *
   * Without it, "sign out everywhere" and a password reset — the two things a
   * person reaches for when they think they have been compromised — would
   * leave this standing authority untouched, because it is not a browser
   * session and nothing else would notice. Storing the epoch makes the
   * existing check in `chat.ts` mean something instead of comparing a live
   * read against itself. The cost is that a password reset asks each linked
   * Member for one more click, which is the correct thing for that gesture to
   * cost.
   */
  @Column({ type: "integer", nullable: true })
  boundSessionVersion!: number | null;

  /** How the binding was proven. Only the one-time link exists today; the
   * column is here so a future admin-asserted bind is distinguishable in an
   * audit rather than indistinguishable from a human's own click. */
  @Column({ type: "varchar", nullable: true })
  boundVia!: ExternalChatBindMethod | null;

  /** sha256 of the outstanding single-use bind token. Cleared on use. */
  @Column({ type: "varchar", nullable: true })
  linkTokenHash!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  linkExpiresAt!: Date | null;

  /** Last inbound message from this sender — drives the pending list's
   * ordering and lets an operator see a bot nobody is talking to. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
