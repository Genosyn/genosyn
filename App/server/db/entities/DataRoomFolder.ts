import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * One entry in a data room's index. Flat and ordered: a room's folders are
 * numbered by `position` (1, 2, 3 …) the way a diligence index is, and every
 * document sits in exactly one folder or at the room's top level. A guest's
 * access can be narrowed to some folders (`DataRoomGuest.folderIdsJson`).
 */
@Entity("data_room_folders")
@Index(["roomId", "position"])
@Index(["companyId"])
export class DataRoomFolder {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int", default: 0 })
  position!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
