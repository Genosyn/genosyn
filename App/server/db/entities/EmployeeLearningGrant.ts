import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { NoteAccessLevel } from "./EmployeeNoteGrant.js";

/**
 * Grants an AI employee access to a Learning. We reuse the
 * `NoteAccessLevel` (`read` | `write`) so the share UI doesn't need a
 * second vocabulary, even though the AI surface is read-only today —
 * `write` exists so a future curation tool (re-summarize, re-tag) has a
 * permission to gate on.
 *
 * Humans (members) bypass this table; it only governs what AI employees
 * see through their MCP surface.
 */
@Entity("employee_learning_grants")
@Index(["employeeId"])
@Index(["learningId"])
@Index(["employeeId", "learningId"], { unique: true })
export class EmployeeLearningGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  learningId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: NoteAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
