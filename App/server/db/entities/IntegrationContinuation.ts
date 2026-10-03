import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * A long continuation value an Integration tool issued, kept here so the AI
 * Employee carries only a short reference to it. A GitHub activity cursor
 * holds up to 300 event IDs, a couple of thousand characters, and the model
 * must copy it exactly on every call: on 2026-10-03 a self-hosted model got
 * one character wrong after a dozen pages and lost its whole scan.
 */
@Entity("integration_continuations")
@Index(["createdAt"])
export class IntegrationContinuation {
  /** The reference the caller holds; derived from `token`. */
  @PrimaryColumn({ type: "varchar" })
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  connectionId!: string;

  @Column({ type: "text" })
  token!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
