import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Where a completed backup archive is delivered *in addition to* the local
 * `<dataDir>/Backup/` folder. Lets an operator mirror every backup off-box to
 * a NAS or remote volume so a lost disk doesn't take the backups with it.
 *
 *   - `local` → a filesystem path the host can already write to. Still the
 *               simplest way to reach a NAS when you can mount it: mount the
 *               SMB / NFS / iSCSI share (or bind-mount it into the Genosyn
 *               container) and point the destination at that path. We just
 *               copy the archive there — the kernel handles the protocol.
 *   - `sftp`  → push over SSH/SFTP to a remote host with no mount required.
 *               Covers appliance NASes (Synology / QNAP / TrueNAS) that expose
 *               SSH but are awkward to bind-mount into a container.
 *   - `smb`   → push straight to an SMB/CIFS share, no mount required. For
 *               operators who can't bind-mount (locked-down Kubernetes, no
 *               privileged mounts on the host) and whose NAS speaks SMB but
 *               not SSH. Delivered by shelling out to Samba's `smbclient`, so
 *               we get SMB3 + signing rather than a half-finished JS
 *               implementation of the protocol.
 *
 * Kind-specific settings — including the SFTP password / private key and the
 * SMB password — live inside {@link encryptedConfig}, an AES-256-GCM blob
 * keyed from `config.sessionSecret` (same helper as model API keys,
 * `lib/secret.ts`). The raw secret is never returned to the client; the
 * serializer surfaces only whether a credential is set. {@link hint} is a
 * plaintext, non-secret display string (e.g. `/mnt/nas`,
 * `backup@nas.local:/volume1/genosyn`, or `//nas.local/backups/genosyn`) so
 * the UI can still label a row even if the config can't be decrypted after a
 * secret rotation.
 */
export type BackupDestinationKind = "local" | "sftp" | "smb";

/** Health of the last delivery / test attempted for this destination. */
export type BackupDestinationStatus = "unknown" | "ok" | "error";

@Entity("backup_destinations")
@Index(["createdAt"])
export class BackupDestination {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Human-chosen label, e.g. "Office NAS" or "Offsite SFTP". */
  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "local" })
  kind!: BackupDestinationKind;

  /** When true, every completed backup is auto-mirrored here. */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** AES-256-GCM ciphertext of the kind-specific config + credentials JSON. */
  @Column({ type: "text" })
  encryptedConfig!: string;

  /** Non-secret, human-readable target (survives a decrypt failure). */
  @Column({ type: "varchar", default: "" })
  hint!: string;

  @Column({ type: "varchar", default: "unknown" })
  lastStatus!: BackupDestinationStatus;

  /** Last delivery / test error — empty when healthy. */
  @Column({ type: "text", default: "" })
  lastError!: string;

  /** When a backup was last successfully delivered here. */
  @Column({ type: "datetime", nullable: true })
  lastSyncedAt!: Date | null;

  /** When "Test connection" last ran (success or failure). */
  @Column({ type: "datetime", nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
