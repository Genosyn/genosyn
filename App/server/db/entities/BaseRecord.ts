import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A row in a BaseTable. Values are stored as one JSON blob keyed by field id
 * so new/removed fields don't require schema changes. Not the most efficient
 * shape for big datasets, but Genosyn bases are expected to stay O(1k) rows;
 * if that changes we can promote hot fields to real columns later.
 */
@Entity("base_records")
@Index(["tableId", "createdAt"])
export class BaseRecord {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  tableId!: string;

  @Column({ type: "text", default: "{}" })
  dataJson!: string;

  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
