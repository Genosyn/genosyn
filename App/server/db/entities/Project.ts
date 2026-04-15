import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A Project is a container for Todos, scoped to a Company. See ROADMAP.md
 * V1 backlog "Task manager" — this is the *Projects + Todos* feature that
 * AGENTS.md reserves the word "Tasks" for in product copy.
 */
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

  @CreateDateColumn()
  createdAt!: Date;
}
