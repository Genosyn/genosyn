import assert from "node:assert/strict";
import test from "node:test";
import { findGithubRepoCredential, testRepositoryConnection } from "./repositories.js";
import type { Repository } from "../db/entities/Repository.js";
import type { GithubRepoCredential } from "./repoSync.js";

const credential: GithubRepoCredential = {
  connectionId: "connection-1",
  owner: "Acme",
  name: "Web",
  envKey: "GENOSYN_GH_TOKEN_CONNECTION_1",
  token: "turn-only-token",
};

test("matches an allowlisted GitHub credential to an HTTPS Repository", () => {
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/web.git", [credential]),
    credential,
  );
  assert.equal(findGithubRepoCredential("https://GITHUB.com/ACME/WEB", [credential]), credential);
});

test("does not reuse GitHub credentials for another host or an SSH remote", () => {
  assert.equal(findGithubRepoCredential("https://gitlab.com/acme/web.git", [credential]), null);
  assert.equal(findGithubRepoCredential("git@github.com:acme/web.git", [credential]), null);
});

test("uses the sole granted GitHub Connection as the Repository credential", () => {
  const soleConnection = { ...credential, owner: null, name: null };
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/other.git", [soleConnection]),
    soleConnection,
  );
});

test("requires an allowlist match to disambiguate multiple GitHub Connections", () => {
  const otherConnection: GithubRepoCredential = {
    ...credential,
    connectionId: "connection-2",
    owner: null,
    name: null,
    envKey: "GENOSYN_GH_TOKEN_CONNECTION_2",
  };
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/other.git", [credential, otherConnection]),
    null,
  );
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/web.git", [otherConnection, credential]),
    credential,
  );
});

test("connection testing rejects a credential-bearing legacy URL before network access", async () => {
  const result = await testRepositoryConnection({
    authMode: "none",
    gitUrl: "https://legacy-user:legacy-secret@example.invalid/acme/repo.git",
  } as Repository);

  assert.equal(result.ok, false);
  assert.match(result.message, /plain http\(s\)/);
  assert.doesNotMatch(result.message, /legacy-user|legacy-secret/);
});
