import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** A reusable, company-scoped label for organizing resources. */
@Entity("tags")
@Index(["companyId"])
@Index(["companyId", "normalizedName"], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /** Case-folded name used to keep one canonical tag per company. */
  @Column({ type: "varchar" })
  normalizedName!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
