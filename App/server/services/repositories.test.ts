import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  adoptLegacyCheckout,
  encryptRepoSecret,
  fastForwardEmployeeDefaultBranch,
  findForgeRepoCredential,
  testRepositoryConnection,
} from "./repositories.js";
import { GITHUB_ENDPOINT, forgejoEndpoint } from "../integrations/providers/forge/client.js";
import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import type { Repository } from "../db/entities/Repository.js";
import type { ForgeRepoCredential } from "./repoSync.js";
import { config } from "../../config.js";

// ────────── matching a remote to the Connection that can sign it in ──────────

/**
 * The credential shape `repoSync` hands the Repository materializer for one
 * granted Connection. `owner`/`name` null is the Connection that has no
 * allowlist, which is the only shape the sole-Connection fallback applies to.
 */
function githubCredential(overrides: Partial<ForgeRepoCredential> = {}): ForgeRepoCredential {
  return {
    connectionId: "github-connection",
    endpoint: GITHUB_ENDPOINT,
    username: "x-access-token",
    owner: "Acme",
    name: "Web",
    envKey: "GENOSYN_FORGE_TOKEN_GITHUB_CONNECTION",
    token: "github-turn-token",
    ...overrides,
  };
}

function forgejoCredential(
  baseUrl: string,
  overrides: Partial<ForgeRepoCredential> = {},
): ForgeRepoCredential {
  return {
    connectionId: "forgejo-connection",
    endpoint: forgejoEndpoint(baseUrl),
    username: "octo-admin",
    owner: "Acme",
    name: "Web",
    envKey: "GENOSYN_FORGE_TOKEN_FORGEJO_CONNECTION",
    token: "forgejo-turn-token",
    ...overrides,
  };
}

