import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Per-employee access to a Chart. Two levels:
 *   - `read`  → list / get / run only
 *   - `write` → read + create / update / delete
 *
 * The order matches `CHART_ACCESS_RANK` below so `hasChartAccess` can
 * compare with a single integer test instead of a switch.
 *
 * Charts default to `read` for every employee in the company at create
 * time (see {@link grantChartToAllEmployees}). The author of an AI-
 * created Chart auto-receives `write`. Humans bypass this table entirely
 * — it only governs the MCP surface.
 */
export type ChartAccessLevel = "read" | "write";

export const CHART_ACCESS_LEVELS: ChartAccessLevel[] = ["read", "write"];

export const CHART_ACCESS_RANK: Record<ChartAccessLevel, number> = {
  read: 0,
  write: 1,
};

@Entity("employee_chart_grants")
@Index(["employeeId"])
@Index(["chartId"])
@Index(["employeeId", "chartId"], { unique: true })
export class EmployeeChartGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  chartId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: ChartAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
