import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * An emoji reaction on a {@link ChannelMessage}. One row per (message, emoji,
 * actor). `emoji` is stored as a unicode cluster (`"👍"`, `"🎉"`) — keeping it
 * out of shortcode-land (`":thumbsup:"`) lets the UI render it directly
 * without a mapping table.
 */
@Entity("message_reactions")
@Index(["messageId", "emoji", "userId"], {
  unique: true,
  where: "userId IS NOT NULL",
})
@Index(["messageId", "emoji", "employeeId"], {
  unique: true,
  where: "employeeId IS NOT NULL",
})
export class MessageReaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  messageId!: string;

  @Column({ type: "varchar" })
  emoji!: string;

  @Column({ type: "varchar", nullable: true })
  userId!: string | null;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
