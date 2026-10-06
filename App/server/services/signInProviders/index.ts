import type { SignInProvider } from "../signInBrokerTypes.js";
import { googleSignInProvider } from "./google.js";

/** Explicit adapters only: never load provider names, endpoints, or scopes from requests. */
const providers: ReadonlyMap<string, SignInProvider> = new Map([
  [googleSignInProvider.id, googleSignInProvider],
]);

export function getSignInProvider(id: string): SignInProvider | undefined {
  return providers.get(id);
}
