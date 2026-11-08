import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * A Dashboard is a named grid of Chart cards — Metabase-style. The grid
 * itself lives on `DashboardCard`; the Dashboard row carries only the
 * identifying metadata, and its link.
 *
 * The link (`services/dashboardLinks.ts`) shows the Dashboard to anyone who
 * holds it, at `/dashboards/<token>`, made for a TV. The token is kept as a
 * hash for lookup and encrypted so owners and admins can copy it again; it
 * stays when the link is turned off, so turning it back on restores the same
 * URL, and only a reset replaces it.
 */
@Entity("dashboards")
@Index(["companyId", "slug"], { unique: true })
@Index(["linkTokenHash"], { unique: true })
export class Dashboard {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  /** SHA-256 hex of the link's token. Null until the Dashboard is first shared. */
  @Column({ type: "varchar", nullable: true })
  linkTokenHash!: string | null;

  /** The token itself, encrypted to the company, for an owner or admin copying the link. */
  @Column({ type: "text", nullable: true })
  linkTokenEncrypted!: string | null;

  /** When the link was turned on; null while it is off. */
  @Column({ type: dateTimeColumnType, nullable: true })
  linkEnabledAt!: Date | null;

  /**
   * The owner or admin who turned the link on or last reset it. The link shows
   * what they may see, and stops answering once they leave the company.
   */
  @Column({ type: "varchar", nullable: true })
  linkEnabledById!: string | null;

  /** How often a screen showing the link reloads its cards, in seconds. */
  @Column({ type: "int", default: 300 })
  linkRefreshSeconds!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
