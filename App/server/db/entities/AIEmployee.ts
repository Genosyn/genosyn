import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("ai_employees")
@Index(["companyId", "slug"], { unique: true })
export class AIEmployee {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  role!: string;

  /**
   * The employee's constitution — what used to live in `SOUL.md` on disk.
   * The DB is now the source of truth; the chat / runner read this directly
   * when composing prompts, and the Soul editor round-trips through this
   * column via `/api/.../employees/:eid/soul`.
   */
  @Column({ type: "text", default: "" })
  soulBody!: string;

  /**
   * Basename of the avatar image file on disk (e.g. `<uuid>.png`). Null when
   * no avatar is set, in which case the UI falls back to initials. Files
   * live under `data/avatars/`, outside the employee cwd so a slug rename
   * doesn't move them.
   */
  @Column({ type: "varchar", nullable: true })
  avatarKey!: string | null;

  /**
   * Optional Team this employee belongs to (one team per employee for V1;
   * a join table can land later if cross-team members ever matter). Drives
   * the org chart, Handoff defaults, and team-scoped digests.
   */
  @Column({ type: "varchar", nullable: true })
  teamId!: string | null;

  /**
   * Optional reporting line — the employee this one reports to. Self-FK,
   * same-company constraint enforced in code. Used by `create_handoff`'s
   * `manager: true` shortcut and by future escalation rules.
   */
  @Column({ type: "varchar", nullable: true })
  reportsToEmployeeId!: string | null;

  /**
   * Optional human manager — the company member this employee reports to.
   * Mutually exclusive with `reportsToEmployeeId` (set at most one). Lets
   * the org chart weave humans into the hierarchy as managers without
   * needing a join across two tables in code that walks the tree.
   */
  @Column({ type: "varchar", nullable: true })
  reportsToUserId!: string | null;

  /**
   * Opt-in toggle for the built-in `browser` MCP server. When true, the MCP
   * materializer stamps a stdio binary into the provider's config that
   * drives a headless Chromium bundled in the App container. Default false
   * so a stock install never lets an employee navigate the open web until
   * the operator enables it explicitly.
   */
  @Column({ type: "boolean", default: false })
  browserEnabled!: boolean;

  /**
   * Newline-separated list of host globs the employee's browser is allowed
   * to navigate to (e.g. `*.gmail.com\nnotion.so`). Empty / null = no
   * restriction. Lines starting with `#` are treated as comments. Glob
   * matching is via simple `*` wildcards on the hostname only — schemes,
   * paths, and query strings are not part of the match. Enforced inside
   * the `browser_open` tool before navigation; ignored when
   * `browserEnabled` is off.
   */
  @Column({ type: "text", nullable: true })
  browserAllowedHosts!: string | null;

  /**
   * When true, the `browser_submit` tool queues an `Approval` row
   * (kind=`browser_action`) and returns a `pending_approval` status to the
   * model. The model must call `browser_resume(approvalId)` to re-fire the
   * submit once a human approves it from the Approvals inbox. Off by
   * default — the gate is opt-in because the latency hit is significant.
   */
  @Column({ type: "boolean", default: false })
  browserApprovalRequired!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