describe("matching a Repository remote to a granted Connection's credential", () => {
  test("matches an allowlisted repository on the Connection's own host", () => {
    const credential = githubCredential();
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/web.git", [credential]),
      credential,
    );
  });

  test("matches owner and repository case-insensitively, as both forges resolve them", () => {
    const github = githubCredential();
    const forgejo = forgejoCredential("https://git.acme.com");
    assert.equal(findForgeRepoCredential("https://GITHUB.com/ACME/WEB", [github]), github);
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/ACME/Web.GIT", [forgejo]),
      forgejo,
      "a remote that differs only in case is the same repository, and must not fall through",
    );
  });

  /**
   * The allowlist is the narrower statement — this Connection was picked for
   * *this* repository — so it has to win wherever both rules could fire, and
   * it has to win regardless of which credential `repoSync` happened to list
   * first.
   */
  test("prefers the Connection that allowlisted this repository over one with no allowlist", () => {
    const allowlisted = githubCredential();
    const anyRepo = githubCredential({
      connectionId: "github-connection-2",
      owner: null,
      name: null,
      envKey: "GENOSYN_FORGE_TOKEN_GITHUB_CONNECTION_2",
      token: "second-github-token",
    });

    assert.equal(
      findForgeRepoCredential("https://github.com/acme/web.git", [allowlisted, anyRepo]),
      allowlisted,
    );
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/web.git", [anyRepo, allowlisted]),
      allowlisted,
    );
  });

  test("falls back to the only Connection that can reach the host when nothing is allowlisted", () => {
    const soleConnection = githubCredential({ owner: null, name: null });
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/unlisted.git", [soleConnection]),
      soleConnection,
    );
  });

  /**
   * The rule this replaced counted Connections globally, so an employee
   * granted a GitHub Connection *and* a Forgejo Connection had two of them and
   * got neither — or, before that, got whichever was listed first and had its
   * token sent to the wrong company's server. Narrowing by host first is what
   * makes both grants usable at once.
   */
  test("gives an employee with one Connection per forge the right one for each remote", () => {
    const github = githubCredential({ owner: null, name: null });
    const forgejo = forgejoCredential("https://git.acme.com", { owner: null, name: null });
    const granted = [github, forgejo];

    assert.equal(findForgeRepoCredential("https://github.com/acme/unlisted.git", granted), github);
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/acme/unlisted.git", granted),
      forgejo,
    );
  });

  test("carries the forge's own git username on the credential it picks", () => {
    const github = githubCredential({ owner: null, name: null });
    const forgejo = forgejoCredential("https://git.acme.com", { owner: null, name: null });
    const granted = [github, forgejo];

    // Forgejo resolves basic auth by looking the username up and then checking
    // the password against that account's tokens, so GitHub's literal would
    // fail there — quietly, as a plain authentication failure.
    const picked = findForgeRepoCredential("https://git.acme.com/acme/web.git", granted);
    assert.equal(picked?.username, "octo-admin");
    assert.notEqual(picked?.username, "x-access-token");
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/web.git", granted)?.username,
      "x-access-token",
    );
  });

  test("refuses to guess between two Connections on the same host", () => {
    const first = githubCredential({ owner: null, name: null });
    const second = githubCredential({
      connectionId: "github-connection-2",
      owner: null,
      name: null,
      envKey: "GENOSYN_FORGE_TOKEN_GITHUB_CONNECTION_2",
      token: "second-github-token",
    });
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/unlisted.git", [first, second]),
      null,
      "two accounts and no allowlist is a question for a human, not a coin toss",
    );
  });

  test("still answers when one Connection contributes several allowlist entries", () => {
    const web = githubCredential();
    const api = githubCredential({ name: "Api" });
    // Same Connection, so the same token either way — the count that matters
    // is Connections, not allowlist rows.
    assert.equal(findForgeRepoCredential("https://github.com/acme/api.git", [web, api]), api);
    assert.equal(
      findForgeRepoCredential("https://github.com/acme/unlisted.git", [web, api])?.connectionId,
      "github-connection",
    );
  });

  test("matches nothing when the employee has no forge Connections at all", () => {
    assert.equal(findForgeRepoCredential("https://github.com/acme/web.git", []), null);
  });

  test("never lends a credential to another host", () => {
    const github = githubCredential({ owner: null, name: null });
    const forgejo = forgejoCredential("https://git.acme.com", { owner: null, name: null });
    const granted = [github, forgejo];

    assert.equal(findForgeRepoCredential("https://gitlab.com/acme/web.git", granted), null);
    assert.equal(
      findForgeRepoCredential("https://github.com.evil.test/acme/web.git", granted),
      null,
      "a suffix of the configured host is a different host",
    );
    assert.equal(
      findForgeRepoCredential("http://github.com/acme/web.git", granted),
      null,
      "a token must never ride on a plain http remote",
    );
  });

  test("distinguishes a Connection by port, not just by hostname", () => {
    const onPort = forgejoCredential("https://git.acme.com:3000", { owner: null, name: null });
    const onDefault = forgejoCredential("https://git.acme.com", {
      connectionId: "forgejo-connection-2",
      owner: null,
      name: null,
      envKey: "GENOSYN_FORGE_TOKEN_FORGEJO_CONNECTION_2",
      token: "default-port-token",
    });

    assert.equal(
      findForgeRepoCredential("https://git.acme.com:3000/acme/web.git", [onPort, onDefault]),
      onPort,
    );
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/acme/web.git", [onPort, onDefault]),
      onDefault,
    );
  });

  test("tolerates a server URL an operator typed with a trailing slash", () => {
    const credential = forgejoCredential("https://git.acme.com/", { owner: null, name: null });
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/acme/web.git", [credential]),
      credential,
    );
  });

  /**
   * A Forgejo mounted under a path is the case a `pathname.split("/")` host
   * match gets wrong: it reads `git/acme` as the owner and repository, and it
   * hands the token to whichever Connection shares the origin.
   */
  test("keeps two Forgejo Connections on one origin apart by their sub-path", () => {
    const forge = forgejoCredential("https://git.acme.com/forge", { owner: null, name: null });
    const other = forgejoCredential("https://git.acme.com/other", {
      connectionId: "forgejo-connection-2",
      owner: null,
      name: null,
      envKey: "GENOSYN_FORGE_TOKEN_FORGEJO_CONNECTION_2",
      token: "other-mount-token",
    });
    const granted = [forge, other];

    assert.equal(
      findForgeRepoCredential("https://git.acme.com/forge/acme/web.git", granted),
      forge,
    );
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/other/acme/web.git", granted),
      other,
    );
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/acme/web.git", granted),
      null,
      "a repository at the origin root belongs to neither mount",
    );
  });

  test("matches no credential for an SSH remote or a URL that will not parse", () => {
    const github = githubCredential({ owner: null, name: null });
    const forgejo = forgejoCredential("https://git.acme.com", { owner: null, name: null });
    const granted = [github, forgejo];

    // A forge token authenticates HTTPS. Handing one to an SSH remote cannot
    // work, and matching would suppress the "add an SSH key" advice.
    assert.equal(findForgeRepoCredential("git@github.com:acme/web.git", granted), null);
    assert.equal(findForgeRepoCredential("ssh://git@git.acme.com/acme/web.git", granted), null);
    assert.equal(findForgeRepoCredential("git.acme.com/acme/web", granted), null);
    assert.equal(findForgeRepoCredential("", granted), null);
    assert.equal(findForgeRepoCredential("https://git.acme.com", granted), null);
    assert.equal(
      findForgeRepoCredential("https://git.acme.com/acme", granted),
      null,
      "an owner with no repository names no repository",
    );
    assert.equal(findForgeRepoCredential("https://git.acme.com/acme/web/tree/main", granted), null);
  });
});

