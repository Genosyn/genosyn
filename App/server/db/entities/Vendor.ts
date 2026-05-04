import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A Vendor is the inbound counterparty for `Bill`s — anyone who sends
 * the company an invoice they need to pay. Phase G of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Mirrors `Customer` exactly aside from the relational direction: AP
 * instead of AR. Sharing the schema shape lets the UI reuse most of
 * the customer page styling (intentional copy-paste, not a shared
 * component — the two will drift soon enough).
 */
@Entity("vendors")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "archivedAt"])
export class Vendor {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  phone!: string;

  @Column({ type: "text", default: "" })
  address!: string;

  @Column({ type: "varchar", default: "" })
  taxNumber!: string;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
