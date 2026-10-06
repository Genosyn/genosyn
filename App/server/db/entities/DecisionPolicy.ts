import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Who answers for the asking employee when a rule matches:
 *  - `employee` — the named `deciderEmployeeId`. The only kind a rule can be
 *    created or edited to.
 *  - `manager`  — retired with the org chart. It meant "the asker's manager",
 *    read from a reporting line that no longer exists. A rule saved before
 *    that keeps its row and its place in the order, and still matches: it
 *    leaves the question with people, never routes it, and never lets a later
 *    rule route it instead. Deleting it, or renaming it to a decider, is an
 *    admin's choice — a rule that quietly vanished could hand a question to
 *    an AI decider nobody picked for it.
 */
export type DecisionDeciderKind = "employee" | "manager";

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

  @Column({ type: "varchar", default: "employee" })
  deciderKind!: DecisionDeciderKind;

  /** The named decider for `deciderKind: "employee"`; null on a retired `manager` rule. */
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
