import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeGithubError, isGithubHttpsUrl } from "./repositoryGithub.js";

/**
 * The pure parts of publishing to GitHub. The network calls belong to GitHub
 * and are not worth faking; what is worth pinning down is that we recognise
 * which remotes a Connection can authenticate, and that a failure arrives as
 * something the person can act on rather than "Repository creation failed."
 */

describe("isGithubHttpsUrl", () => {
  test("accepts github.com over HTTPS in the shapes GitHub hands out", () => {
    for (const url of [
      "https://github.com/acme/web.git",
      "https://github.com/acme/web",
      "https://GitHub.com/Acme/Web.git",
    ]) {
      assert.equal(isGithubHttpsUrl(url), true, url);
    }
  });

  test("refuses anything a Connection token cannot authenticate", () => {
    for (const url of [
      "git@github.com:acme/web.git",
      "ssh://git@github.com/acme/web.git",
      "https://gitlab.com/acme/web.git",
      "https://github.example.com/acme/web.git",
      "https://notgithub.com/acme/web.git",
      "",
      "not a url",
    ]) {
      assert.equal(isGithubHttpsUrl(url), false, url);
    }
  });

  test("is not fooled by github.com appearing elsewhere in the URL", () => {
    assert.equal(isGithubHttpsUrl("https://evil.example/github.com/acme/web.git"), false);
    assert.equal(isGithubHttpsUrl("https://github.com.evil.example/acme/web.git"), false);
  });
});

describe("describeGithubError", () => {
  test("surfaces GitHub's validation detail, not just the headline", () => {
    const message = describeGithubError(
      {
        message: "Repository creation failed.",
        errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
      },
      422,
    );
    assert.match(message, /Repository creation failed/);
    assert.match(message, /name already_exists/);
  });

  test("prefers an explicit per-error message when GitHub gives one", () => {
    const message = describeGithubError(
      { message: "Validation Failed", errors: [{ message: "name already exists on this account" }] },
      422,
    );
    assert.match(message, /name already exists on this account/);
  });

  test("explains a permission failure instead of restating the status", () => {
    const message = describeGithubError({ message: "Not Found" }, 403);
    assert.match(message, /permission to create repositories/);
    assert.match(message, /reconnect/i);
  });

  test("falls back to the status when the body says nothing useful", () => {
    assert.match(describeGithubError(null, 500), /GitHub returned 500/);
    assert.match(describeGithubError("gateway timeout", 504), /GitHub returned 504/);
  });

  test("never throws on a shape it did not expect", () => {
    for (const body of [undefined, 42, [], { errors: "nope" }, { message: 7 }]) {
      assert.doesNotThrow(() => describeGithubError(body, 400));
    }
  });
});
