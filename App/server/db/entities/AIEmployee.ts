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

  @Column({ type: "varchar", nullable: true })
  defaultModelId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
