import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { oauthAuthorizationFailure } from "./oauthErrors.js";

describe("OAuth authorisation errors", () => {
  test("explains LinkedIn permissions that need product approval", () => {
    assert.deepEqual(
      oauthAuthorizationFailure({
        app: "linkedin",
        error: "unauthorized_scope_error",
      }),
      {
        title: "LinkedIn access is not enabled",
        detail:
          "LinkedIn rejected one or more requested permissions. In the LinkedIn Developer Portal, enable 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn'. Select 'Post as company pages' in Genosyn only after LinkedIn approves the app for the Community Management API.",
      },
    );
  });

  test("preserves provider descriptions for non-cancellation errors", () => {
    assert.deepEqual(
      oauthAuthorizationFailure({
        app: "google",
        error: "invalid_scope",
        description: "Scope is not configured",
      }),
      {
        title: "Google authorisation failed",
        detail: "Scope is not configured",
      },
    );
  });
});
