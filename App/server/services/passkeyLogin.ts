import crypto from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { User } from "../db/entities/User.js";
import { consumeAuthFlowState, createAuthFlowState } from "./authFlowState.js";
import { beginWebAuthnAuthentication, verifyStoredWebAuthnAssertion } from "./webAuthn.js";

const PASSKEY_LOGIN_STATE_KIND = "passkey-login";
const PASSKEY_LOGIN_TTL_MS = 5 * 60 * 1000;

type PasskeyLoginState = {
  challenge: string;
  browserBindingHash: string;
};

export class PasskeyLoginStateError extends Error {
  constructor() {
    super("The passkey sign-in attempt expired or came from another browser. Try again.");
    this.name = "PasskeyLoginStateError";
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isPasskeyLoginState(value: unknown): value is PasskeyLoginState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PasskeyLoginState>;
  return (
    typeof candidate.challenge === "string" &&
    candidate.challenge.length > 0 &&
    typeof candidate.browserBindingHash === "string" &&
    candidate.browserBindingHash.length > 0
  );
}

/** Start a discoverable-credential ceremony without asking for an account id. */
export async function startPasskeyLogin(existingBrowserBinding?: string) {
  const options = await beginWebAuthnAuthentication();
  if (!options) throw new Error("Could not create passkey authentication options");
  // One stable, signed-cookie nonce can bind several simultaneous ceremonies
  // from tabs in the same browser. Each ceremony still has independent,
  // single-use server state and its own challenge.
  const browserBinding = existingBrowserBinding || crypto.randomBytes(32).toString("base64url");
  const flowToken = await createAuthFlowState(
    PASSKEY_LOGIN_STATE_KIND,
    {
      challenge: options.challenge,
      browserBindingHash: digest(browserBinding),
    } satisfies PasskeyLoginState,
    PASSKEY_LOGIN_TTL_MS,
  );
  return { options, flowToken, browserBinding };
}

/**
 * Atomically burn the flow state before checking the assertion. A bad
 * credential, wrong browser, or replay therefore cannot reuse the challenge.
 */
export async function finishPasskeyLogin(args: {
  flowToken: string;
  browserBinding: string;
  response: AuthenticationResponseJSON;
}): Promise<User | null> {
  const state = await consumeAuthFlowState<unknown>(PASSKEY_LOGIN_STATE_KIND, args.flowToken);
  if (
    !isPasskeyLoginState(state) ||
    !args.browserBinding ||
    !sameDigest(state.browserBindingHash, digest(args.browserBinding))
  ) {
    throw new PasskeyLoginStateError();
  }
  const verified = await verifyStoredWebAuthnAssertion({
    expectedChallenge: state.challenge,
    response: args.response,
    requireUserHandle: true,
  });
  return verified?.user ?? null;
}
