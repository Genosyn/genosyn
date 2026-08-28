import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Who answers for the asking employee when a rule matches:
 *  - `manager`  — the asker's manager-employee via `AIEmployee.reportsToEmployeeId`.
 *  - `employee` — the named `deciderEmployeeId`.
 */
export type DecisionDeciderKind = "manager" | "employee";

/**
 * One row of the company's decision-rights matrix (M53). A rule says: when
 * this employee (or any employee) raises a Decision, this other AI Employee
 * may answer it instead of a human.
 *
 * The safety envelope is the Decision primitive itself, unchanged: answering
 * fires no side effect, and anything privileged the asker does with the
 * answer still meets its own Approval gates — which is why routing judgment
 * calls is defensible at all. What a rule never touches: Approvals (always
 * human), Decisions with a named human assignee (the employee explicitly
 * asked a person), and the fallback — a routed Decision that sits unanswered
 * past a short fuse, or that the decider declines, drops back into the human
 * flow with the bell it skipped.
 *
 * Human-only remains the default: a company with no enabled rules behaves
 * exactly as before M53.
 */
@Entity("decision_policies")
@Index(["companyId", "enabled"])
export class DecisionPolicy {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Match Decisions raised by this employee; null matches any employee. */
  @Column({ type: "varchar", nullable: true })
  askingEmployeeId!: string | null;

  @Column({ type: "varchar", default: "manager" })
  deciderKind!: DecisionDeciderKind;

  /** The named decider for `deciderKind: "employee"`; null for `manager`. */
  @Column({ type: "varchar", nullable: true })
  deciderEmployeeId!: string | null;

  /** First matching enabled rule wins, lowest `sortOrder` first. */
  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
