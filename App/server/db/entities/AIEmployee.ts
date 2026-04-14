import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("ai_employees")
@Index(["companyId", "slug"], { unique: true })
export class AIEmployee {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  companyId!: string;

  @Column()
  name!: string;

  @Column()
  slug!: string;

  @Column()
  role!: string;

  @Column({ type: "varchar", nullable: true })
  defaultModelId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
