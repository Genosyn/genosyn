import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One company AI Model attached to one AI Employee.
 *
 * AI Models belong to the company (`AIModel.companyId`): one set of
 * credentials, one pool of API keys and their health, which any number of AI
 * Employees can run on. This row is what puts a model on an employee. An
 * employee may have several attached and keeps exactly one of them active — the brain its
 * Routines and non-interactive work use; employee Chat may pick another
 * attached model per turn. Detaching deletes this row and never the model.
 *
 * `isActive` invariant: at most one row per employee is `true`.
 * `services/models.ts` maintains it on every attach, switch and detach, and
 * reads fall back to the most recently attached row when none is flagged.
 *
 * `companyId` repeats the company the model and the employee both belong to,
 * so a company's attachments are one indexed read and a row can never join a
 * model to an employee of another company unnoticed.
 */
@Entity("employee_models")
@Index(["employeeId", "modelId"], { unique: true })
@Index(["modelId"])
@Index(["companyId"])
export class EmployeeModel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  modelId!: string;

  /** The employee's active AI Model. At most one row per employee is true. */
  @Column({ type: "boolean", default: false })
  isActive!: boolean;

  /** When the model was attached to this employee. */
  @CreateDateColumn()
  createdAt!: Date;
}
