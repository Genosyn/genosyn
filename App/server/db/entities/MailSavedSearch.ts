import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * One person's saved mail search, pinned as a chip above the thread list.
 *
 * The stored value is the raw search grammar (`in:inbox is:unread from:acme`),
 * not a parsed structure. Saving the source text means a chip and a typed query
 * are the same thing: there is one grammar, in `services/mail/searchQuery.ts`,
 * and no second filtering model that could drift away from it.
 *
 * Scoped to (company, user, account) and never shared — a saved search is a
 * personal shortcut, and sharing would raise questions about who may see whose
 * mailbox that the grant levels already answer elsewhere.
 */
@Entity("mail_saved_searches")
@Index(["userId", "accountId", "sortOrder"])
@Index(["companyId", "userId"])
export class MailSavedSearch {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Owner. Always a human Member — AI employees search through their tools. */
  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /** Raw search grammar, parsed by `parseMailQuery` like any typed query. */
  @Column({ type: "text" })
  query!: string;

  /** Float sort key so reordering chips is a single UPDATE. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
