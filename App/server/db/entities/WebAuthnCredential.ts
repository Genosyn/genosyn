import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type WebAuthnCredentialKind = "passkey" | "security_key";

/**
 * One FIDO2 credential enrolled by a human Member. WebAuthn covers both
 * synced/platform passkeys and roaming USB security keys such as YubiKey.
 * The public key is safe to store; the private key never leaves the
 * authenticator. `counter` is advanced after every successful assertion to
 * let the verifier detect cloned/replayed credentials where supported.
 */
@Entity("webauthn_credentials")
@Index(["userId"])
export class WebAuthnCredential {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  userId!: string;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 1024 })
  credentialId!: string;

  /** COSE-encoded public key, persisted as base64url. */
  @Column({ type: "text" })
  publicKey!: string;

  @Column({ type: "integer", default: 0 })
  counter!: number;

  /** JSON array of WebAuthn transport hints (usb, nfc, internal, …). */
  @Column({ type: "text", nullable: true })
  transports!: string | null;

  @Column({ type: "varchar" })
  kind!: WebAuthnCredentialKind;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar" })
  deviceType!: "singleDevice" | "multiDevice";

  @Column({ type: "boolean", default: false })
  backedUp!: boolean;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
