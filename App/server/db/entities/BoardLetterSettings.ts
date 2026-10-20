import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Who writes a company's monthly letter to the board, and who audits it.
 *
 * Both are people's choices and nobody else's: the owners and admins who hold
 * the board's powers in Genosyn today pick the AI Employee that writes the
 * letter and appoint the one that audits it. No MCP tool reads or writes this
 * row, so the company's AI Employees can neither choose their own auditor nor
 * replace it — "an auditor the company cannot appoint". The auditor is never
 * the writer.
 *
 * `enabledAt` bounds what is owed automatically: the scheduler writes a
 * letter for every month that ends after letters were switched on, and
 * nothing earlier. `nextLetterAt` is the durable scheduler cursor, in the
 * same shape as `TldrSettings.nextRunAt`.
 */
@Entity("board_letter_settings")
@Index(["companyId"], { unique: true })
@Index(["enabled", "nextLetterAt"])
export class BoardLetterSettings {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  /** When letters were last switched on. Months that ended earlier are not owed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  enabledAt!: Date | null;

  /** The AI Employee who writes and signs the letter. */
  @Column({ type: "varchar", nullable: true })
  writerEmployeeId!: string | null;

  /** The AI Employee the board appointed to audit each letter. Never the writer. */
  @Column({ type: "varchar", nullable: true })
  auditorEmployeeId!: string | null;

  /** The Member who appointed the current auditor. */
  @Column({ type: "varchar", nullable: true })
  auditorAppointedByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  auditorAppointedAt!: Date | null;

  /** When the scheduler should next look for a letter that is owed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextLetterAt!: Date | null;

  /** Latest reason a letter could not be written, for the settings page. */
  @Column({ type: "text", default: "" })
  lastError!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
