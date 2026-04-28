import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A saved view onto a BaseTable. Stores filters, sort order, and which fields
 * are hidden so users can switch between "All records", "My open items",
 * "Q1 launches", etc. without re-typing the rules each time.
 *
 * JSON shapes:
 *  - filtersJson: `Array<{ id, fieldId, operator, value? }>` joined with AND
 *  - sortsJson:   `Array<{ id, fieldId, direction: "asc"|"desc" }>` (first wins)
 *  - hiddenFieldsJson: `string[]` of field ids to hide in this view
 *
 * Filtering and sorting are applied client-side: records are loaded once per
 * table, and each view is just a different lens. No server query rewrite.
 */
@Entity("base_views")
@Index(["tableId", "sortOrder"])
@Index(["tableId", "slug"], { unique: true })
export class BaseView {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  tableId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Float sort key so reordering view tabs is one UPDATE. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @Column({ type: "text", default: "[]" })
  filtersJson!: string;

  @Column({ type: "text", default: "[]" })
  sortsJson!: string;

  @Column({ type: "text", default: "[]" })
  hiddenFieldsJson!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
