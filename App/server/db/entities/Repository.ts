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
 * How Genosyn authenticates to a Repository when it clones / fetches /
 * pushes on an AI employee's behalf:
 *   - `none`  → no credential stored on this row. Public repos clone
 *               anonymously; an HTTPS GitHub repo may reuse a matching
 *               GitHub Connection granted to the same employee at run time.
 *   - `https` → HTTPS clone URL with a username + token/password. Works for
 *               GitHub PATs, GitLab / Gitea tokens, Bitbucket app passwords,
 *               and any self-hosted git over HTTPS. The token is provided to
 *               git at spawn time via an env var and never lands on disk.
 *   - `ssh`   → SSH clone URL with a private key. The key is written to the
 *               employee's data dir (gitignored) and pinned via
 *               `core.sshCommand`; required for hosts that only allow SSH.
 */
export type RepositoryAuthMode = "none" | "https" | "ssh";

/** Health of the last clone/fetch the runner attempted for this repo. */
export type RepositorySyncStatus = "unknown" | "ok" | "error";

/**
 * Where the repository's history actually lives:
 *   - `remote` → a clone of `gitUrl` on some git host. Genosyn fetches it and
 *                can publish back to it.
 *   - `local`  → created empty with `git init` inside Genosyn and never
 *                pushed anywhere. This is the mode that makes Repositories
 *                useful for things that are not code — a versioned strategy
 *                doc, a policy set, a runbook — where the point is the
 *                history and the review, not a hosting provider. A local
 *                repository can be given a `gitUrl` later, which promotes it
 *                to `remote`.
 */
export type RepositoryOrigin = "remote" | "local";

/**
 * What the repository mostly holds. This is a hint, not a restriction: every
 * repository is a plain git repository and any file may live in any of them.
 * It changes the empty states, whether the editor opens rendered or raw, and
 * how an AI Employee is briefed — "run the tests before you commit" is good
 * advice in a service repo and noise in a folder of strategy memos.
 */
export type RepositoryKind = "code" | "documents";

export const REPOSITORY_KINDS: RepositoryKind[] = ["code", "documents"];
export const REPOSITORY_ORIGINS: RepositoryOrigin[] = ["remote", "local"];

/**
 * A Repository is a version-controlled workspace the company owns — a real
 * git repository, whether it holds a service's source code, a quarter's
 * strategy, or a set of operating policies.
 *
 * Two things can live in one:
 *   - a clone of any HTTPS or SSH git URL (GitHub, GitLab, Bitbucket, a
 *     self-hosted Gitea, …), provider-agnostic, unlike the
 *     GitHub-Connection-bound repos of M12; or
 *   - a repository created empty inside Genosyn, with no remote at all.
 *
 * Members work on it from the web UI — browse the tree, edit files, review a
 * diff, commit, push — against a server-owned checkout under
 * `.private/repositories/`. AI Employees work on it from their own isolated
 * checkout at `<employeeDir>/repositories/<slug>/`, materialized before each
 * chat / routine spawn, and their branches reach the remote only through a
 * Member-reviewed publish.
 *
 * Access for employees is opt-in per employee through
 * {@link EmployeeRepositoryGrant}: a human picks who can work on the repo and
 * whether they may only read or also prepare deliverables.
 *
 * Credentials are encrypted at rest with the same AES-256-GCM helper used for
 * model API keys (`lib/secret.ts`). They are never returned to the client in
 * plaintext — the API surfaces only whether a credential is set — and they
 * never enter an employee checkout.
 */
// The physical table keeps its original name. Renaming it would mean either a
// generated migration that drops and recreates the table (losing every row) or
// a hand-written one, and AGENTS.md §7 forbids hand-writing migrations. The
// product noun is what matters, and that is "Repository" everywhere else.
@Entity("code_repositories")
@Index(["companyId", "slug"], { unique: true })
export class Repository {
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

  /**
   * Clone URL — `https://…` or `git@…:owner/name.git` / `ssh://…`. Empty
   * exactly when {@link origin} is `local`.
   */
  @Column({ type: "varchar" })
  gitUrl!: string;

  @Column({ type: "varchar", default: "remote" })
  origin!: RepositoryOrigin;

  @Column({ type: "varchar", default: "code" })
  kind!: RepositoryKind;

  /** Branch the agent should treat as the trunk. */
  @Column({ type: "varchar", default: "main" })
  defaultBranch!: string;

  @Column({ type: "varchar", default: "none" })
  authMode!: RepositoryAuthMode;

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
  lastSyncStatus!: RepositorySyncStatus;

  @Column({ type: "text", default: "" })
  lastSyncError!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
