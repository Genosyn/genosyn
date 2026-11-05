import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A reply a Member writes once and inserts many times, with blanks such as
 * `{{customer.first_name}}` filled in as it goes into the composer. It only ever
 * fills the composer; a person still presses Send.
 */
@Entity("support_saved_replies")
@Index(["companyId", "name"])
export class SupportSavedReply {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int", default: 0 })
  usageCount!: number;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "text", default: "" })
  body!: string;
}
