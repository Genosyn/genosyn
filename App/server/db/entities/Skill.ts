import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("skills")
@Index(["employeeId", "slug"], { unique: true })
export class Skill {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /**
   * Markdown playbook — what used to live at `skills/<slug>/README.md` on
   * disk. Round-trips through `/api/.../skills/:sid/readme` and is folded
   * into the employee's prompt by chat / runner.
   */
  @Column({ type: "text", default: "" })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
