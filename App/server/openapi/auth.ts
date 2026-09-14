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

const PasskeyAuthenticationOptions = z
  .object({
    challenge: z.string(),
    rpId: z.string(),
    timeout: z.number().optional(),
    userVerification: z.literal("required"),
    allowCredentials: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("public-key"),
          transports: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  })
  .passthrough()
  .openapi("PasskeyAuthenticationOptions");

const PasskeyAuthenticationResponse = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    response: z.object({
      authenticatorData: z.string(),
      clientDataJSON: z.string(),
      signature: z.string(),
      userHandle: z.string().nullable().optional(),
    }),
    clientExtensionResults: z.record(z.unknown()).optional(),
    authenticatorAttachment: z.string().nullable().optional(),
  })
  .passthrough()
  .openapi("PasskeyAuthenticationResponse");

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
  description:
    "Rotates the single-use token, so any earlier link stops working. " +
    "`delivery` reports what actually became of the mail rather than merely " +
    "acknowledging the request: `skipped` means the install has no email " +
    "transport and the link went to the server log, and `failed` means the " +
    "transport rejected it. The underlying transport error is never returned.",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "Verification email attempted, or the account was already verified",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            delivery: z.enum(["sent", "skipped", "failed", "already_verified"]),
          }),
        },
      },
    },
    429: {
      description: "Too many attempts — retry after the interval in the Retry-After header",
      content: { "application/json": { schema: ErrorResponse } },
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
  path: "/api/auth/login/passkey/options",
  summary: "Start passwordless passkey sign-in",
  description:
    "Creates a five-minute, single-use WebAuthn challenge for a discoverable credential and " +
    "binds it to the browser session that requested it. No account identifier is required.",
  tags: ["Auth"],
  security: publicSecurity,
  request: {
    body: { content: { "application/json": { schema: z.object({}) } } },
  },
  responses: {
    200: {
      description: "Passkey ceremony created",
      content: {
        "application/json": {
          schema: z.object({
            options: PasskeyAuthenticationOptions,
            flowToken: z.string(),
          }),
        },
      },
    },
    429: {
      description: "Too many attempts — retry after the interval in the Retry-After header",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login/passkey/verify",
  summary: "Complete passwordless passkey sign-in",
  description:
    "Consumes the one-time challenge, verifies the discoverable credential with user " +
    "verification, and creates a full browser session carrying second-factor evidence.",
  tags: ["Auth"],
  security: publicSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            flowToken: z.string(),
            response: PasskeyAuthenticationResponse,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Logged in",
      content: { "application/json": { schema: LoginUser } },
    },
    400: {
      description: "The challenge expired, was already used, or came from another browser",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "The passkey assertion could not be verified",
      content: { "application/json": { schema: ErrorResponse } },
    },
    429: {
      description: "Too many attempts — retry after the interval in the Retry-After header",
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
