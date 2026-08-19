import { z } from "zod";
import {
  assertSafeGitRemoteUrl,
  httpsCredentialScope,
  SAFE_GIT_REMOTE_URL_MESSAGE,
} from "./gitCredentialHelper.js";

export const HIDDEN_UNSAFE_GIT_REMOTE_URL = "[unsafe clone URL hidden]";

type RepositoryAuthMode = "none" | "https" | "ssh";

export function repositoryCredentialError(input: {
  authMode: RepositoryAuthMode;
  hasStoredToken: boolean;
  hasStoredSshKey: boolean;
  token?: string;
  sshKey?: string;
}): string | null {
  if (input.authMode === "https" && !input.hasStoredToken && !input.token) {
    return "HTTPS auth needs a token / password.";
  }
  if (input.authMode === "ssh" && !input.hasStoredSshKey && !input.sshKey) {
    return "SSH auth needs a private key.";
  }
  return null;
}

const httpsUsernameSchema = z
  .string()
  .max(200)
  .refine((value) => !/[\0\r\n]/.test(value), "Username must stay on one line.");

const tokenSchema = z
  .string()
  .max(20000)
  .refine((value) => !/[\0\r\n]/.test(value), "Token / password must stay on one line.");

export const repositoryGitUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, ctx) => {
    try {
      assertSafeGitRemoteUrl(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SAFE_GIT_REMOTE_URL_MESSAGE });
    }
  });

/**
 * A clone URL, or the empty string meaning "no remote".
 *
 * A local repository genuinely has no URL, and the form posts the field as an
 * empty string rather than omitting it. Accepting only `undefined` made
 * creating a local repository fail validation with no usable message, which is
 * the worst possible outcome for the one flow that is supposed to need no
 * setup at all.
 */
export const repositoryGitUrlOrEmptySchema = z.union([z.literal(""), repositoryGitUrlSchema]);

export function isPlainHttpsCredentialUrl(value: string): boolean {
  try {
    httpsCredentialScope(value);
    return true;
  } catch {
    return false;
  }
}

export function gitRemoteUrlForResponse(value: string): string {
  // A local repository has no remote, and "no URL" is not an unsafe URL —
  // reporting it as one would put a security warning on the ordinary state of
  // every repository created inside Genosyn.
  if (value === "") return "";
  try {
    assertSafeGitRemoteUrl(value);
    return value;
  } catch {
    return HIDDEN_UNSAFE_GIT_REMOTE_URL;
  }
}

/**
 * A branch name Git will accept, used for the trunk of a new repository.
 * Same rules the workspace applies to every other branch name.
 */
const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/,
    "Branch names may use letters, numbers, dot, dash, underscore, and slash.",
  )
  .refine((value) => !value.includes("..") && !value.endsWith("/") && !value.endsWith(".lock"), {
    message: "That branch name is not valid.",
  });

export const repositoryCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    /**
     * A local repository has no remote, so it has no clone URL. Everything
     * else on the row still applies — it is an ordinary git repository, just
     * one that lives only inside Genosyn until someone gives it a URL.
     */
    origin: z.enum(["remote", "local"]).optional(),
    kind: z.enum(["code", "documents"]).optional(),
    gitUrl: repositoryGitUrlOrEmptySchema.optional(),
    defaultBranch: branchNameSchema.optional(),
    description: z.string().max(2000).optional(),
    authMode: z.enum(["none", "https", "ssh"]),
    httpsUsername: httpsUsernameSchema.optional(),
    token: tokenSchema.optional(),
    sshKey: z.string().max(50000).optional(),
    committerName: z.string().max(200).optional(),
    committerEmail: z.string().email().max(320).optional().or(z.literal("")),
  })
  .refine((body) => (body.origin ?? "remote") === "local" || !!body.gitUrl, {
    message: "Enter the repository's clone URL, or create a local repository instead.",
    path: ["gitUrl"],
  })
  .refine((body) => (body.origin ?? "remote") !== "local" || body.authMode === "none", {
    message: "A local repository has no remote to authenticate to.",
    path: ["authMode"],
  })
  .refine((body) => body.authMode !== "https" || !!body.token, {
    message: "HTTPS auth needs a token / password.",
    path: ["token"],
  })
  .refine((body) => body.authMode !== "https" || isPlainHttpsCredentialUrl(body.gitUrl ?? ""), {
    message: "HTTPS auth needs a plain https:// clone URL without embedded credentials or options.",
    path: ["gitUrl"],
  })
  .refine((body) => body.authMode !== "ssh" || !!body.sshKey, {
    message: "SSH auth needs a private key.",
    path: ["sshKey"],
  });

export const repositoryPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(["code", "documents"]).optional(),
  /**
   * Giving a local repository a clone URL promotes it to `remote`; the route
   * does that rather than accepting `origin` directly, so the two fields
   * cannot be set to contradict each other.
   */
  gitUrl: repositoryGitUrlOrEmptySchema.optional(),
  defaultBranch: branchNameSchema.optional(),
  description: z.string().max(2000).optional(),
  authMode: z.enum(["none", "https", "ssh"]).optional(),
  httpsUsername: httpsUsernameSchema.optional(),
  /** New token/key. Empty string is ignored (leave existing in place). */
  token: tokenSchema.optional(),
  sshKey: z.string().max(50000).optional(),
  committerName: z.string().max(200).optional(),
  committerEmail: z.string().email().max(320).optional().or(z.literal("")),
});
