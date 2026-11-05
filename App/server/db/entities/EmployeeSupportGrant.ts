import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { SupportAccessLevel } from "../../../shared/support.js";

export {
  SUPPORT_ACCESS_LEVELS,
  SUPPORT_ACCESS_RANK,
  type SupportAccessLevel,
} from "../../../shared/support.js";

/**
 * What one AI Employee may do with Support through its own tools, set by owners
 * and admins at **Support → AI access**:
 *
 *   - `read`    → read tickets and Articles.
 *   - `prepare` → also add notes, update tickets, draft replies for a Member to
 *                 send and draft Articles. Nobody outside the company hears from it.
 *   - `reply`   → also send replies to customers and publish Articles.
 *
 * One row per employee; no row means no Support tool works. A ticket holds what
 * a stranger wrote, so reading one is opt-in and marks the turn as having read
 * outside content.
 *
 * This governs only the employee's own tools. The AI Employee appointed to work
 * Support (`SupportSettings.aiEmployeeId`, `SupportInbox.aiEmployeeId`) triages
 * and drafts in restricted single-tool turns the server starts, and needs no
 * Grant for that: those turns read nothing but the ticket and the published
 * Articles.
 */
@Entity("employee_support_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeSupportGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: SupportAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
