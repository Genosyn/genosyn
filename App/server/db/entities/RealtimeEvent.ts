import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/** Short-lived Postgres fan-out record referenced by a compact NOTIFY payload. */
@Entity("realtime_events")
@Index(["expiresAt"])
export class RealtimeEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  originId!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "text" })
  eventJson!: string;

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
