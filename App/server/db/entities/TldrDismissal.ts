import { CreateDateColumn, Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** A Member-specific acknowledgement; dismissing never hides a TLDR from teammates. */
@Entity("tldr_dismissals")
@Index(["tldrId", "userId"], { unique: true })
@Index(["companyId", "userId"])
export class TldrDismissal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  tldrId!: string;

  @Column({ type: "varchar" })
  userId!: string;

  @CreateDateColumn()
  dismissedAt!: Date;
}
