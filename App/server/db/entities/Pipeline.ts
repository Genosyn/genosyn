import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * A Pipeline is a company-scoped DAG of typed nodes — n8n-style automation.
 * Pipelines are a separate primitive from Routines: Routines are scheduled
 * AI-employee work, Pipelines are deterministic glue between Genosyn
 * primitives (channels, todos, bases, employees) and the outside world.
 *
 * The graph itself lives in `graphJson` as a single JSON document of the shape
 * `{ nodes: PipelineNode[], edges: PipelineEdge[] }`. The executor walks it in
 * topological order from the firing trigger node — see services/pipelines/.
 *
 * `cronExpr` / `nextRunAt` are derived from any Schedule trigger nodes inside
 * the graph, recomputed on every save so the heartbeat in services/cron.ts
 * can pick due rows up without parsing the graph each tick.
 */
@Entity("pipelines")
@Index(["companyId", "slug"], { unique: true })
export class Pipeline {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** Serialized `{ nodes, edges }` document. See PipelineGraph in services/pipelines/types.ts. */
  @Column({ type: "text", default: "{\"nodes\":[],\"edges\":[]}" })
  graphJson!: string;

  /**
   * Earliest cron expression among the pipeline's Schedule trigger nodes,
   * cached on the row so the heartbeat doesn't parse the graph each tick.
   * Null when the pipeline has no Schedule trigger.
   */
  @Column({ type: "varchar", nullable: true })
  cronExpr!: string | null;

  @Column({ type: "datetime", nullable: true })
  nextRunAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  lastRunAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
