import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * One Chart placed on a Dashboard. Coordinates are on a 12-column grid
 * (CSS grid-friendly): `x` is 0–11, `w` is 1–12, `y` and `h` are unbounded
 * positive ints. The renderer pins cards in row-major order if two cards
 * happen to claim the same cell.
 *
 * `titleOverride` lets a dashboard relabel the card without renaming the
 * underlying Chart (so a "Daily signups" chart can appear as "New users
 * this week" on one board and "Signup velocity" on another).
 */
@Entity("dashboard_cards")
@Index(["dashboardId"])
@Index(["chartId"])
export class DashboardCard {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  dashboardId!: string;

  @Column({ type: "varchar" })
  chartId!: string;

  @Column({ type: "int", default: 0 })
  x!: number;

  @Column({ type: "int", default: 0 })
  y!: number;

  @Column({ type: "int", default: 4 })
  w!: number;

  @Column({ type: "int", default: 3 })
  h!: number;

  @Column({ type: "varchar", default: "" })
  titleOverride!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
