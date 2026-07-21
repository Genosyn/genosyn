import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * How Genosyn authenticates to a Code Repository when it clones / fetches /
 * pushes on an AI employee's behalf:
 *   - `none`  → public repo, no credentials (read-only in practice; an
 *               unauthenticated push will be rejected by the remote).
 *   - `https` → HTTPS clone URL with a username + token/password. Works for
 *               GitHub PATs, GitLab / Gitea tokens, Bitbucket app passwords,
 *               and any self-hosted git over HTTPS. The token is provided to
 *               git at spawn time via an env var and never lands on disk.
 *   - `ssh`   → SSH clone URL with a private key. The key is written to the
 *               employee's data dir (gitignored) and pinned via
 *               `core.sshCommand`; required for hosts that only allow SSH.
 */
export type CodeRepoAuthMode = "none" | "https" | "ssh";

/** Health of the last clone/fetch the runner attempted for this repo. */
export type CodeRepoSyncStatus = "unknown" | "ok" | "error";

/**
 * A Code Repository is any git repository the company adds so its AI
 * employees can read, edit, branch, commit, and push real code. Unlike the
 * GitHub-Connection-bound repos (M12), a Code Repository is provider-agnostic
 * — point it at any HTTPS or SSH clone URL (GitHub, GitLab, Bitbucket, a
 * self-hosted Gitea, …) and grant access to specific employees.
 *
 * Access is opt-in per employee through {@link EmployeeCodeRepositoryGrant}:
 * a human picks who can work on the repo and whether they may only read or
 * also push. Before each chat / routine spawn the runner materializes a real
 * git checkout of every granted repo into
 * `<employeeDir>/code-repos/<slug>/`, so the agent uses ordinary `git`.
 *
 * Credentials are encrypted at rest with the same AES-256-GCM helper used for
 * model API keys (`lib/secret.ts`). They are never returned to the client in
 * plaintext — the API surfaces only whether a credential is set.
 */
@Entity("code_repositories")
@Index(["companyId", "slug"], { unique: true })
export class CodeRepository {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** Clone URL — `https://…` or `git@…:owner/name.git` / `ssh://…`. */
  @Column({ type: "varchar" })
  gitUrl!: string;

  /** Branch the agent should treat as the trunk. */
  @Column({ type: "varchar", default: "main" })
  defaultBranch!: string;

  @Column({ type: "varchar", default: "none" })
  authMode!: CodeRepoAuthMode;

  /** HTTPS username for basic auth (e.g. "x-access-token", "git", or a real
   *  username). Stored in cleartext — it's not the secret half. */
  @Column({ type: "varchar", nullable: true })
  httpsUsername!: string | null;

  /** Encrypted HTTPS token / password (AES-256-GCM blob). Null when unset. */
  @Column({ type: "text", nullable: true })
  encryptedToken!: string | null;

  /** Encrypted SSH private key (PEM). Null when unset. */
  @Column({ type: "text", nullable: true })
  encryptedSshKey!: string | null;

  /** Git identity stamped on commits the agent makes. Falls back to the
   *  employee's name + a derived noreply email when null. */
  @Column({ type: "varchar", nullable: true })
  committerName!: string | null;

  @Column({ type: "varchar", nullable: true })
  committerEmail!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ type: "varchar", default: "unknown" })
  lastSyncStatus!: CodeRepoSyncStatus;

  @Column({ type: "text", default: "" })
  lastSyncError!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
