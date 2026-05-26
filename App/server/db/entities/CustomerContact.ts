import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Additional contact (person) at a Customer account.
 *
 * A Customer is the *account* (the company you bill); each Contact is a
 * *person* at that account — typically AP clerk, project lead, owner.
 * The Customer's own `email` / `phone` columns remain the billing record
 * (the address invoices and estimates default to). Contacts are
 * supplementary and do not replace those — they let users record many
 * humans against one billable account.
 *
 * `isPrimary` is a soft hint for UI ("which contact to list first"); the
 * send-invoice flow still uses `Customer.email` so toggling primary does
 * not silently re-route email. `companyId` is denormalized for
 * fast list queries scoped to a tenant without joining through Customer.
 */
@Entity("customer_contacts")
@Index(["companyId", "customerId"])
@Index(["customerId", "sortOrder"])
export class CustomerContact {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  phone!: string;

  /** Optional job title / department — useful for distinguishing "Maria
   *  in AP" from "Maria in Engineering" without forcing the user to
   *  cram that detail into the name field. */
  @Column({ type: "varchar", default: "" })
  role!: string;

  @Column({ type: "boolean", default: false })
  isPrimary!: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
