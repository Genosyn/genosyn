import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A Support inbox's Chat widget: the web chat a company embeds on its own site.
 * Off until an owner or admin turns it on, and then only the sites named in
 * `allowedOriginsJson` can frame it. Tickets it opens belong to the inbox, so they
 * inherit its AI Employee, how far it goes and its daily limit.
 *
 * `publicKey` is the handle in the embed snippet. It is on the company's pages for
 * anyone to read, so it opens nothing by itself: a visitor's token is what reaches
 * a conversation. The company-wide limits live on `SupportSettings`.
 */
@Entity("support_chat_widgets")
@Index(["companyId"])
@Index(["inboxId"], { unique: true })
@Index(["publicKey"], { unique: true })
export class SupportChatWidget {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  inboxId!: string;

  @Column({ type: "varchar" })
  publicKey!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  /** Shown at the top of the widget. Empty uses the inbox's sender name, then the company's. */
  @Column({ type: "varchar", default: "" })
  title!: string;

  @Column({ type: "varchar", nullable: true })
  updatedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** The first thing a visitor reads. Empty is the default text. */
  @Column({ type: "text", default: "" })
  greeting!: string;

  /** JSON array of exact origins, such as `https://www.example.com`. */
  @Column({ type: "text", default: "[]" })
  allowedOriginsJson!: string;
}
