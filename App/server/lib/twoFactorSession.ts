import type { Request } from "express";

const LOGIN_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function beginTwoFactorLoginSession(req: Request, userId: string): void {
  req.session = {
    twoFactorUserId: userId,
    twoFactorExpiresAt: Date.now() + LOGIN_TTL_MS,
    twoFactorAttempts: 0,
  };
}

export function pendingTwoFactorUserId(req: Request): string | null {
  const userId = req.session?.twoFactorUserId;
  const expiresAt = req.session?.twoFactorExpiresAt;
  if (!userId || !expiresAt || expiresAt <= Date.now()) {
    if (req.session?.twoFactorUserId) req.session = null;
    return null;
  }
  return userId;
}

export function recordTwoFactorFailure(req: Request): boolean {
  if (!req.session) return true;
  const attempts = (req.session.twoFactorAttempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    req.session = null;
    return true;
  }
  req.session.twoFactorAttempts = attempts;
  return false;
}

export function completeTwoFactorLogin(req: Request, userId: string): void {
  req.session = { userId };
}

export function rememberWebAuthnChallenge(
  req: Request,
  args: {
    challenge: string;
    purpose: "login" | "registration";
    credentialName?: string;
    credentialKind?: "passkey" | "security_key";
  },
): void {
  req.session = {
    ...(req.session ?? {}),
    webAuthnChallenge: args.challenge,
    webAuthnChallengeExpiresAt: Date.now() + CHALLENGE_TTL_MS,
    webAuthnPurpose: args.purpose,
    webAuthnCredentialName: args.credentialName,
    webAuthnCredentialKind: args.credentialKind,
  };
}

export function readWebAuthnChallenge(
  req: Request,
  purpose: "login" | "registration",
): {
  challenge: string;
  credentialName?: string;
  credentialKind?: "passkey" | "security_key";
} | null {
  const session = req.session;
  if (
    !session?.webAuthnChallenge ||
    session.webAuthnPurpose !== purpose ||
    !session.webAuthnChallengeExpiresAt ||
    session.webAuthnChallengeExpiresAt <= Date.now()
  ) {
    clearWebAuthnChallenge(req);
    return null;
  }
  return {
    challenge: session.webAuthnChallenge,
    credentialName: session.webAuthnCredentialName,
    credentialKind: session.webAuthnCredentialKind,
  };
}

export function clearWebAuthnChallenge(req: Request): void {
  if (!req.session) return;
  delete req.session.webAuthnChallenge;
  delete req.session.webAuthnChallengeExpiresAt;
  delete req.session.webAuthnPurpose;
  delete req.session.webAuthnCredentialName;
  delete req.session.webAuthnCredentialKind;
}
