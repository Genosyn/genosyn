import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/** Issuer details saved on a document, independent of later profile edits. */
export type SubsidiaryIssuerSnapshot = {
  name: string;
  address: string;
  country: string;
  taxNumber: string;
  registrationNumber: string;
  email: string;
  phone: string;
  website: string;
  footer: string;
};

/** A legal entity a company can select when issuing invoices or estimates. */
@Entity("subsidiaries")
@Index(["companyId", "archived"])
export class Subsidiary implements SubsidiaryIssuerSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "text", default: "" })
  address!: string;

  @Column({ type: "varchar", default: "" })
  country!: string;

  @Column({ type: "varchar", default: "" })
  taxNumber!: string;

  @Column({ type: "varchar", default: "" })
  registrationNumber!: string;

  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  phone!: string;

  @Column({ type: "varchar", default: "" })
  website!: string;

  @Column({ type: "text", default: "" })
  footer!: string;

  @Column({ type: "boolean", default: false })
  archived!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
