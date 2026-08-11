import { z } from "zod";
import {
  assertSafeGitRemoteUrl,
  httpsCredentialScope,
  SAFE_GIT_REMOTE_URL_MESSAGE,
} from "./gitCredentialHelper.js";

export const HIDDEN_UNSAFE_GIT_REMOTE_URL = "[unsafe clone URL hidden]";

type CodeRepositoryAuthMode = "none" | "https" | "ssh";

export function codeRepositoryCredentialError(input: {
  authMode: CodeRepositoryAuthMode;
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

export const codeRepositoryGitUrlSchema = z
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

export function isPlainHttpsCredentialUrl(value: string): boolean {
  try {
    httpsCredentialScope(value);
    return true;
  } catch {
    return false;
  }
}

export function gitRemoteUrlForResponse(value: string): string {
  try {
    assertSafeGitRemoteUrl(value);
    return value;
  } catch {
    return HIDDEN_UNSAFE_GIT_REMOTE_URL;
  }
}

export const codeRepositoryCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    gitUrl: codeRepositoryGitUrlSchema,
    defaultBranch: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    authMode: z.enum(["none", "https", "ssh"]),
    httpsUsername: httpsUsernameSchema.optional(),
    token: tokenSchema.optional(),
    sshKey: z.string().max(50000).optional(),
    committerName: z.string().max(200).optional(),
    committerEmail: z.string().email().max(320).optional().or(z.literal("")),
  })
  .refine((body) => body.authMode !== "https" || !!body.token, {
    message: "HTTPS auth needs a token / password.",
    path: ["token"],
  })
  .refine((body) => body.authMode !== "https" || isPlainHttpsCredentialUrl(body.gitUrl), {
    message: "HTTPS auth needs a plain https:// clone URL without embedded credentials or options.",
    path: ["gitUrl"],
  })
  .refine((body) => body.authMode !== "ssh" || !!body.sshKey, {
    message: "SSH auth needs a private key.",
    path: ["sshKey"],
  });

export const codeRepositoryPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  gitUrl: codeRepositoryGitUrlSchema.optional(),
  defaultBranch: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  authMode: z.enum(["none", "https", "ssh"]).optional(),
  httpsUsername: httpsUsernameSchema.optional(),
  /** New token/key. Empty string is ignored (leave existing in place). */
  token: tokenSchema.optional(),
  sshKey: z.string().max(50000).optional(),
  committerName: z.string().max(200).optional(),
  committerEmail: z.string().email().max(320).optional().or(z.literal("")),
});
