import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Two capabilities, because a calendar has exactly two interesting halves:
 *   - `read`   → see the agenda, the meetings, and their transcripts
 *   - `record` → read + start the notetaker on a call
 *
 * There is deliberately no `write` level here. Creating and moving events is
 * already the `calendar_*` tool family on the Google Connection, gated by
 * `EmployeeConnectionGrant`; adding a second path to the same Google API from
 * a different grant table would mean two answers to "may this employee move
 * that meeting", which is how a permission bug gets shipped.
 */
export type CalendarAccessLevel = "read" | "record";

export const CALENDAR_ACCESS_LEVELS: CalendarAccessLevel[] = ["read", "record"];

export const CALENDAR_ACCESS_RANK: Record<CalendarAccessLevel, number> = {
  read: 0,
  record: 1,
};

/**
 * Grants an AI Employee access to a {@link CalendarAccount}. Members bypass
 * this table entirely; it only governs the AI surface.
 */
@Entity("employee_calendar_grants")
@Index(["employeeId"])
@Index(["accountId"])
@Index(["employeeId", "accountId"], { unique: true })
export class EmployeeCalendarGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: CalendarAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
