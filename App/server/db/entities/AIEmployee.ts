import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("ai_employees")
@Index(["companyId", "slug"], { unique: true })
export class AIEmployee {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  role!: string;

  /**
   * The employee's constitution — what used to live in `SOUL.md` on disk.
   * The DB is now the source of truth; the chat / runner read this directly
   * when composing prompts, and the Soul editor round-trips through this
   * column via `/api/.../employees/:eid/soul`.
   */
  @Column({ type: "text", default: "" })
  soulBody!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
