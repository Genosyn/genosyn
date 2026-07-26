import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type RevenueAliasType =
  | "merged_record_id"
  | "source_id"
  | "name"
  | "email"
  | "domain"
  | "website"
  | "external_id";

/**
 * An identity the surviving Revenue record used to be known by.
 *
 * Merge aliases preserve source ids and human identifiers after the duplicate
 * row becomes an archived tombstone. Enrichment/import aliases use the same
 * lookup table, so duplicate detection and redirect resolution agree.
 */
@Entity("revenue_record_aliases")
@Index(["companyId", "resourceType", "normalizedValue"])
@Index(["companyId", "resourceType", "recordId"])
@Index(["operationId"])
export class RevenueRecordAlias {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  resourceType!: "account" | "contact" | "deal" | "partnership";

  /** Current canonical/surviving record id. */
  @Column({ type: "varchar" })
  recordId!: string;

  @Column({ type: "varchar" })
  aliasType!: RevenueAliasType;

  @Column({ type: "varchar" })
  value!: string;

  @Column({ type: "varchar" })
  normalizedValue!: string;

  /** Archived duplicate row that contributed this alias, when applicable. */
  @Column({ type: "varchar", nullable: true })
  sourceRecordId!: string | null;

  @Column({ type: "varchar", nullable: true })
  operationId!: string | null;

  @Column({ type: "varchar", default: "" })
  provenance!: string;

  @Column({ type: "boolean", default: false })
  verified!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
