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

/**
 * What an AI Employee is allowed to run in a work session on this repository:
 *   - `off`       → no commands at all. The session is the six file-and-commit
 *                   tools and nothing else, which is what every session was
 *                   before commands existed.
 *   - `allowlist` → only commands matching {@link Repository.allowedCommands},
 *                   or Genosyn's built-in list while that field is empty.
 *   - `all`       → every command, with no pattern check. The sandbox and the
 *                   operator's execution mode still apply; this switch only
 *                   turns off Genosyn's own matching.
 *
 * None of the three can conjure command execution where the install has none:
 * `codingRuntimeAvailability()` is checked first, and on an install whose
 * sandbox could not start there is no shell to reach whatever this says.
 */
export type RepositoryCommandMode = "off" | "allowlist" | "all";

export const REPOSITORY_KINDS: RepositoryKind[] = ["code", "documents"];
export const REPOSITORY_ORIGINS: RepositoryOrigin[] = ["remote", "local"];
export const REPOSITORY_COMMAND_MODES: RepositoryCommandMode[] = ["off", "allowlist", "all"];

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

  /** What an AI Employee may run in a work session. See {@link RepositoryCommandMode}. */
  @Column({ type: "varchar", default: "allowlist" })
  commandMode!: RepositoryCommandMode;

  /**
   * One command pattern per line, matched against every segment of a command
   * an employee asks to run. Empty means "use Genosyn's built-in list", which
   * is what a repository nobody has configured gets — see
   * `services/repositoryCommandPolicy.ts`.
   */
  @Column({ type: "text", default: "" })
  allowedCommands!: string;

  /**
   * The GitHub Connection this repository publishes through, when it was
   * connected to GitHub from inside Genosyn rather than by pasting a URL.
   *
   * Only an id: the credential itself stays on the Connection and is resolved
   * per push. Pinning it matters once a company has more than one GitHub
   * account connected — without it the server would have to guess which one
   * should be pushing to the company's code, and guessing there is not
   * acceptable.
   */
  @Column({ type: "varchar", nullable: true })
  githubConnectionId!: string | null;

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
