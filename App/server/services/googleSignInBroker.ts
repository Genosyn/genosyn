import {
  createSignInBroker,
  getSignInBrokerOrigin,
  normalizeSignInInstallationOrigin,
} from "./signInBroker.js";
import { legacyGoogleSignInProtocol } from "./signInBrokerProtocol.js";
import { signInPage } from "./signInBrokerPage.js";
import { googleSignInProvider } from "./signInProviders/google.js";

/** Released Google API: callbacks, cookies and unfinished flows remain compatible. */
export const legacyGoogleSignInBroker = createSignInBroker(
  googleSignInProvider,
  legacyGoogleSignInProtocol,
);
export const {
  status: getGoogleSignInBrokerStatus,
  start: startGoogleSignIn,
  prepare: prepareGoogleSignIn,
  authorize: authorizeGoogleSignIn,
  complete: completeGoogleSignIn,
  poll: pollGoogleSignIn,
  refresh: refreshGoogleSignIn,
  cookieName: googleSignInCookieName,
} = legacyGoogleSignInBroker;
export const getGoogleSignInBrokerOrigin = getSignInBrokerOrigin;
export const normalizeGoogleInstallationOrigin = normalizeSignInInstallationOrigin;
export function googleSignInPage(args: Parameters<typeof signInPage>[2]) {
  return signInPage(googleSignInProvider, legacyGoogleSignInProtocol, args);
}
export {
  SIGN_IN_TTL_MS as GOOGLE_SIGN_IN_TTL_MS,
  SignInBrokerError as GoogleSignInBrokerError,
} from "./signInBroker.js";
export type { SignInPollResult as GoogleSignInPollResult } from "./signInBroker.js";
export type { HostedGoogleCredential } from "./signInProviders/google.js";
