import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * What reaching a stage means for the Deal sitting in it.
 *
 * - `open` — still in play.
 * - `won`  — terminal, counts as revenue.
 * - `lost` — terminal, does not.
 *
 * The kind is the single source of truth for `Deal.status`: moving a Deal into
 * a stage rewrites its status to match (see `services/revenue/dealStage.ts`).
 * Storing both is denormalization, but every board query filters on status and
 * every report groups by it, so deriving it per row is not worth the joins.
 */
export type DealStageKind = "open" | "won" | "lost";

export const DEAL_STAGE_KINDS: DealStageKind[] = ["open", "won", "lost"];

/**
 * One step in the company's sales process. See ROADMAP.md M32.
 *
 * **Naming.** This is deliberately not called a "pipeline stage": `Pipeline` is
 * already the DAG automation primitive (M10) and reusing the word for two
 * unrelated concepts is exactly the drift AGENTS.md's vocabulary table exists
 * to prevent. Product copy says "deal stages" or "the board"; "pipeline"
 * survives only as prose in metric names like "pipeline coverage".
 *
 * There is no container entity — stages are a flat, ordered, company-scoped
 * list, because a company has one sales process until it very much does not.
 * Adding a second process later is one nullable `processId` column and a
 * migration; adding it now is a join on every board query for nobody.
 *
 * A default ladder is seeded on first visit, matching how the finance chart of
 * accounts seeds itself (`services/finance.ts`).
 */
@Entity("deal_stages")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "sortOrder"])
@Index(["companyId", "archivedAt"])
export class DealStage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /**
   * Default close likelihood, 0-100. A Deal may override it per-row; this is
   * the fallback that makes weighted pipeline value work before anybody has
   * touched a single deal.
   */
  @Column({ type: "int", default: 0 })
  probability!: number;

  @Column({ type: "varchar", default: "open" })
  kind!: DealStageKind;

  /** Hex chip colour for the board column header. Empty = pick from the palette. */
  @Column({ type: "varchar", default: "" })
  color!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /**
   * Soft-delete. Archived stages stay resolvable for deals that closed in them
   * (a historical win must not lose its stage name) but disappear from the
   * board and from the move-to picker.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
