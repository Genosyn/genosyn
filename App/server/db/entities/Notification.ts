import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * One row per "thing the recipient should know about" — mentions in
 * workspace chat, a Todo moving into review, an Approval waiting on a
 * human, and so on. Drives the bell + panel in the top bar.
 *
 * Source-of-truth for the unread badge: `readAt` is null for unread,
 * non-null once the user opens the panel or clicks through. Notifications
 * are append-only; we never mutate `title` / `body` after insert because
 * the linked entity (message, todo, …) might change shape later.
 *
 * `entityKind` + `entityId` exist so we can:
 *   - reason about clusters in the panel (group three mentions in one
 *     channel into a single row in the future)
 *   - clean up dangling notifications when their target is deleted
 *     (best-effort; not relied on for correctness).
 */
export type NotificationKind =
  | "mention"
  | "todo_review_requested"
  | "approval_pending";

export type NotificationActorKind = "user" | "ai" | "system";

export type NotificationEntityKind =
  | "channel_message"
  | "todo"
  | "approval";

@Entity("notifications")
@Index(["userId", "readAt"])
@Index(["userId", "createdAt"])
@Index(["companyId", "userId"])
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Recipient. Always a human Member — AI employees don't get notified. */
  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar" })
  kind!: NotificationKind;

  @Column({ type: "varchar" })
  title!: string;

  /** Short preview / sub-line. Falsy = nothing to show under the title. */
  @Column({ type: "text", default: "" })
  body!: string;

  /**
   * Click target, relative to the SPA root (e.g. `/c/acme/workspace/<id>`).
   * Null when the notification is informational only.
   */
  @Column({ type: "varchar", nullable: true })
  link!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorKind!: NotificationActorKind | null;

  /** UserId or AIEmployeeId of the actor that caused this. Null = system. */
  @Column({ type: "varchar", nullable: true })
  actorId!: string | null;

  @Column({ type: "varchar", nullable: true })
  entityKind!: NotificationEntityKind | null;

  @Column({ type: "varchar", nullable: true })
  entityId!: string | null;

  /** Null = unread. Set when the user opens / dismisses the row. */
  @Column({ type: "datetime", nullable: true })
  readAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
