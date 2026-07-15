import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A Project is a container for Todos, scoped to a Company. See ROADMAP.md
 * V1 backlog "Task manager" — this is the *Projects + Todos* feature that
 * AGENTS.md reserves the word "Tasks" for in product copy.
 *
 * Both the list and the board are views of the same Project, so access is
 * settled here once rather than per-view.
 */

/**
 * Who can reach a Project:
 *   - `open`       → every Member and every AI employee in the company has
 *                    `write`. No {@link ProjectMember} rows exist. This is
 *                    the default and the pre-existing behavior.
 *   - `restricted` → {@link ProjectMember} rows are the only source of truth.
 *                    No row means no access.
 */
export type ProjectAccessMode = "open" | "restricted";

@Entity("projects")
@Index(["companyId", "slug"], { unique: true })
export class Project {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Short one-line summary shown in the project list. */
  @Column({ type: "text", default: "" })
  description!: string;

  /** Short uppercase identifier (e.g. "ENG") used to prefix todo numbers ("ENG-42"). */
  @Column({ type: "varchar" })
  key!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  /** Monotonically incremented per project; used to mint the next Todo number. */
  @Column({ type: "int", default: 0 })
  todoCounter!: number;

  /**
   * The `default` is load-bearing: it is what makes this feature a no-op for
   * every project that existed before it shipped. Do not drop it.
   */
  @Column({ type: "varchar", default: "open" })
  accessMode!: ProjectAccessMode;

  @CreateDateColumn()
  createdAt!: Date;
}
