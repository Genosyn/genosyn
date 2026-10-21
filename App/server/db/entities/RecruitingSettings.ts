import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { SiteVisibility } from "../../../shared/recruiting.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One company's Recruiting setup: its careers site, the AI screener, and the
 * emails applicants receive. A company without a row has not set Recruiting
 * up; `services/recruiting/settings.ts` reads the defaults in that case and
 * creates the row on the first save.
 *
 * The careers site lives at `<public URL>/careers/<company slug>` once it is
 * switched on, and optionally on a custom domain the company points at this
 * install (`careers.example.com`). A custom domain is served only after its
 * DNS TXT record proves the company controls it — see
 * `services/recruiting/domains.ts` — and only ever serves the careers site:
 * the App's own pages and API stay on the install's public URL.
 */
@Entity("recruiting_settings")
@Index(["companyId"], { unique: true })
@Index(["customDomain"], { unique: true })
export class RecruitingSettings {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Off until a Member publishes the site; Openings can be drafted before. */
  @Column({ type: "boolean", default: false })
  siteEnabled!: boolean;

  /**
   * `public` anyone may read; `internal` only signed-in Members of the company
   * may, on the install's own address. An internal site is never served on a
   * custom domain, where nobody is signed in.
   */
  @Column({ type: "varchar", default: "public" })
  siteVisibility!: SiteVisibility;

  /** Shown as the site's name. Empty falls back to the company's name. */
  @Column({ type: "varchar", default: "" })
  siteTitle!: string;

  @Column({ type: "varchar", default: "" })
  siteHeadline!: string;

  /** The company's own website, linked from the site's header. */
  @Column({ type: "varchar", default: "" })
  websiteUrl!: string;

  /** Linked beside the consent checkbox on every application form. */
  @Column({ type: "varchar", default: "" })
  privacyPolicyUrl!: string;

  @Column({ type: "varchar", default: "#4f46e5" })
  accentColor!: string;

  /** Basename of the uploaded logo under the company's recruiting directory. */
  @Column({ type: "varchar", nullable: true })
  logoKey!: string | null;

  /** False adds `noindex` everywhere on the site, for a company not ready to be found. */
  @Column({ type: "boolean", default: true })
  allowIndexing!: boolean;

  /** Lower-case host name, without scheme or port: `careers.example.com`. */
  @Column({ type: "varchar", nullable: true })
  customDomain!: string | null;

  /** The value the company publishes in its `_genosyn-careers` TXT record. */
  @Column({ type: "varchar", nullable: true })
  customDomainToken!: string | null;

  /** Set when the TXT record was found; cleared when the domain changes. */
  @Column({ type: dateTimeColumnType, nullable: true })
  customDomainVerifiedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  customDomainCheckedAt!: Date | null;

  /**
   * The AI Employee that scores every new Application, unless an Opening names
   * its own. Appointed by owners and admins only; no tool can change it.
   */
  @Column({ type: "varchar", nullable: true })
  screenerEmployeeId!: string | null;

  /** Score each Application as it arrives. Off, scoring waits for a person to ask. */
  @Column({ type: "boolean", default: true })
  autoScreen!: boolean;

  @Column({ type: "boolean", default: true })
  confirmationEmailEnabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** Why the last domain check failed, in a sentence a person can act on. */
  @Column({ type: "text", default: "" })
  customDomainError!: string;

  /** Markdown under the headline: who the company is and why to join. */
  @Column({ type: "text", default: "" })
  siteIntro!: string;

  /**
   * The company's own hiring principles, which every screening reads. Null
   * follows the default in `shared/recruiting.ts`; an empty string is a
   * deliberate "none". The fairness rule is built into the prompt either way.
   */
  @Column({ type: "text", nullable: true })
  screeningInstructions!: string | null;

  /** Null follows the default template in `shared/recruiting.ts`. */
  @Column({ type: "text", nullable: true })
  confirmationEmailSubject!: string | null;

  @Column({ type: "text", nullable: true })
  confirmationEmailBody!: string | null;

  @Column({ type: "text", nullable: true })
  rejectionEmailSubject!: string | null;

  @Column({ type: "text", nullable: true })
  rejectionEmailBody!: string | null;
}
