import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Note access levels:
 *  - `read`: can list/search/get the note via MCP. Cannot edit or delete.
 *  - `write`: read + create children, update body/title/icon, archive,
 *    or delete.
 */
export type NoteAccessLevel = "read" | "write";

/**
 * Grants an AI employee access to a Note. Many-to-many between `AIEmployee`
 * and `Note`, unique on (employeeId, noteId) so a duplicate grant updates
 * the existing row's level rather than producing two entries.
 *
 * Access cascades down the note tree: a grant on a parent implicitly
 * authorizes every descendant. The cascade is resolved at access-check
 * time (services/notes.ts → findEffectiveGrant) rather than copied onto
 * children, so reparenting and revocation behave like Notion's share
 * model — change one ancestor and every descendant follows.
 *
 * Humans (members) bypass this table entirely; this entity only governs
 * what AI employees can see and write through their MCP surface.
 */
@Entity("employee_note_grants")
@Index(["employeeId"])
@Index(["noteId"])
@Index(["employeeId", "noteId"], { unique: true })
export class EmployeeNoteGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  noteId!: string;

  @Column({ type: "varchar", default: "write" })
  accessLevel!: NoteAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
