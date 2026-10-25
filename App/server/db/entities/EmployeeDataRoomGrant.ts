import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { DataRoomAccessLevel } from "../../../shared/dataRooms.js";

export {
  DATA_ROOM_ACCESS_LEVELS,
  DATA_ROOM_ACCESS_RANK,
  type DataRoomAccessLevel,
} from "../../../shared/dataRooms.js";

/**
 * What one AI Employee may do with the company's data rooms through its own
 * tools, set by owners and admins at **Data rooms → AI access**:
 *
 *   - `read`    → read rooms, their documents and activity, and guests'
 *                 questions.
 *   - `prepare` → also create rooms, add documents and draft answers for a
 *                 Member to publish. Nobody outside the company is contacted.
 *   - `share`   → also invite guests and publish answers, both of which reach
 *                 people outside the company.
 *
 * One row per employee, like the Recruiting and Signing grants. No row means
 * no data room tool works: a room holds the company's most sensitive
 * documents, so reading it is opt-in.
 *
 * This governs only the employee's own tools. The AI Employee appointed to a
 * room (`DataRoom.aiEmployeeId`) briefs its documents and drafts its answers
 * in restricted single-tool turns the server starts, and needs no Grant for
 * that: those turns read nothing but the room in front of them.
 */
@Entity("employee_data_room_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeDataRoomGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: DataRoomAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
