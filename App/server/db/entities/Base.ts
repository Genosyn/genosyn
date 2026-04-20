import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A Base is an Airtable-style workspace owned by a Company. Each Base is a
 * collection of Tables (see BaseTable), and tables may reference each other
 * through Link fields. Bases are the companion to Projects + Todos: the task
 * manager tracks work, bases track the data the work operates on.
 */
@Entity("bases")
@Index(["companyId", "slug"], { unique: true })
export class Base {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** lucide-react icon name. UI falls back to "Database" when unknown. */
  @Column({ type: "varchar", default: "Database" })
  icon!: string;

  /** Tailwind-friendly accent color. One of indigo, emerald, amber, rose, sky, violet, slate. */
  @Column({ type: "varchar", default: "indigo" })
  color!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
