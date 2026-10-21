import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { RecruitingAccessLevel } from "../../../shared/recruiting.js";

export {
  RECRUITING_ACCESS_LEVELS,
  RECRUITING_ACCESS_RANK,
  type RecruitingAccessLevel,
} from "../../../shared/recruiting.js";

/**
 * What one AI Employee may do in Recruiting, set by owners and admins at
 * **Recruiting → AI access**:
 *
 *   - `read`   → see Openings, Applications, resumes and Scorecards.
 *   - `screen` → also score Applications, write notes, move them between
 *                Applied, Screening and Interview, and draft Openings.
 *   - `hire`   → also publish and close Openings and make offers, hires and
 *                rejections, including sending the company's rejection email.
 *
 * One row per employee, like the Revenue and Marketing grants: Recruiting is
 * one company-wide subsystem, not a set of individually shared rows. No row
 * means no Recruiting tool works at all — an applicant's resume is personal
 * data, so reading it is opt-in, never inherited from merely existing.
 *
 * This governs only the employee's own tools. The AI screener that scores each
 * new Application runs in a restricted, single-tool turn the server starts, on
 * the appointment an owner or admin made at Recruiting → Settings, and needs
 * no Grant: it can read nothing but the Application in front of it.
 */
@Entity("employee_recruiting_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeRecruitingGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: RecruitingAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
