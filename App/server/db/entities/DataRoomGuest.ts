import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { DataRoomGuestStatus } from "../../../shared/dataRooms.js";
import { dateTimeColumnType } from "./columnTypes.js";

export type DataRoomInviteStatus = "none" | "sent" | "failed" | "skipped";

/**
 * One person outside the company invited to one data room. Their private link
 * is the only credential they hold: `tokenHash` finds them, and
 * `tokenEncrypted` lets an owner or admin copy the link again — the BaseForm
 * pattern. Reissuing the link replaces both, so the old link stops working.
 *
 * `folderIdsJson` narrows what they see: an empty list is every folder and the
 * room's top level; otherwise only the listed folders. Everything a guest does
 * in the room is a `DataRoomEvent`; the counters here are its running totals.
 */
@Entity("data_room_guests")
@Index(["roomId", "email"], { unique: true })
@Index(["tokenHash"], { unique: true })
@Index(["companyId"])
export class DataRoomGuest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /** Lower-cased. */
  @Column({ type: "varchar" })
  email!: string;

  /** The firm or company they are with, as a Member typed it. */
  @Column({ type: "varchar", default: "" })
  organization!: string;

  @Column({ type: "varchar", default: "active" })
  status!: DataRoomGuestStatus;

  @Column({ type: "text", default: "[]" })
  folderIdsJson!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  expiresAt!: Date | null;

  /** SHA-256 hex of the link's token. The token itself is never stored in the clear. */
  @Column({ type: "varchar" })
  tokenHash!: string;

  /** Recoverable only for an owner or admin copying the link. */
  @Column({ type: "text" })
  tokenEncrypted!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  termsAcceptedAt!: Date | null;

  /** The name the guest typed when accepting the room's terms. */
  @Column({ type: "varchar", default: "" })
  termsAcceptedName!: string;

  /** SHA-256 of the terms they accepted; new terms must be accepted again. */
  @Column({ type: "varchar", default: "" })
  termsSha256!: string;

  @Column({ type: "varchar", default: "" })
  termsAcceptedIp!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  firstViewedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastViewedAt!: Date | null;

  /** Separate visits: a visit starts after half an hour away. */
  @Column({ type: "int", default: 0 })
  visitCount!: number;

  /** Seconds spent with a document open. */
  @Column({ type: "int", default: 0 })
  totalSeconds!: number;

  @Column({ type: "varchar", default: "none" })
  inviteStatus!: DataRoomInviteStatus;

  @Column({ type: "text", default: "" })
  inviteError!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  inviteSentAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  invitedByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  invitedByEmployeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
