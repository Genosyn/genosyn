import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A table inside a Base. Holds rows (BaseRecord) shaped by fields (BaseField).
 * Called `BaseTable` (entity) / table `base_tables` to avoid clashing with the
 * reserved word "table" in SQL.
 */
@Entity("base_tables")
@Index(["baseId", "slug"], { unique: true })
export class BaseTable {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  baseId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Float sort key so reordering tabs is a single UPDATE. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
