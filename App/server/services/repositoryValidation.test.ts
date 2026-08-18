import assert from "node:assert/strict";
import test from "node:test";
import {
  repositoryCredentialError,
  repositoryCreateSchema,
  repositoryGitUrlSchema,
  repositoryPatchSchema,
  gitRemoteUrlForResponse,
  HIDDEN_UNSAFE_GIT_REMOTE_URL,
} from "./repositoryValidation.js";

const AUTH_FIELDS = {
  none: {},
  https: { token: "stored-separately" },
  ssh: { sshKey: "stored-separately" },
} as const;

test("create rejects credential-bearing clone URLs for every authentication mode", () => {
  for (const authMode of ["none", "https", "ssh"] as const) {
    for (const gitUrl of [
      "https://user:plain-text-secret@git.example/acme/repo.git",
      "ssh://git:plain-text-secret@git.example/acme/repo.git",
      "https://git.example/acme/repo.git?token=plain-text-secret",
    ]) {
      const result = repositoryCreateSchema.safeParse({
        name: "Repository",
        gitUrl,
        authMode,
        ...AUTH_FIELDS[authMode],
      });
      assert.equal(result.success, false, `${authMode} accepted ${gitUrl}`);
      if (!result.success) {
        assert.ok(result.error.issues.some((issue) => issue.path[0] === "gitUrl"));
      }
    }
  }
});

test("patch rejects credential-bearing clone URLs for every authentication mode", () => {
  for (const authMode of ["none", "https", "ssh"] as const) {
    for (const gitUrl of [
      "https://user:plain-text-secret@git.example/acme/repo.git",
      "ssh://git:plain-text-secret@git.example/acme/repo.git",
      "https://git.example/acme/repo.git#plain-text-secret",
    ]) {
      const result = repositoryPatchSchema.safeParse({ authMode, gitUrl });
      assert.equal(result.success, false, `${authMode} accepted ${gitUrl}`);
    }
  }
});

test("create accepts each supported URL and authentication combination", () => {
  for (const body of [
    {
      name: "Public repository",
      gitUrl: "http://git.example/acme/public.git",
      authMode: "none",
    },
    {
      name: "HTTPS repository",
      gitUrl: "https://git.example/acme/private.git",
      authMode: "https",
      token: "stored-separately",
    },
    {
      name: "SSH repository",
      gitUrl: "git@git.example:acme/private.git",
      authMode: "ssh",
      sshKey: "stored-separately",
    },
  ]) {
    assert.equal(repositoryCreateSchema.safeParse(body).success, true, body.gitUrl);
  }
});

test("clone URL schema accepts supported plain forms and trims API input", () => {
  for (const gitUrl of [
    "http://git.example/acme/repo.git",
    "https://git.example/acme/repo.git",
    "ssh://git@git.example/acme/repo.git",
    "git@git.example:acme/repo.git",
  ]) {
    assert.equal(repositoryGitUrlSchema.parse(`  ${gitUrl}  `), gitUrl);
  }
});

test("HTTPS credentials still require a plain HTTPS remote", () => {
  const result = repositoryCreateSchema.safeParse({
    name: "Repository",
    gitUrl: "ssh://git@git.example/acme/repo.git",
    authMode: "https",
    token: "stored-separately",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => issue.path[0] === "gitUrl"));
  }
});

test("patch final state rejects switching from public to HTTPS without a token", () => {
  assert.equal(
    repositoryCredentialError({
      authMode: "https",
      hasStoredToken: false,
      hasStoredSshKey: false,
    }),
    "HTTPS auth needs a token / password.",
  );
});

test("patch final state rejects switching from HTTPS to SSH without a private key", () => {
  assert.equal(
    repositoryCredentialError({
      authMode: "ssh",
      hasStoredToken: true,
      hasStoredSshKey: false,
    }),
    "SSH auth needs a private key.",
  );
});

test("patch final state accepts stored credentials or a replacement credential", () => {
  assert.equal(
    repositoryCredentialError({
      authMode: "https",
      hasStoredToken: true,
      hasStoredSshKey: false,
    }),
    null,
  );
  assert.equal(
    repositoryCredentialError({
      authMode: "ssh",
      hasStoredToken: false,
      hasStoredSshKey: false,
      sshKey: "replacement-private-key",
    }),
    null,
  );
});

test("legacy unsafe clone URLs are replaced before API hydration", () => {
  const unsafe = "https://user:plain-text-secret@git.example/acme/repo.git";
  const hydrated = gitRemoteUrlForResponse(unsafe);
  assert.equal(hydrated, HIDDEN_UNSAFE_GIT_REMOTE_URL);
  assert.doesNotMatch(hydrated, /plain-text-secret|user/);

  const safe = "ssh://git@git.example/acme/repo.git";
  assert.equal(gitRemoteUrlForResponse(safe), safe);
});

test("an empty clone URL is a local repository, not an unsafe one", () => {
  assert.equal(gitRemoteUrlForResponse(""), "");
});
