import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Built-in visualization kinds for a saved Chart. Implemented as inline SVG
 * in `client/components/charts/` so Explore does not depend on a chart
 * library. New kinds get added here, the renderer dispatch in
 * `ChartRenderer.tsx`, and a side-panel config form in `ChartEdit.tsx`.
 *
 *  - `table`  — raw rows with column headers
 *  - `scalar` — single big number (first cell of the first row)
 *  - `bar`    — bars over a categorical dimension; multiple measures supported
 *  - `line`   — line(s) over an ordered dimension (usually date/time)
 *  - `area`   — same as line, filled
 *  - `pie`    — slices over a categorical dimension; single measure
 */
export type ChartVizType = "table" | "scalar" | "bar" | "line" | "area" | "pie";

/**
 * A saved query + visualization config. It reads one of two sources, and
 * exactly one of `connectionId` / `baseId` is set:
 *
 *  - **SQL** over an `IntegrationConnection` of provider `postgres` / `mysql`
 *    / `clickhouse`, re-using the connection's encrypted credentials so an
 *    Explore Chart needs no separate auth.
 *  - **A Base** — one of the company's own Bases, asked a structured question
 *    (`baseQueryJson`, a `BaseChartQuery` from `shared/baseChartQuery.ts`) that
 *    the server answers in the same rows-and-columns shape.
 *
 * `vizConfig` is a typed JSON blob whose shape varies by `vizType`. Keep
 * it on a `text` column (not a JSON column) so the SQLite and Postgres
 * drivers stay in lockstep; we parse it on the way out.
 *
 *   bar / line / area : { dimension: string; measures: string[]; stacked?: boolean }
 *   pie               : { dimension: string; measure: string }
 *   scalar            : { measure?: string; prefix?: string; suffix?: string }
 *   table             : { columns?: string[] }   // optional column allowlist
 *
 * Authoring bookkeeping mirrors `Resource` / `Note`: a Chart is either
 * authored by a human (`createdById`) or by an AI employee
 * (`createdByEmployeeId`), never both.
 */
@Entity("charts")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "connectionId"])
@Index(["companyId", "baseId"])
export class Chart {
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

  /** FK to `IntegrationConnection` for a SQL chart; null for a chart over a
   * Base. We don't define an explicit relation because the connection lives
   * on a different lifecycle and deletes cascade-by-hand at the route layer
   * when needed. */
  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  /** The SQL the chart runs. Parameter substitution is reserved for a
   * later phase; today this is verbatim SQL with no `$1` placeholders.
   * Empty for a chart over a Base. */
  @Column({ type: "text", default: "" })
  sql!: string;

  /** FK to `Base` for a chart over one of the company's own Bases; null for
   * a SQL chart. Like `connectionId`, no relation: a chart whose Base was
   * deleted stays, and says so when it runs. */
  @Column({ type: "varchar", nullable: true })
  baseId!: string | null;

  /** JSON-encoded `BaseChartQuery` when `baseId` is set, null otherwise. */
  @Column({ type: "text", nullable: true })
  baseQueryJson!: string | null;

  @Column({ type: "varchar", default: "table" })
  vizType!: ChartVizType;

  /** JSON-encoded viz config blob — see top-of-file for the shape per
   * `vizType`. Stored as text so SQLite + Postgres behave identically. */
  @Column({ type: "text", default: "{}" })
  vizConfig!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
