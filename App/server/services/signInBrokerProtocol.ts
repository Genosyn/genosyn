export type SignInBrokerProtocol = {
  providerId: string;
  basePath: string;
  flowKind: string;
  callbackKind: string;
  cookiePrefix: string;
  readyMessage: string;
  launchMessage: string;
  legacy: boolean;
};

/** Keep the released protocol stable, including already-open browser flows. */
export const legacyGoogleSignInProtocol: SignInBrokerProtocol = Object.freeze({
  providerId: "google",
  basePath: "/api/google-sign-in",
  flowKind: "hosted-google-sign-in",
  callbackKind: "hosted-google-sign-in-callback",
  cookiePrefix: "genosyn_gmail_",
  readyMessage: "genosyn-google-sign-in-ready",
  launchMessage: "genosyn-google-sign-in-launch",
  legacy: true,
});

/** Called only for a provider selected from the static adapter registry. */
export function canonicalSignInProtocol(providerId: string): SignInBrokerProtocol {
  return {
    providerId,
    basePath: `/api/connect/${providerId}`,
    flowKind: `hosted-sign-in:${providerId}`,
    callbackKind: `hosted-sign-in-callback:${providerId}`,
    cookiePrefix: `genosyn_sign_in_${providerId}_`,
    readyMessage: "genosyn-sign-in-ready",
    launchMessage: "genosyn-sign-in-launch",
    legacy: false,
  };
}
