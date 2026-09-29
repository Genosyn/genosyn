import { legacyGoogleSignInBroker } from "../services/googleSignInBroker.js";
import { createSignInBrokerRouter } from "./signInBrokerRouter.js";

/** No redirects: installed consumers pin this released API path for refresh. */
export const googleSignInBrokerRouter = createSignInBrokerRouter(legacyGoogleSignInBroker);