// ────────────────────── the Test connection diagnostic ───────────────────────

describe("testing a Repository connection", () => {
  const githubConnection = { id: "github-connection" } as IntegrationConnection;
  const forgejoConnection = { id: "forgejo-connection" } as IntegrationConnection;
  const remote = {
    companyId: "company-1",
    authMode: "none",
    gitUrl: "https://github.com/acme/private.git",
  } as Repository;
  const forgejoRemote = {
    ...remote,
    gitUrl: "https://git.acme.com/acme/private.git",
  } as Repository;

  test("reuses the pinned-or-sole GitHub Connection for a credential-free remote", async () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedHelper: string | undefined;

    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({
        kind: "one",
        connection: githubConnection,
      }),
      resolveConnectionToken: async (connection) => {
        assert.equal(connection, githubConnection);
        return {
          token: "connection-token",
          login: "acme",
          endpoint: GITHUB_ENDPOINT,
          provider: "github",
        };
      },
      runGit: async (_workspaceRoot, _cwd, args, extraEnv, credentialHelper) => {
        assert.deepEqual(args, ["ls-remote", "--symref", remote.gitUrl, "HEAD"]);
        capturedEnv = extraEnv;
        capturedHelper = credentialHelper;
        return { stdout: "ref: refs/heads/trunk\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.deepEqual(result, {
      ok: true,
      message: "Repository is reachable.",
      defaultBranch: "trunk",
    });
    assert.equal(capturedEnv?.GENOSYN_REPO_TOKEN_CONNECTION_TEST, "connection-token");
    assert.match(capturedHelper ?? "", /GENOSYN_REPO_TOKEN_CONNECTION_TEST/);
    assert.match(capturedHelper ?? "", /x-access-token/);
    assert.doesNotMatch(capturedHelper ?? "", /connection-token/);
  });

  /**
   * The username is the half of a forge credential that differs between the
   * two. Sending `x-access-token` to Forgejo fails as a plain authentication
   * error, which reads exactly like an expired token and sends the Member off
   * to reissue one that was never wrong.
   */
  test("signs a Forgejo remote in as the token's own account, not as x-access-token", async () => {
    let capturedHelper: string | undefined;

    const result = await testRepositoryConnection(forgejoRemote, {
      resolveConnectionForRemote: async () => ({
        kind: "one",
        connection: forgejoConnection,
      }),
      resolveConnectionToken: async () => ({
        token: "forgejo-token",
        login: "octo-admin",
        endpoint: forgejoEndpoint("https://git.acme.com"),
        provider: "forgejo",
      }),
      runGit: async (_workspaceRoot, _cwd, _args, extraEnv, credentialHelper) => {
        assert.equal(extraEnv?.GENOSYN_REPO_TOKEN_CONNECTION_TEST, "forgejo-token");
        capturedHelper = credentialHelper;
        return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.equal(result.ok, true);
    assert.match(capturedHelper ?? "", /octo-admin/);
    assert.doesNotMatch(capturedHelper ?? "", /x-access-token/);
    assert.doesNotMatch(capturedHelper ?? "", /forgejo-token/);
  });

  /**
   * A GitHub App installation token has no login of its own and never needed
   * one — the literal `x-access-token` is what GitHub requires. Refusing on a
   * blank login would break every App-connected repository.
   */
  test("still signs a GitHub Connection in when it reports no login", async () => {
    let ran = false;
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "one", connection: githubConnection }),
      resolveConnectionToken: async () => ({
        token: "installation-token",
        login: "",
        endpoint: GITHUB_ENDPOINT,
        provider: "github",
      }),
      runGit: async (_workspaceRoot, _cwd, _args, _extraEnv, credentialHelper) => {
        ran = true;
        assert.match(credentialHelper ?? "", /x-access-token/);
        return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(ran, true);
  });

  test("refuses a Forgejo Connection that cannot say which account it authenticates as", async () => {
    let ran = false;
    const result = await testRepositoryConnection(forgejoRemote, {
      resolveConnectionForRemote: async () => ({ kind: "one", connection: forgejoConnection }),
      resolveConnectionToken: async () => ({
        token: "forgejo-token",
        login: "   ",
        endpoint: forgejoEndpoint("https://git.acme.com"),
        provider: "forgejo",
      }),
      runGit: async () => {
        ran = true;
        return { stdout: "" };
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /does not know which account it authenticates as/);
    assert.match(result.message, /Settings → Integrations/);
    assert.equal(
      ran,
      false,
      "a username the server cannot resolve buys nothing over saying so, so no probe is made",
    );
  });

  test("keeps testing anonymously when no Connection exists for the host", async () => {
    let resolvedToken = false;
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      resolveConnectionToken: async () => {
        resolvedToken = true;
        return {
          token: "unused",
          login: "unused",
          endpoint: GITHUB_ENDPOINT,
          provider: "github",
        };
      },
      runGit: async (_workspaceRoot, _cwd, _args, extraEnv, credentialHelper) => {
        assert.deepEqual(extraEnv, {});
        assert.equal(credentialHelper, undefined);
        return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.defaultBranch, "main");
    assert.equal(resolvedToken, false);
  });

  /**
   * This sentence used to say "more than one GitHub Connection", which is
   * false on a self-hosted forge and sends the Member looking for a GitHub
   * account they never connected.
   */
  test("explains an ambiguous private remote without naming a forge it may not be", async () => {
    const result = await testRepositoryConnection(forgejoRemote, {
      resolveConnectionForRemote: async () => ({
        kind: "ambiguous",
        connections: [forgejoConnection, { id: "other" } as IntegrationConnection],
      }),
      runGit: async () => {
        throw new Error(
          "git ls-remote failed: error: unable to read askpass response from '/bin/false' | " +
            "fatal: could not read Username for 'https://git.acme.com': terminal prompts disabled",
        );
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /more than one Connection could reach this server/i);
    assert.doesNotMatch(result.message, /GitHub/);
    assert.doesNotMatch(result.message, /askpass|\/bin\/false|terminal prompts/i);
  });

  test("explains missing authentication and names both forges a Connection can cover", async () => {
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      runGit: async () => {
        throw new Error("git ls-remote failed: fatal: unable to get password from user");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /requires sign-in/i);
    assert.match(result.message, /Forgejo \/ Gitea/);
    assert.match(result.message, /Settings → Integrations/);
    assert.doesNotMatch(result.message, /askpass|\/bin\/false|unable to get password/i);
  });

  /**
   * The Connection authenticated to the forge and still could not read this
   * repository — which is an access problem on that account, not a missing
   * credential. Telling the person to "choose a token" here is advice for a
   * different fault.
   */
  test("blames the Connection when it is the credential that was actually tried", async () => {
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "one", connection: githubConnection }),
      resolveConnectionToken: async () => ({
        token: "connection-token",
        login: "acme",
        endpoint: GITHUB_ENDPOINT,
        provider: "github",
      }),
      runGit: async () => {
        throw new Error("git ls-remote failed: fatal: Authentication failed for 'https://…'");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /The Connection could not authenticate to this repository/);
    assert.match(result.message, /Settings → Integrations/);
    assert.doesNotMatch(result.message, /Authentication failed for/);
  });

  test("passes a non-authentication git failure through in the forge's own words", async () => {
    const notFound =
      "git ls-remote failed: fatal: repository 'https://github.com/acme/gone' not found";
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      runGit: async () => {
        throw new Error(notFound);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.message,
      notFound,
      "sign-in advice for a repository that does not exist sends the Member after the wrong fault",
    );
  });

  test("does not offer Connection advice to a repository that carries its own token", async () => {
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "https",
        httpsUsername: "repository-user",
        encryptedToken: encryptRepoSecret("expired-token", remote.companyId),
      } as Repository,
      {
        runGit: async () => {
          throw new Error("git ls-remote failed: fatal: Authentication failed");
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(
      result.message,
      /Authentication failed/,
      "the stored token is the thing that is wrong, and Git already said so",
    );
    assert.doesNotMatch(result.message, /Settings → Integrations/);
  });

  test("reports a stored HTTPS token that no longer decrypts as one to re-enter", async () => {
    let ran = false;
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "https",
        // What a rotated or lost instance encryption key leaves on the row.
        encryptedToken: "not-a-decryptable-blob",
      } as Repository,
      {
        runGit: async () => {
          ran = true;
          return { stdout: "" };
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.message, /No HTTPS token is set/);
    assert.equal(ran, false);
  });

  test("refuses HTTPS auth on a remote that is not an https:// URL", async () => {
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "https",
        gitUrl: "git@github.com:acme/private.git",
        encryptedToken: encryptRepoSecret("stored-token", remote.companyId),
      } as Repository,
      {
        runGit: async () => {
          throw new Error("runGit must not be reached");
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.message, /isn't an https:\/\/ URL/);
  });

  test("keeps a stored HTTPS token ahead of any Connection", async () => {
    const token = "stored-repository-token";
    let resolvedConnection = false;
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "https",
        httpsUsername: "repository-user",
        encryptedToken: encryptRepoSecret(token, remote.companyId),
      } as Repository,
      {
        resolveConnectionForRemote: async () => {
          resolvedConnection = true;
          return { kind: "one", connection: githubConnection };
        },
        runGit: async (_workspaceRoot, _cwd, _args, extraEnv, credentialHelper) => {
          assert.equal(extraEnv?.GENOSYN_REPO_TOKEN_CONNECTION_TEST, token);
          assert.match(credentialHelper ?? "", /repository-user/);
          return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(resolvedConnection, false);
  });

  test("keeps the stored SSH key path for SSH repositories", async () => {
    const privateKey = "-----BEGIN TEST KEY-----\nprivate material\n-----END TEST KEY-----";
    let resolvedConnection = false;
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "ssh",
        gitUrl: "git@github.com:acme/private.git",
        encryptedSshKey: encryptRepoSecret(privateKey, remote.companyId),
      } as Repository,
      {
        resolveConnectionForRemote: async () => {
          resolvedConnection = true;
          return { kind: "one", connection: githubConnection };
        },
        runGit: async (_workspaceRoot, cwd, _args, extraEnv, credentialHelper) => {
          assert.equal(fs.readFileSync(path.join(cwd, "key"), "utf8"), `${privateKey}\n`);
          assert.match(extraEnv?.GIT_SSH_COMMAND ?? "", /ssh -i/);
          assert.equal(credentialHelper, undefined);
          return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(resolvedConnection, false);
  });

  test("reports a reachable remote whose HEAD names no branch", async () => {
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      // An empty repository answers `ls-remote` with nothing at all.
      runGit: async () => ({ stdout: "" }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.defaultBranch, undefined);
  });
});

/**
 * The panel a Member reads when a repository will not sync. It runs one
 * `ls-remote` in a directory the server just created, so it is not the
 * command-execution surface the coding-runtime gate guards — and an install
 * whose sandbox could not start still clones, fetches and pushes the
 * server-owned checkout. Leaving the diagnostic gated meant the heavier
 * credentialed operation ran while the question "is this URL and token right?"
 * answered with a paragraph about bubblewrap.
 */
test("connection testing survives an install with no usable sandbox", async () => {
  const codingTools = config.agent.codingTools as { executionMode: string };
  const original = codingTools.executionMode;
  codingTools.executionMode = "disabled";
  try {
    const result = await testRepositoryConnection({
      authMode: "none",
      // RFC 6761 reserves .invalid, so this fails in DNS rather than reaching
      // anything — the point is which error comes back.
      gitUrl: "https://genosyn.invalid/acme/repo.git",
    } as Repository);

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /Command execution is disabled/);
  } finally {
    codingTools.executionMode = original;
  }
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

/**
 * Employee checkouts moved from `code-repos/<slug>` to `repositories/<slug>`
 * with the Code → Repository rename. An install that upgraded mid-flight must
 * keep whatever the employee had not committed; re-cloning beside the old
 * directory would silently throw that away.
 */
describe("adopting a pre-rename checkout", () => {
  function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-legacy-checkout-"));
  }

  test("moves an old checkout to the new path", () => {
    const cwd = workspace();
    const legacy = path.join(cwd, "code-repos", "web");
    fs.mkdirSync(path.join(legacy, ".git"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "uncommitted.txt"), "work in progress");

    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.existsSync(path.join(target, ".git")), true);
    assert.equal(fs.readFileSync(path.join(target, "uncommitted.txt"), "utf8"), "work in progress");
    assert.equal(fs.existsSync(legacy), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("leaves an existing new checkout alone", () => {
    const cwd = workspace();
    const legacy = path.join(cwd, "code-repos", "web");
    fs.mkdirSync(path.join(legacy, ".git"), { recursive: true });
    const target = path.join(cwd, "repositories", "web");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, "current.txt"), "keep me");

    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.readFileSync(path.join(target, "current.txt"), "utf8"), "keep me");
    assert.equal(fs.existsSync(legacy), true, "the old directory is left for the operator");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores a legacy path that is not a checkout", () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "code-repos", "web"), { recursive: true });
    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("refuses to follow a symlinked legacy checkout", () => {
    const cwd = workspace();
    const outside = path.join(cwd, "elsewhere");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "code-repos"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, "code-repos", "web"));

    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(outside, ".git")), true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("does nothing when there is no legacy checkout at all", () => {
    const cwd = workspace();
    const target = path.join(cwd, "repositories", "web");
    assert.doesNotThrow(() => adoptLegacyCheckout(cwd, "web", target));
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ─────────── the trunk an employee checkout works from ──────────────────

/**
 * The employee's own checkout is model-writable and holds whatever an employee
 * left uncommitted between turns, so the sync that refreshes it is fetch-only.
 * That kept the tree safe and also kept it *still*: refs moved, the working
 * tree never did, and an employee asked to change a file could be reading code
 * from whenever it first cloned.
 *
 * {@link fastForwardEmployeeDefaultBranch} closes that gap under conditions
 * where closing it cannot cost anything. Most of these tests assert it does
 * nothing — that is the valuable half.
 */
describe("bringing an employee checkout's trunk up to date", () => {
  const codingTools = config.agent.codingTools as {
    enabled: boolean;
    executionMode: "host" | "bubblewrap" | "disabled";
    allowUnsafeHostExecution: boolean;
  };
  const originalCodingTools = { ...codingTools };

  // The materializer runs Git over a model-writable tree, which is gated on a
  // coding runtime. Make the host access these fixtures need explicit.
  before(() => {
    codingTools.enabled = true;
    codingTools.executionMode = "host";
    codingTools.allowUnsafeHostExecution = true;
  });

  after(() => {
    Object.assign(codingTools, originalCodingTools);
  });

  const exec = promisify(execFile);
  const roots: string[] = [];

  after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (args: string[], cwd: string) =>
    exec("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });

  function repositoryRow(overrides: Partial<Repository> = {}): Repository {
    return { defaultBranch: "main", ...overrides } as Repository;
  }

  /**
   * A workspace holding an employee checkout whose `origin` is one commit
   * ahead — exactly the state a fetch-only sync leaves behind.
   */
  async function behindCheckout(): Promise<{
    workspaceRoot: string;
    repoPath: string;
    upstream: string;
    head: () => Promise<string>;
  }> {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-employee-sync-"));
    roots.push(workspaceRoot);
    const origin = path.join(workspaceRoot, "origin.git");
    const seed = path.join(workspaceRoot, "seed");
    const repoPath = path.join(workspaceRoot, "repositories", "web");

    fs.mkdirSync(seed, { recursive: true });
    await git(["init", "--quiet", "--bare", "--initial-branch=main", origin], workspaceRoot);
    await git(["init", "--quiet", "--initial-branch=main"], seed);
    await git(["remote", "add", "origin", origin], seed);
    fs.writeFileSync(path.join(seed, "app.ts"), "export const version = 1;\n");
    await git(["add", "-A"], seed);
    await git(["commit", "--quiet", "-m", "First"], seed);
    await git(["push", "--quiet", "origin", "main"], seed);

    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    await git(["clone", "--quiet", origin, repoPath], workspaceRoot);

    // A colleague ships something after the employee's clone.
    fs.writeFileSync(path.join(seed, "app.ts"), "export const version = 2;\n");
    await git(["add", "-A"], seed);
    await git(["commit", "--quiet", "-m", "Second"], seed);
    await git(["push", "--quiet", "origin", "main"], seed);
    const { stdout } = await git(["rev-parse", "HEAD"], seed);

    // The fetch the materializer already did before this function is reached.
    await git(["fetch", "--quiet", "origin"], repoPath);

    return {
      workspaceRoot,
      repoPath,
      upstream: stdout.trim(),
      head: async () => (await git(["rev-parse", "HEAD"], repoPath)).stdout.trim(),
    };
  }

  test("advances a clean checkout sitting on the default branch", async () => {
    const fixture = await behindCheckout();
    assert.notEqual(await fixture.head(), fixture.upstream, "the fixture must start behind");

    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );

    assert.equal(await fixture.head(), fixture.upstream);
    assert.equal(
      fs.readFileSync(path.join(fixture.repoPath, "app.ts"), "utf8"),
      "export const version = 2;\n",
      "the working tree, not just the ref",
    );
  });

  test("leaves an uncommitted change alone, however stale that makes the tree", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    fs.writeFileSync(path.join(fixture.repoPath, "app.ts"), "export const version = 99;\n");

    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );

    assert.equal(await fixture.head(), stale);
    assert.equal(
      fs.readFileSync(path.join(fixture.repoPath, "app.ts"), "utf8"),
      "export const version = 99;\n",
      "an employee's work in progress is not this function's to discard",
    );
  });

  test("leaves an untracked file's tree alone too", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    fs.writeFileSync(path.join(fixture.repoPath, "scratch.md"), "half an idea\n");

    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );

    assert.equal(await fixture.head(), stale, "an untracked file is still work in progress");
    assert.equal(fs.existsSync(path.join(fixture.repoPath, "scratch.md")), true);
  });

  test("leaves a checkout the employee moved to another branch alone", async () => {
    const fixture = await behindCheckout();
    await git(["switch", "--quiet", "--create", "feature/thing"], fixture.repoPath);
    const stale = await fixture.head();

    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );

    assert.equal(await fixture.head(), stale);
    const { stdout } = await git(["symbolic-ref", "--short", "HEAD"], fixture.repoPath);
    assert.equal(stdout.trim(), "feature/thing", "switching branches under an employee is worse");
  });

  test("leaves a diverged trunk alone rather than resolving it", async () => {
    const fixture = await behindCheckout();
    fs.writeFileSync(path.join(fixture.repoPath, "local.ts"), "export const mine = 1;\n");
    await git(["add", "-A"], fixture.repoPath);
    await git(["commit", "--quiet", "-m", "Employee commit"], fixture.repoPath);
    const local = await fixture.head();

    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );

    assert.equal(await fixture.head(), local, "--ff-only refuses, and that refusal is the point");
  });

  test("does nothing when the remote has no such branch", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow({ defaultBranch: "release-2019" }),
    );
    assert.equal(await fixture.head(), stale);
  });

  test("does nothing when the repository row has no default branch", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow({ defaultBranch: "" }),
    );
    assert.equal(await fixture.head(), stale);
  });

  test("never lets a stored branch name reach Git as an option", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await assert.doesNotReject(() =>
      fastForwardEmployeeDefaultBranch(
        fixture.workspaceRoot,
        fixture.repoPath,
        repositoryRow({ defaultBranch: "--upload-pack=touch /tmp/genosyn-pwned" }),
      ),
    );
    assert.equal(await fixture.head(), stale);
    assert.equal(fs.existsSync("/tmp/genosyn-pwned"), false);
  });

  test("is a no-op on a checkout that is already current", async () => {
    const fixture = await behindCheckout();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );
    const current = await fixture.head();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow(),
    );
    assert.equal(await fixture.head(), current);
  });
});
