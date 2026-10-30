import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { DataRoomQuestionStatus } from "../../../shared/dataRooms.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One guest's question in a data room. A stranger wrote `body`: it is data
 * wherever it travels — bounded JSON in the user turn of the restricted answer
 * turn, a taint source for an AI Employee's tools — and never an instruction.
 *
 * Two answers can sit on a question. The draft (`draft*`) is the room's AI
 * Employee's, or one an AI Employee wrote through its tools, waiting for a
 * Member. The answer (`answer`, `citationsJson`) is what the guest sees, set
 * when a Member publishes — or when the room answers on its own
 * (`aiAnswerMode: "auto"`) because the guest's own documents answered it and
 * every quote checked out. Only the guest who asked ever sees either.
 */
@Entity("data_room_questions")
// A room's questions newest first, with a status or without: the pages of
// `list_data_room_questions` (keyset on createdAt, id).
@Index(["roomId", "status", "createdAt", "id"])
@Index(["roomId", "createdAt", "id"])
@Index(["guestId", "createdAt"])
@Index(["companyId"])
export class DataRoomQuestion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  @Column({ type: "varchar" })
  guestId!: string;

  /** The document the guest was reading when they asked, if any. */
  @Column({ type: "varchar", nullable: true })
  documentId!: string | null;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "varchar", default: "open" })
  status!: DataRoomQuestionStatus;

  @Column({ type: "text", default: "" })
  answer!: string;

  /** `DataRoomCitation[]` the guest sees under the answer. */
  @Column({ type: "text", default: "[]" })
  citationsJson!: string;

  @Column({ type: "varchar", nullable: true })
  answeredByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  answeredByEmployeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  answeredAt!: Date | null;

  @Column({ type: "text", default: "" })
  draftAnswer!: string;

  @Column({ type: "text", default: "[]" })
  draftCitationsJson!: string;

  /** Why the draft was not published on its own, or what it could not find. */
  @Column({ type: "text", default: "" })
  draftNote!: string;

  @Column({ type: "varchar", nullable: true })
  draftByEmployeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  draftAt!: Date | null;

  /** The question tried to instruct the AI Employee answering it. */
  @Column({ type: "boolean", default: false })
  injectionFlag!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
