import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Durable, short "memory items" for one AI employee. Unlike the Soul (a
 * free-form markdown doc edited as one blob), memory items are small,
 * addressable facts a human or the AI can add/edit/remove independently.
 *
 * Every memory item is injected into every chat turn and every routine run
 * prompt inside a dedicated `## Memory` section. This is how the employee
 * "remembers" facts across conversations without re-reading the whole Soul.
 *
 * Keep the surface area small on purpose:
 *   - `title`: a short phrase, shown as the list header ("Prefers ARR over MRR")
 *   - `body`: optional extra detail, markdown ok (but stay brief)
 *   - `authorUserId`: humans that wrote it; null if the AI added it itself
 *
 * Revoking memory = delete the row. There is no edit history.
 */
@Entity("employee_memory_items")
@Index(["employeeId"])
export class EmployeeMemory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  /** User who created the item. Null when the AI added it via MCP. */
  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
