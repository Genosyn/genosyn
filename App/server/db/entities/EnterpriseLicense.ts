import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

/**
 * The ISSUER's registry of Enterprise licenses (M56) — populated only on the
 * install that signs licenses (Genosyn's own cloud, Admin → Enterprise
 * Licenses). A customer's self-hosted install never stores one of these; it
 * stores the signed key string itself in `AppSetting` (`license.key`) and
 * verifies it offline against the embedded public keys.
 *
 * `id` is a plain (not generated) uuid because the same id is embedded in the
 * signed payload — the row and the key must agree on it. The full key is
 * shown ONCE at issuance; only `keyPreview` (`genlic1.abcd…wxyz`) survives
 * here, so a leaked database cannot mint working licenses.
 */
@Entity("enterprise_licenses")
export class EnterpriseLicense {
  @PrimaryColumn({ type: "varchar" })
  id!: string;

  @Column({ type: "varchar" })
  companyName!: string;

  @Column({ type: "varchar", nullable: true })
  email!: string | null;

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  /** Informational seat count baked into the payload; null = unlimited. */
  @Column({ type: "integer", nullable: true })
  seats!: number | null;

  /** Evaluation licenses expire HARD (features off past expiry); paid ones
   * expire SOFT (features stay on, the UI warns). */
  @Column({ type: "boolean", default: false })
  evaluation!: boolean;

  /** Masked display form of the issued key — never the full key. */
  @Column({ type: "varchar" })
  keyPreview!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
