import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type DataRoomEventKind =
  | "room_opened"
  | "terms_accepted"
  | "document_viewed"
  | "document_downloaded"
  | "question_asked";

/**
 * One thing a guest did in a data room: a visit, accepting the terms, opening
 * or downloading a document, asking a question. Written only by the guest's
 * own requests, so a room's activity is what its guests did and nothing a
 * Member or an AI Employee narrated.
 *
 * A `document_viewed` row grows while the guest keeps the document open: their
 * page reports the time in small, capped steps (`seconds`). What Members did to
 * a room is its History in the audit log instead.
 */
@Entity("data_room_events")
@Index(["roomId", "createdAt"])
@Index(["guestId", "createdAt"])
@Index(["documentId"])
export class DataRoomEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  @Column({ type: "varchar" })
  guestId!: string;

  @Column({ type: "varchar", nullable: true })
  documentId!: string | null;

  @Column({ type: "varchar" })
  kind!: DataRoomEventKind;

  @Column({ type: "int", default: 0 })
  seconds!: number;

  @Column({ type: "varchar", default: "" })
  ipAddress!: string;

  @Column({ type: "varchar", default: "" })
  userAgent!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
