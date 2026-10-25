import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type DataRoomTextStatus = "pending" | "extracted" | "none";

/**
 * One file in a data room. The bytes live under the company's data directory
 * (`services/dataRooms/storage.ts`), named by `storageKey`, and are never
 * changed after upload — `sha256` lets anyone check that. A guest's PDF is
 * watermarked on the way out; the stored file stays the original.
 *
 * `text` is what could be read out of the file, kept so the room's AI Employee
 * can brief the document and answer from it, and so the brief and the answers
 * can be checked against the words actually there. It is the last column and
 * never selected by default, so listing a room's documents never reads it.
 */
@Entity("data_room_documents")
@Index(["roomId", "folderId", "position"])
@Index(["companyId"])
export class DataRoomDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  /** Null is the room's top level. */
  @Column({ type: "varchar", nullable: true })
  folderId!: string | null;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "varchar", default: "application/octet-stream" })
  mimeType!: string;

  @Column({ type: "int", default: 0 })
  sizeBytes!: number;

  @Column({ type: "varchar" })
  storageKey!: string;

  /** Lowercase hexadecimal SHA-256 of the stored bytes. */
  @Column({ type: "varchar", default: "" })
  sha256!: string;

  @Column({ type: "int", default: 0 })
  position!: number;

  @Column({ type: "int", default: 0 })
  pageCount!: number;

  @Column({ type: "varchar", default: "pending" })
  textStatus!: DataRoomTextStatus;

  @Column({ type: "int", default: 0 })
  textChars!: number;

  /** The AI Employee's brief (`DataRoomDocumentBrief`), or null before one. */
  @Column({ type: "text", nullable: true })
  briefJson!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  briefAt!: Date | null;

  /** The Resource it was copied from, when it came from the library. */
  @Column({ type: "varchar", nullable: true })
  sourceResourceId!: string | null;

  @Column({ type: "varchar", nullable: true })
  uploadedByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  uploadedByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "text", default: "", select: false })
  text!: string;
}
