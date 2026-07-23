import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One person on the buying committee for one Deal. See ROADMAP.md M32.
 *
 * `Deal.primaryContactId` covers the common case of a single champion; this
 * table exists because B2B SaaS deals above a trivial size involve a champion,
 * an economic buyer, a security reviewer and a procurement contact, and losing
 * track of who is who is how deals stall.
 *
 * `role` is free text rather than an enum on purpose — every company names
 * these differently, and a wrong enum forces people into the nearest wrong box.
 */
@Entity("deal_contacts")
@Index(["dealId"])
@Index(["contactId"])
@Index(["dealId", "contactId"], { unique: true })
export class DealContact {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Denormalized for tenant-scoped sweeps without joining through Deal. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  dealId!: string;

  @Column({ type: "varchar" })
  contactId!: string;

  /** "Champion", "Economic buyer", "Security", … */
  @Column({ type: "varchar", default: "" })
  role!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
