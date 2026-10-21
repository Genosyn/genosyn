import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from "typeorm";
import type {
  CompensationPeriod,
  EmploymentType,
  OpeningStatus,
  OpeningVisibility,
  WorkplaceType,
} from "../../../shared/recruiting.js";
import { dateTimeColumnType } from "./columnTypes.js";

export type CriteriaSource = "member" | "employee" | "screener";

/** Postgres hands a bigint back as a string; every amount here fits a number exactly. */
const minorUnits: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

/**
 * One role the company is hiring for — employment or a contract — posted by a
 * Member or by an AI Employee with Recruiting access.
 *
 * An Opening is a draft until someone with the authority to speak for the
 * company publishes it; a published Opening is `open` and takes Applications
 * until it is closed or its `applyBy` date passes. Who can see it is
 * `visibility`, independent of whether the careers site lists it.
 *
 * Its criteria (`criteriaJson`) are the bar every Application is scored
 * against. They are company-authored and live in the screener's trusted
 * instructions; nothing an applicant writes reaches them. `criteriaSource`
 * says who wrote the current set, so a Member can tell AI-drafted criteria
 * they have not reviewed yet from their own.
 *
 * The text columns are last on purpose: SQLite stores a row's columns in
 * declaration order, and a query that filters on a column stored after a long
 * text column has to read past it (AGENTS.md §7).
 */
@Entity("recruiting_openings")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status", "updatedAt"])
export class RecruitingOpening {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Derived once from the first title; the careers-site URL never moves. */
  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: OpeningStatus;

  @Column({ type: "varchar", default: "public" })
  visibility!: OpeningVisibility;

  @Column({ type: "varchar", default: "full_time" })
  employmentType!: EmploymentType;

  @Column({ type: "varchar", default: "onsite" })
  workplace!: WorkplaceType;

  @Column({ type: "varchar", default: "" })
  department!: string;

  @Column({ type: "varchar", default: "" })
  location!: string;

  /**
   * Minor units (cents). Both null means the Opening publishes no rate. A
   * 64-bit column: a yearly salary in won or dong passes 2^31 minor units.
   */
  @Column({ type: "bigint", nullable: true, transformer: minorUnits })
  compensationMinMinor!: number | null;

  @Column({ type: "bigint", nullable: true, transformer: minorUnits })
  compensationMaxMinor!: number | null;

  @Column({ type: "varchar", default: "USD" })
  compensationCurrency!: string;

  @Column({ type: "varchar", default: "year" })
  compensationPeriod!: CompensationPeriod;

  /** How many people the Opening hopes to hire. */
  @Column({ type: "integer", default: 1 })
  headcount!: number;

  /** Applications close at this moment; null keeps the Opening open until closed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  applyBy!: Date | null;

  /** Overrides the company's screener for this Opening. Null uses the default. */
  @Column({ type: "varchar", nullable: true })
  screenerEmployeeId!: string | null;

  /** The Member who owns the hire. Notified of strong matches. */
  @Column({ type: "varchar", nullable: true })
  ownerUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @Column({ type: "varchar", default: "member" })
  criteriaSource!: CriteriaSource;

  @Column({ type: "varchar", nullable: true })
  criteriaByEmployeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  criteriaUpdatedAt!: Date | null;

  /** When it was first published; kept through closing and reopening. */
  @Column({ type: dateTimeColumnType, nullable: true })
  publishedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** One or two sentences for the careers-site listing and search results. */
  @Column({ type: "text", default: "" })
  summary!: string;

  /** `OpeningFormSettings`: which standard fields the form asks for. */
  @Column({ type: "text", default: "{}" })
  formJson!: string;

  /** Ordered `OpeningCriterion[]`. Parsed strictly at every seam. */
  @Column({ type: "text", default: "[]" })
  criteriaJson!: string;

  /** Ordered `OpeningQuestion[]` asked on the application form. */
  @Column({ type: "text", default: "[]" })
  questionsJson!: string;

  /** Markdown: the role, the team, what the work is. */
  @Column({ type: "text", default: "" })
  description!: string;
}
