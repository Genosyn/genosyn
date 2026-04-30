import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type LearningSourceKind = "url" | "text" | "pdf" | "epub" | "video";
export type LearningStatus = "pending" | "ready" | "failed";

/**
 * A Learning is a piece of external material — an article, an ebook, a
 * paste, eventually a video transcript — that an AI employee can study
 * and search later. Distinct from:
 *   - `EmployeeMemory`: atomic durable facts, auto-injected into prompts.
 *   - `Note`: Notion-style page the team authors together.
 * Learnings are content the team did **not** write. They are ingested once,
 * stored verbatim as plain text in `bodyText`, and queried on demand
 * through the MCP surface (`list_learnings`, `search_learnings`,
 * `get_learning`). v1 retrieval is substring matching over title +
 * summary + body, same shape as `search_notes`.
 *
 * `bodyText` holds the extracted plain text (cap enforced at the route
 * layer at 1 MiB so a single rogue ebook can't blow the SQLite row).
 * Original uploads land on disk under
 * `data/companies/<co-slug>/learnings/<uuid>.<ext>`; the relative key
 * lives on `storageKey` so the file can be re-served if the human ever
 * wants the original back.
 */
@Entity("learnings")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
export class Learning {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar", default: "url" })
  sourceKind!: LearningSourceKind;

  /** Original URL when `sourceKind === "url"`. Null for paste/uploads. */
  @Column({ type: "varchar", nullable: true })
  sourceUrl!: string | null;

  /** Original filename for uploads (`.pdf`, `.epub`, …). Null for URL/paste. */
  @Column({ type: "varchar", nullable: true })
  sourceFilename!: string | null;

  /** Storage key relative to the per-company learnings dir; null when nothing
   *  is on disk (URLs and pastes don't keep a binary copy). */
  @Column({ type: "varchar", nullable: true })
  storageKey!: string | null;

  /** Short human-authored summary; AI-visible alongside the title. */
  @Column({ type: "text", default: "" })
  summary!: string;

  /** Extracted plain text — the full searchable body. Capped at 1 MiB. */
  @Column({ type: "text", default: "" })
  bodyText!: string;

  /** Comma-joined free-form tags so humans can group learnings. */
  @Column({ type: "varchar", default: "" })
  tags!: string;

  /** Bytes of the original asset (file size for uploads, body length for URL/text). */
  @Column({ type: "bigint", default: 0 })
  bytes!: number;

  @Column({ type: "varchar", default: "pending" })
  status!: LearningStatus;

  /** Set when ingestion fails so the UI can show *why* the body is empty. */
  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
