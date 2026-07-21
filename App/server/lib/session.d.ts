import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    session?: {
      userId?: string;
      sessionVersion?: number;
      twoFactorUserId?: string;
      twoFactorExpiresAt?: number;
      twoFactorAttempts?: number;
      webAuthnChallenge?: string;
      webAuthnChallengeExpiresAt?: number;
      webAuthnPurpose?: "login" | "registration";
      webAuthnCredentialName?: string;
      webAuthnCredentialKind?: "passkey" | "security_key";
      totpSetupExpiresAt?: number;
    } | null;
  }
}

declare module "cookie-session" {
  // cookie-session ships its own types; this file only augments Express.
}
