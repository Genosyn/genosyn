import type { AdminCompanyRow, AdminUserRow } from "./api";
import { PASSWORD_MIN_LENGTH } from "../../shared/password";

/** How the new account gets its first password. */
export type AddUserSignIn = "link" | "password";

export type AddUserDraft = {
  name: string;
  email: string;
  signIn: AddUserSignIn;
  password: string;
  /** "" for an account in no company yet. */
  companyId: string;
  role: "member" | "admin";
};

export type AddUserResponse = {
  user: AdminUserRow;
  setupLink: string | null;
  emailStatus: "sent" | "skipped" | "failed";
};

/**
 * A fresh form. The one company on a single-company install is chosen for
 * the admin, since that is nearly always where a new person belongs.
 */
export function emptyAddUserDraft(companies: Pick<AdminCompanyRow, "id">[]): AddUserDraft {
  return {
    name: "",
    email: "",
    signIn: "link",
    password: "",
    companyId: companies.length === 1 ? companies[0].id : "",
    role: "member",
  };
}

/** The first thing stopping the form from being sent, or null when it can go. */
export function addUserProblem(draft: AddUserDraft): string | null {
  if (!draft.name.trim()) return "Enter their name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    return "Enter a valid email address.";
  }
  if (draft.signIn === "password" && draft.password.length < PASSWORD_MIN_LENGTH) {
    return `The password needs at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

/** The request body `POST /api/admin/users` takes. */
export function addUserRequest(draft: AddUserDraft): {
  name: string;
  email: string;
  password: string | null;
  companyId: string | null;
  role: "member" | "admin";
} {
  return {
    name: draft.name.trim(),
    email: draft.email.trim(),
    password: draft.signIn === "password" ? draft.password : null,
    companyId: draft.companyId || null,
    role: draft.role,
  };
}

/**
 * What the admin is told once the account exists — chiefly whether the
 * person has heard about it, because an install with no email transport sends
 * nothing and the setup link would otherwise reach no one.
 */
export function addUserOutcome(
  response: Pick<AddUserResponse, "setupLink" | "emailStatus"> & { email: string },
): string {
  if (response.setupLink) {
    if (response.emailStatus === "sent") {
      return `We emailed the setup link to ${response.email}. You can also send it to them yourself.`;
    }
    if (response.emailStatus === "skipped") {
      return "No email transport is set up, so nothing was emailed. Send them this setup link yourself — it works once and expires in 7 days.";
    }
    return "The email could not be sent. Send them this setup link yourself — it works once and expires in 7 days.";
  }
  if (response.emailStatus === "sent") {
    return `We emailed ${response.email} that their account is ready. Give them the password you set.`;
  }
  return `They can sign in as ${response.email} with the password you set. Nothing was emailed, so let them know yourself.`;
}
