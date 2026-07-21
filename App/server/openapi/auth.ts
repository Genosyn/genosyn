import { z } from "zod";
import { defaultSecurity, publicSecurity, registry } from "./registry.js";

/**
 * Auth endpoints. Login + signup are public; everything else requires the
 * cookie or a Bearer token. Once you have a session cookie, you can mint a
 * Bearer token at Settings → API keys for use against this same surface.
 */

const MeResponse = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string(),
    handle: z.string().nullable(),
    avatarKey: z.string().nullable(),
    isMasterAdmin: z.boolean(),
    emailVerified: z.boolean(),
    emailVerificationRequired: z.boolean(),
  })
  .openapi("Me");

const LoginRequest = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi("LoginRequest");

const TwoFactorMethods = z.object({
  enabled: z.literal(true),
  totp: z.boolean(),
  webAuthn: z.boolean(),
  recovery: z.boolean(),
});

const LoginUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  emailVerificationRequired: z.boolean(),
});

const LoginResponse = z
  .union([
    LoginUser.extend({ requiresTwoFactor: z.literal(false) }),
    z.object({
      requiresTwoFactor: z.literal(true),
      methods: TwoFactorMethods,
    }),
  ])
  .openapi("LoginResponse");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

registry.registerPath({
  method: "get",
  path: "/api/auth/me",
  summary: "Get the authenticated user",
  description:
    "Returns the currently-authenticated user. Useful as a `whoami` probe to " +
    "confirm a Bearer token works before making real calls.",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MeResponse } },
    },
    401: {
      description: "No valid session or Bearer token",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/verify-email",
  summary: "Verify a Member email address",
  description: "Consumes the single-use token sent after signup or an email-address change.",
  tags: ["Auth"],
  security: publicSecurity,
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ token: z.string().min(1) }) },
      },
    },
  },
  responses: {
    200: {
      description: "Email verified",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: {
      description: "Invalid or expired token",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/resend-verification",
  summary: "Send a fresh email-verification link",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "Verification email sent or the account was already verified",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  summary: "Log in with email + password",
  description:
    "Verifies the primary password. Accounts without 2FA receive a full " +
    "session immediately; enrolled accounts receive a short-lived pre-auth " +
    "session and must complete one of the advertised second-factor methods. " +
    "Programmatic clients should mint a Bearer API key instead.",
  tags: ["Auth"],
  security: publicSecurity,
  request: {
    body: {
      content: { "application/json": { schema: LoginRequest } },
    },
  },
  responses: {
    200: {
      description: "Logged in, or primary authentication completed and 2FA is required",
      content: { "application/json": { schema: LoginResponse } },
    },
    401: {
      description: "Invalid credentials",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  summary: "Clear the session cookie",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "Logged out",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
  },
});
