import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("companies")
export class Company {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", unique: true })
  slug!: string;

  @Column({ type: "varchar" })
  ownerId!: string;

  /**
   * The durable company purpose used to ground AI Employee onboarding and
   * future company-wide recommendations. Empty keeps existing companies fully
   * valid until a Member adds the profile from onboarding or Settings.
   */
  @Column({ type: "text", default: "" })
  mission!: string;

  /** The future state the company is working toward. See {@link mission}. */
  @Column({ type: "text", default: "" })
  vision!: string;

  /** When enabled, browser members must keep at least one 2FA method enrolled. */
  @Column({ type: "boolean", default: false })
  requireTwoFactor!: boolean;

  /** Automatically assign ready Proactive starters unless an admin switches this off. */
  @Column({ type: "boolean", default: true })
  proactiveAutoSetup!: boolean;

  /**
   * System-owned initialization and assignment tombstones, encoded as
   * { version: 1, assignments: Record<string, string> }. Starter instructions
   * remain on their native MailRule and Routine rows; this records which
   * responsibilities have already been assigned so customization, pauses,
   * and deletions are not overwritten by later automatic setup.
   */
  @Column({ type: "text", default: "" })
  proactiveDefaultsJson!: string;

  /**
   * Whether AI Employees may raise new Decisions. On by default. Turning it
   * off hides and refuses `request_decision`; Decisions already waiting stay
   * answerable, and Approvals, email reviews and work reviews are untouched —
   * those are system gates, not Decisions. See `services/decisionStackSettings.ts`.
   */
  @Column({ type: "boolean", default: true })
  decisionStackEnabled!: boolean;

  /**
   * The Decision stack's instructions, written by an owner or admin: every
   * new Decision is checked against them before it is stacked. Null follows
   * the current default text in `shared/decisionStackInstructions.ts`; an
   * empty string is a deliberate "no instructions".
   */
  @Column({ type: "text", nullable: true })
  decisionStackInstructions!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
