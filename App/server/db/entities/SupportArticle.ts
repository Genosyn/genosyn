import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { SupportArticleStatus } from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One piece of what the company knows, written for answering customers.
 *
 * Published Articles are the only company knowledge an AI Employee reads when it
 * answers a ticket, and every reply it writes quotes them; a quote not found word
 * for word keeps the reply from going out on its own. So what an AI can tell a
 * customer is exactly what a person chose to publish here. A draft is read by
 * nobody but Members, including a draft an AI Employee wrote from a solved ticket.
 */
@Entity("support_articles")
@Index(["companyId", "status", "updatedAt", "id"])
// The help center's order: a deep page starts at its cursor, and a search stops
// as soon as a page is full instead of reading every Article's words first.
@Index(["companyId", "status", "title", "id"])
export class SupportArticle {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: SupportArticleStatus;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar", nullable: true })
  topicKey!: string | null;

  /** The solved ticket this was written from, when it was. */
  @Column({ type: "varchar", nullable: true })
  sourceTicketId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  /** How many replies have quoted it. Counted by the server. */
  @Column({ type: "int", default: 0 })
  citedCount!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastCitedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** Markdown. */
  @Column({ type: "text", default: "" })
  body!: string;
}
