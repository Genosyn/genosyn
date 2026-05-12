import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { ChartAccessLevel } from "./EmployeeChartGrant.js";

/**
 * Per-employee access to a Dashboard. Mirrors `EmployeeChartGrant`:
 *   - `read`  → list / get only
 *   - `write` → read + rename / add card / remove card / delete
 *
 * Dashboards default to `read` for every employee at create time;
 * authors of AI-created dashboards get `write`. Humans bypass this
 * table.
 *
 * Note: granting a Dashboard does NOT cascade access to the Charts on
 * it. An employee needs `read` on each underlying Chart for its data to
 * render through the MCP surface. Without that we'd accidentally leak
 * data the human meant to scope tighter (e.g. a finance Chart pinned to
 * a public board).
 */
export type DashboardAccessLevel = ChartAccessLevel;

@Entity("employee_dashboard_grants")
@Index(["employeeId"])
@Index(["dashboardId"])
@Index(["employeeId", "dashboardId"], { unique: true })
export class EmployeeDashboardGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  dashboardId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: DashboardAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
