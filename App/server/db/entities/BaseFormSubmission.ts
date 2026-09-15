import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Minimal lineage for a public Form response. Answers remain solely on the
 * BaseRecord; this row provides counts and retry-safe idempotency without
 * duplicating respondent data or retaining network identifiers.
 */
@Entity("base_form_submissions")
@Index(["formId", "clientSubmissionId"], { unique: true })
@Index(["recordId"], { unique: true })
@Index(["formId", "createdAt"])
export class BaseFormSubmission {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  formId!: string;

  @Column({ type: "varchar" })
  recordId!: string;

  /** Caller-generated UUID reused when a browser retries an uncertain POST. */
  @Column({ type: "varchar" })
  clientSubmissionId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
