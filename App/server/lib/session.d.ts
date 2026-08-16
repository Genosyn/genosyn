import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    session?: {
      userId?: string;
      sessionVersion?: number;
      /** Primary password or SSO completion time, used for step-up gates. */
      authenticatedAt?: number;
      /** Successful TOTP, recovery-code, or WebAuthn completion time. */
      secondFactorAt?: number;
      twoFactorUserId?: string;
      twoFactorExpiresAt?: number;
      twoFactorAttempts?: number;
      primaryAuthenticatedAt?: number;
      webAuthnChallenge?: string;
      webAuthnChallengeExpiresAt?: number;
      webAuthnPurpose?: "login" | "registration";
      webAuthnCredentialName?: string;
      webAuthnCredentialKind?: "passkey" | "security_key";
      /** The `totp_credentials` row the in-flight enrollment belongs to. */
      totpSetupId?: string;
      totpSetupExpiresAt?: number;
      ssoBrowserBinding?: string;
    } | null;
  }
}

declare module "cookie-session" {
  // cookie-session ships its own types; this file only augments Express.
}
