export type OauthAuthorizationFailure = {
  title: string;
  detail: string;
};

/**
 * Turn provider callback errors into useful setup guidance. OAuth providers
 * often use `access_denied` for a human cancellation, but configuration
 * failures need a different title and must preserve `error_description`.
 */
export function oauthAuthorizationFailure(args: {
  app: string;
  error: string;
  description?: string;
}): OauthAuthorizationFailure {
  if (args.app === "linkedin" && args.error === "unauthorized_scope_error") {
    return {
      title: "LinkedIn access is not enabled",
      detail:
        "LinkedIn rejected one or more requested permissions. In the LinkedIn Developer Portal, enable 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn'. Select 'Post as company pages' in Genosyn only after LinkedIn approves the app for the Community Management API.",
    };
  }

  if (args.error === "access_denied") {
    return {
      title: "Authorisation cancelled",
      detail:
        args.description?.trim() ||
        "The provider did not grant access. Close this window and try again.",
    };
  }

  const provider = args.app.charAt(0).toUpperCase() + args.app.slice(1);
  return {
    title: `${provider} authorisation failed`,
    detail:
      args.description?.trim() ||
      `${args.error}. Check the requested access in the provider's developer console, then try again.`,
  };
}
