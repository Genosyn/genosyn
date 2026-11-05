import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { SupportEventKind } from "../../../shared/support.js";

export type SupportActorKind = "user" | "ai" | "system" | "customer";

/**
 * One line on a ticket's timeline, beside its messages: what changed and who
 * changed it. Written by the server, never by a model.
 */
@Entity("support_events")
@Index(["ticketId", "createdAt", "id"])
@Index(["companyId", "kind", "createdAt"])
export class SupportEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  ticketId!: string;

  @Column({ type: "varchar" })
  kind!: SupportEventKind;

  @Column({ type: "varchar" })
  actorKind!: SupportActorKind;

  @Column({ type: "varchar", nullable: true })
  actorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorEmployeeId!: string | null;

  /** Kept as written, so a timeline outlives the person or employee it names. */
  @Column({ type: "varchar", default: "" })
  actorName!: string;

  @CreateDateColumn()
  createdAt!: Date;

  /** JSON details, shaped by `kind`: `{ from, to }`, `{ reason }`. */
  @Column({ type: "text", default: "{}" })
  dataJson!: string;
}
