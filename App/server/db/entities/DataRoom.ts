import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type {
  DataRoomAiAnswerMode,
  DataRoomPurpose,
  DataRoomStatus,
} from "../../../shared/dataRooms.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * A private, tracked set of documents the company shares with people outside
 * it — investors, a buyer, an auditor, a partner — each a {@link DataRoomGuest}
 * with a personal link. Owners and admins run rooms; Members never see them,
 * because a room often holds news the rest of the company has not heard yet.
 *
 * The room's AI Employee (`aiEmployeeId`) is an appointment, not a Grant: it
 * briefs each document, drafts answers to guests' questions and reviews the
 * room's readiness, each in a restricted single-tool turn the server starts
 * that reads nothing but this room. The AI Employee's own tools answer to
 * `EmployeeDataRoomGrant` instead.
 */
@Entity("data_rooms")
@Index(["companyId", "updatedAt"])
export class DataRoom {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "other" })
  purpose!: DataRoomPurpose;

  /** `closed` turns every guest link away; the room and its record stay. */
  @Column({ type: "varchar", default: "open" })
  status!: DataRoomStatus;

  /** For Members only: what the room is for, who it is with. */
  @Column({ type: "text", default: "" })
  description!: string;

  /** Shown to every guest at the top of the room. */
  @Column({ type: "text", default: "" })
  welcomeMessage!: string;

  @Column({ type: "boolean", default: false })
  allowDownloads!: boolean;

  /** Stamp the guest's email and the date across every PDF page they open. */
  @Column({ type: "boolean", default: true })
  watermark!: boolean;

  /** Guests must accept `termsText` (an NDA, say) before they see anything. */
  @Column({ type: "boolean", default: false })
  requireTerms!: boolean;

  @Column({ type: "text", default: "" })
  termsText!: string;

  /** The AI Employee appointed to work this room, if any. */
  @Column({ type: "varchar", nullable: true })
  aiEmployeeId!: string | null;

  @Column({ type: "varchar", default: "draft" })
  aiAnswerMode!: DataRoomAiAnswerMode;

  /** The latest readiness review (`DataRoomReadiness`), or null before one. */
  @Column({ type: "text", nullable: true })
  readinessJson!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  readinessAt!: Date | null;

  /** The latest reading of guest activity (`DataRoomInsights`). */
  @Column({ type: "text", nullable: true })
  insightsJson!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  insightsAt!: Date | null;

  /** When a guest last did anything in the room. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastGuestActivityAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  closedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
