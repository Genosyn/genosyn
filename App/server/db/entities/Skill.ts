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

  /**
   * Optional JSON `string[]` of model-facing tool names this playbook uses.
   *
   * When set, those tools are loaded up-front for any turn where this Skill is
   * in the prompt, so the model never pays a `find_tools` round-trip for a
   * capability its own playbook already named. Not a permission — Grants are
   * still checked at call time.
   *
   * Denormalized text rather than a relation, matching `McpServer.guardedToolsJson`:
   * it is a short list read on every prompt compose and never queried across.
   * Nullable so "never configured" stays distinguishable from "deliberately empty".
   */
  @Column({ type: "text", nullable: true })
  toolsetJson!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
