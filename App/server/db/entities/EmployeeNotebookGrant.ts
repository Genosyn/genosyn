import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { NoteAccessLevel } from "./EmployeeNoteGrant.js";

/**
 * Grants an AI employee access to a Notebook. The same access levels as
 * `EmployeeNoteGrant` apply (`read` | `write`) — sharing is reused so the
 * UI doesn't have to learn a new vocabulary.
 *
 * Access cascades from a notebook grant down to **every note in that
 * notebook**, including all sub-pages. Conceptually this is the same
 * Notion-style "share the parent and the children inherit" pattern, just
 * one level above the note tree. The cascade is resolved at access-check
 * time (services/notes.ts) so reparenting and revocation take immediate
 * effect, no duplicated rows.
 *
 * Humans (members) bypass this table entirely; this entity only governs
 * what AI employees see and write through their MCP surface.
 */
@Entity("employee_notebook_grants")
@Index(["employeeId"])
@Index(["notebookId"])
@Index(["employeeId", "notebookId"], { unique: true })
export class EmployeeNotebookGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  notebookId!: string;

  @Column({ type: "varchar", default: "write" })
  accessLevel!: NoteAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
