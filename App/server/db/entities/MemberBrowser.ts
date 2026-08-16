import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type MemberBrowserStatus = "pending" | "online" | "offline" | "revoked";

/**
 * A Chrome that a Member has connected from their own computer, which an AI
 * Employee may drive instead of the App-owned headless Chromium.
 *
 * Deliberately **not** called a Connection: `AGENTS.md` reserves that word for
 * one authenticated account inside an Integration, and `IntegrationAuthMode`
 * already has a `"browser"` mode meaning "a Connection whose credentials the
 * headless browser replays". Two unrelated meanings on one word is exactly
 * what the vocabulary table exists to prevent, so this is a **Member browser** —
 * owned by a Member (`ownerUserId`), granted out to AI Employees through
 * {@link EmployeeMemberBrowserGrant}, the same shape every other resource uses.
 *
 * What actually runs on the Member's machine is the bridge agent
 * (`server/browser-bridge/agent.mjs`), which launches a **dedicated** Google
 * Chrome with its own `--user-data-dir` and a loopback-bound debugging port,
 * then relays CDP up to the App over an outbound WebSocket. It is not the
 * Member's everyday profile: since Chrome 136 the browser refuses remote
 * debugging on the default user-data-dir, and attaching Playwright to a
 * profile full of the human's own tabs would hand the model their private
 * pages, cookies, and dialogs. A separate profile is both the only thing
 * Chrome permits and the only thing safe to permit.
 *
 * Secrets follow the {@link ApiKey} precedent: the pairing code and the bridge
 * token are shown once and stored only as sha256 hashes.
 */
@Entity("member_browsers")
@Index(["companyId", "ownerUserId"])
@Index(["tokenHash"], { unique: true })
export class MemberBrowser {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  /**
   * The Member whose computer this is. Only they may select it for a chat,
   * watch its live view, or take over — independent of company role. An admin
   * being able to drive a colleague's signed-in browser would be a bigger
   * grant than any role in this product confers.
   */
  @Index()
  @Column({ type: "varchar" })
  ownerUserId!: string;

  /** Human-set label, e.g. "Chrome on my MacBook". */
  @Column({ type: "varchar" })
  name!: string;

  /**
   * `pending`  — created, waiting for the bridge agent to redeem the code
   * `online`   — bridge socket is connected right now
   * `offline`  — paired, but no bridge socket
   * `revoked`  — token burned; the row survives so audit trails stay intact
   */
  @Column({ type: "varchar", default: "pending" })
  status!: MemberBrowserStatus;

  /** sha256 hex of the one-time pairing code. Cleared once redeemed. */
  @Column({ type: "varchar", length: 64, nullable: true })
  pairingCodeHash!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  pairingCodeExpiresAt!: Date | null;

  /**
   * sha256 hex of the long-lived bridge bearer token. Unique so two minted
   * tokens can never collide, and hashed so a database read does not yield a
   * live channel into someone's browser.
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  tokenHash!: string | null;

  /** First 8 chars of the token's random suffix, for an identifying chip. */
  @Column({ type: "varchar", length: 16, nullable: true })
  tokenPrefix!: string | null;

  /**
   * Newline-separated host globs, same syntax as
   * `AIEmployee.browserAllowedHosts`. Composed with the employee's list: a URL
   * must pass **both**. Unlike the server browser, an empty effective list is
   * refused rather than treated as unrestricted — this browser sits on a
   * human's machine, so "no list" must not mean "anywhere".
   */
  @Column({ type: "text", nullable: true })
  allowedHosts!: string | null;

  /**
   * Force the human-in-the-loop gate on form submits regardless of the
   * employee's own setting. Defaults on: the pages reachable here are ones a
   * human deliberately signed into.
   */
  @Column({ type: "boolean", default: true })
  approvalRequired!: boolean;

  /**
   * Allow Routines to drive this browser. Off by default — a routine fires on
   * cron with nobody present, and a laptop that is asleep at 3am turns every
   * run into a failure the owner cannot see.
   */
  @Column({ type: "boolean", default: false })
  allowUnattended!: boolean;

  /** Reported by the bridge agent on connect. Display only. */
  @Column({ type: "varchar", nullable: true })
  browserVersion!: string | null;

  @Column({ type: "varchar", nullable: true })
  platform!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSeenAt!: Date | null;

  /** Soft revocation, like `ApiKey.revokedAt`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
