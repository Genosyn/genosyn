import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Repository } from "../db/entities/Repository.js";
import {
  ForgeApiError,
  GITHUB_ENDPOINT,
  forgejoEndpoint,
} from "../integrations/providers/forge/client.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { decryptConnectionConfig, encryptConnectionConfig } from "./integrations.js";
import {
  connectionsById,
  createForgePullRequest,
  createForgeRepository,
  describeRepositoryForge,
  findConnectionForRemote,
  findOpenForgePullRequest,
  forgeDefaultBranch,
  getForgePullRequest,
  listForgeConnections,
  loadForgeCandidates,
  matchForgeRemote,
  resolveConnectionForRemote,
  resolveConnectionToken,
  resolveForgeRemote,
} from "./repositoryForge.js";

/**
 * Which forge a Repository lives on, which Connection may speak for it, and
 * what the forge is told.
 *
 * The resolver half is the part with teeth. It decides whether a company's
 * token is allowed to reach a host, and it replaced a `hostname === "github.com"`
 * comparison that was simultaneously the host check, the "can we authenticate
 * this" check and the "is there exactly one answer" check. Splitting those
 * three apart is what makes a second forge possible and is also the easiest
 * thing in this feature to quietly break: a careless change makes every
 * github.com repository ambiguous the moment a company connects a Forgejo, or
 * — far worse — lets a Connection for one host answer for another.
 *
 * The API half is stubbed at `fetch`. What is worth pinning there is the
 * per-flavor divergence: two different auth headers, two different page-size
 * parameters, and a pull-request lookup GitHub can express as a filter and
 * Forgejo cannot.
 */

const FORGEJO_ENDPOINT = forgejoEndpoint("https://git.acme.com");

const originalFetch = globalThis.fetch;

before(initTestDb);
after(closeTestDb);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let companyId: string;
let repoCounter = 0;

beforeEach(async () => {
  await resetTestDb();
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "user_owner" });
  companyId = company.id;
});

// ───────────────────────────── fixtures ────────────────────────────────────

async function connect(args: {
  provider?: string;
  label?: string;
  authMode?: IntegrationConnection["authMode"];
  status?: IntegrationConnection["status"];
  accountHint?: string;
  config?: Record<string, unknown>;
  /** Set directly to plant a row whose config cannot be decrypted. */
  encryptedConfig?: string;
  companyId?: string;
}): Promise<IntegrationConnection> {
  const owner = args.companyId ?? companyId;
  return insert(IntegrationConnection, {
    companyId: owner,
    provider: args.provider ?? "github",
    label: args.label ?? "",
    authMode: args.authMode ?? "apikey",
    status: args.status ?? "connected",
    accountHint: args.accountHint ?? "",
    encryptedConfig:
      args.encryptedConfig ?? encryptConnectionConfig(args.config ?? { apiKey: "t" }, owner),
  });
}

function githubConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { apiKey: "ghp_token", login: "acme", repos: [], ...overrides };
}

function forgejoConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: "https://git.acme.com",
    apiKey: "forgejo_token",
    login: "ada",
    repos: [],
    ...overrides,
  };
}

async function repository(values: Partial<Repository> = {}): Promise<Repository> {
  repoCounter += 1;
  return insert(Repository, {
    companyId,
    name: `Repo ${repoCounter}`,
    slug: `repo-${repoCounter}`,
    description: "",
    origin: "remote",
    kind: "code",
    gitUrl: "https://github.com/acme/web.git",
    defaultBranch: "main",
    authMode: "none",
    lastSyncStatus: "unknown",
    lastSyncError: "",
    ...values,
  });
}

// ────────────────────────── fetch stubbing ─────────────────────────────────

type ForgeCall = { url: URL; method: string; body: unknown; headers: Headers };

function json(value: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  const text = String(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Install a fetch stub and return the calls it recorded, in order. */
function record(responder: (call: ForgeCall) => Response | Promise<Response>): ForgeCall[] {
  const calls: ForgeCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: ForgeCall = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: parseBody(init?.body),
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return calls;
}

// ─────────────────────── remote → forge resolution ─────────────────────────

describe("matchForgeRemote — which remotes a forge will answer for", () => {
  test("resolves a github.com remote with no Connection at all, so a repository carrying its own token still works", async () => {
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });
    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));

    assert.ok(match);
    assert.equal(match.provider, "github");
    assert.deepEqual(match.endpoint, GITHUB_ENDPOINT);
    assert.deepEqual(match.remote, { owner: "acme", repo: "web" });
    assert.deepEqual(match.connections, []);
    assert.equal(match.connection, null);
    // Not ambiguous: there is nothing to choose between. A caller with its own
    // HTTPS token opens a pull request from here.
    assert.equal(match.ambiguous, false);
  });

  test("accepts the github.com URL shapes a clone hands out", async () => {
    const candidates = await loadForgeCandidates(companyId);
    for (const [gitUrl, expected] of [
      ["https://github.com/acme/web.git", { owner: "acme", repo: "web" }],
      ["https://github.com/acme/web", { owner: "acme", repo: "web" }],
      // The host is case-insensitive; the owner and repository are not, and
      // are handed to the API exactly as stored.
      ["https://GitHub.com/Acme/Web.git", { owner: "Acme", repo: "Web" }],
    ] as const) {
      const match = matchForgeRemote(await repository({ gitUrl }), candidates);
      assert.deepEqual(match?.remote, expected, gitUrl);
    }
  });

  test("refuses every remote a github.com token must not be sent to", async () => {
    const candidates = await loadForgeCandidates(companyId);
    for (const gitUrl of [
      // SSH remotes: an API token cannot authenticate them at all.
      "git@github.com:acme/web.git",
      "ssh://git@github.com/acme/web.git",
      // Plain http would put the token on the wire in cleartext.
      "http://github.com/acme/web.git",
      "https://gitlab.com/acme/web.git",
      "https://github.example.com/acme/web.git",
      "https://notgithub.com/acme/web.git",
      // github.com appearing somewhere other than the origin.
      "https://evil.example/github.com/acme/web.git",
      "https://github.com.evil.example/acme/web.git",
      // Not owner/repo at all.
      "https://github.com/acme",
      "https://github.com/acme/web/tree/main",
      // A Repository created inside Genosyn and never pushed anywhere.
      "",
      "not a url",
    ]) {
      const match = matchForgeRemote(await repository({ gitUrl }), candidates);
      assert.equal(match, null, gitUrl);
    }
  });

  test("resolves a Forgejo remote only because a Connection's base URL covers it", async () => {
    const unresolved = await repository({ gitUrl: "https://git.acme.com/team/web.git" });
    assert.equal(
      matchForgeRemote(unresolved, await loadForgeCandidates(companyId)),
      null,
      "an unconfigured host is a plain git remote with no API",
    );

    const connection = await connect({ provider: "forgejo", config: forgejoConfig() });
    const match = matchForgeRemote(unresolved, await loadForgeCandidates(companyId));

    assert.ok(match);
    assert.equal(match.provider, "forgejo");
    assert.equal(match.endpoint.apiBase, "https://git.acme.com/api/v1");
    assert.deepEqual(match.remote, { owner: "team", repo: "web" });
    assert.equal(match.connection?.id, connection.id);
    assert.equal(match.ambiguous, false);
  });

  test("reads owner and repo past the mount point of a sub-path Forgejo install", async () => {
    await connect({
      provider: "forgejo",
      config: forgejoConfig({ baseUrl: "https://example.com/git" }),
    });
    const repo = await repository({ gitUrl: "https://example.com/git/team/web.git" });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    // Reading the first two path segments would give `git/team`, a
    // plausible-looking owner and repository that no forge has heard of.
    assert.deepEqual(match?.remote, { owner: "team", repo: "web" });
  });

  test("tolerates a stored base URL with a trailing slash, which is how people paste them", async () => {
    await connect({
      provider: "forgejo",
      config: forgejoConfig({ baseUrl: "https://git.acme.com/" }),
    });
    const repo = await repository({ gitUrl: "https://git.acme.com/team/web.git" });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    assert.deepEqual(match?.remote, { owner: "team", repo: "web" });
    assert.equal(match?.endpoint.apiBase, "https://git.acme.com/api/v1");
  });

  test("will not let a Connection on one port answer for the same host on another", async () => {
    await connect({
      provider: "forgejo",
      config: forgejoConfig({ baseUrl: "https://git.acme.com:8443" }),
    });
    const candidates = await loadForgeCandidates(companyId);

    const onPort = await repository({ gitUrl: "https://git.acme.com:8443/team/web.git" });
    assert.deepEqual(matchForgeRemote(onPort, candidates)?.remote, { owner: "team", repo: "web" });

    const defaultPort = await repository({ gitUrl: "https://git.acme.com/team/web.git" });
    assert.equal(matchForgeRemote(defaultPort, candidates), null);
  });

  test("a second forge does not make the first one ambiguous, in either direction", async () => {
    const github = await connect({ provider: "github", config: githubConfig() });
    const forgejo = await connect({ provider: "forgejo", config: forgejoConfig() });
    const candidates = await loadForgeCandidates(companyId);
    assert.equal(candidates.length, 2);

    const onGithub = matchForgeRemote(
      await repository({ gitUrl: "https://github.com/acme/web.git" }),
      candidates,
    );
    assert.equal(onGithub?.connection?.id, github.id);
    assert.equal(onGithub?.ambiguous, false);
    assert.deepEqual(
      onGithub?.connections.map((row) => row.id),
      [github.id],
      "the Forgejo Connection is not a candidate for a github.com remote",
    );

    const onForgejo = matchForgeRemote(
      await repository({ gitUrl: "https://git.acme.com/team/web.git" }),
      candidates,
    );
    assert.equal(onForgejo?.connection?.id, forgejo.id);
    assert.equal(onForgejo?.ambiguous, false);
    assert.deepEqual(
      onForgejo?.connections.map((row) => row.id),
      [forgejo.id],
    );
  });

  test("two Connections on one host with no pin refuse to guess", async () => {
    const first = await connect({ provider: "github", label: "Personal", config: githubConfig() });
    const second = await connect({ provider: "github", label: "Work", config: githubConfig() });
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    assert.ok(match);
    assert.equal(match.ambiguous, true);
    assert.equal(
      match.connection,
      null,
      "guessing which account pushes the company's code is not a default",
    );
    assert.deepEqual(
      match.connections.map((row) => row.id).sort(),
      [first.id, second.id].sort(),
      "both candidates are reported so the caller can offer a choice",
    );
  });

  test("a pin picks one of two Connections on the same host", async () => {
    await connect({ provider: "github", label: "Personal", config: githubConfig() });
    const work = await connect({ provider: "github", label: "Work", config: githubConfig() });
    const repo = await repository({
      gitUrl: "https://github.com/acme/web.git",
      githubConnectionId: work.id,
    });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    assert.equal(match?.connection?.id, work.id);
    assert.equal(match?.ambiguous, false);
    assert.equal(match?.connections.length, 2);
  });

  test("a pin naming a deleted Connection falls back to the sole candidate", async () => {
    const survivor = await connect({ provider: "github", config: githubConfig() });
    const repo = await repository({
      gitUrl: "https://github.com/acme/web.git",
      githubConnectionId: "connection-that-was-deleted",
    });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    assert.equal(match?.connection?.id, survivor.id);
    assert.equal(match?.ambiguous, false);
  });

  test("a pin naming a deleted Connection falls back to ambiguous when there is still a choice", async () => {
    await connect({ provider: "github", label: "Personal", config: githubConfig() });
    await connect({ provider: "github", label: "Work", config: githubConfig() });
    const repo = await repository({
      gitUrl: "https://github.com/acme/web.git",
      githubConnectionId: "connection-that-was-deleted",
    });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    assert.equal(match?.connection, null);
    assert.equal(match?.ambiguous, true);
  });

  test("a pin on a Connection for a different host does not authenticate this remote", async () => {
    const forgejo = await connect({ provider: "forgejo", config: forgejoConfig() });
    const github = await connect({ provider: "github", config: githubConfig() });
    const repo = await repository({
      gitUrl: "https://github.com/acme/web.git",
      githubConnectionId: forgejo.id,
    });

    const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
    // The pin is ignored rather than honoured: it names a server that has
    // never heard of this repository, and its token must not go to github.com.
    assert.equal(match?.connection?.id, github.id);
    assert.equal(match?.ambiguous, false);
  });
});

describe("loadForgeCandidates — which Connections are even eligible", () => {
  test("skips a Connection whose stored config cannot produce an endpoint instead of throwing", async () => {
    const usable = await connect({ provider: "forgejo", config: forgejoConfig() });
    // Restored from an old backup, or a connect that half-finished.
    await connect({ provider: "forgejo", config: { apiKey: "orphan" } });
    await connect({ provider: "forgejo", config: forgejoConfig({ baseUrl: "not a url" }) });
    await connect({ provider: "github", encryptedConfig: "not-a-ciphertext" });

    const candidates = await loadForgeCandidates(companyId);
    assert.deepEqual(
      candidates.map((entry) => entry.connection.id),
      [usable.id],
    );
  });

  test("ignores Connections that are not connected, not a forge, or not this company's", async () => {
    await connect({ provider: "github", status: "error", config: githubConfig() });
    await connect({ provider: "github", status: "expired", config: githubConfig() });
    await connect({ provider: "slack", config: { apiKey: "xoxb" } });
    await connect({ provider: "github", companyId: "co_someone_else", config: githubConfig() });

    assert.deepEqual(await loadForgeCandidates(companyId), []);
  });
});

describe("resolveForgeRemote", () => {
  test("loads the company's Connections itself and matches against them", async () => {
    const connection = await connect({ provider: "forgejo", config: forgejoConfig() });
    const repo = await repository({ gitUrl: "https://git.acme.com/team/web.git" });

    const match = await resolveForgeRemote(repo);
    assert.equal(match?.connection?.id, connection.id);
    assert.equal(match?.provider, "forgejo");
  });

  test("does not see another company's Connections", async () => {
    await connect({ provider: "forgejo", config: forgejoConfig(), companyId: "co_other" });
    const repo = await repository({ gitUrl: "https://git.acme.com/team/web.git" });

    assert.equal(await resolveForgeRemote(repo), null);
  });
});

// ───────────────────── what the browser is told ────────────────────────────

describe("describeRepositoryForge — the answer the pull-request button reads", () => {
  test("reports a sole Connection as sole and a pinned one as pinned", async () => {
    const connection = await connect({ provider: "github", config: githubConfig() });
    const candidates = await loadForgeCandidates(companyId);

    const unpinned = await repository({ gitUrl: "https://github.com/acme/web.git" });
    assert.deepEqual(describeRepositoryForge(unpinned, candidates), {
      provider: "github",
      name: "GitHub",
      credential: "sole",
    });

    const pinned = await repository({
      gitUrl: "https://github.com/acme/web.git",
      githubConnectionId: connection.id,
    });
    assert.deepEqual(describeRepositoryForge(pinned, candidates), {
      provider: "github",
      name: "GitHub",
      credential: "pinned",
    });
  });

  test("reports two unpinned Connections as ambiguous rather than picking one", async () => {
    await connect({ provider: "forgejo", label: "Team", config: forgejoConfig() });
    await connect({ provider: "forgejo", label: "Platform", config: forgejoConfig() });
    const repo = await repository({ gitUrl: "https://git.acme.com/team/web.git" });

    assert.deepEqual(describeRepositoryForge(repo, await loadForgeCandidates(companyId)), {
      provider: "forgejo",
      name: "Forgejo",
      credential: "ambiguous",
    });
  });

  test("reports a github.com remote with no Connection as none — a button, not an error", async () => {
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });

    assert.deepEqual(describeRepositoryForge(repo, await loadForgeCandidates(companyId)), {
      provider: "github",
      name: "GitHub",
      credential: "none",
    });
  });

  test("answers null for a host no Connection covers, so no button is offered", async () => {
    await connect({ provider: "github", config: githubConfig() });
    const candidates = await loadForgeCandidates(companyId);

    for (const gitUrl of ["https://git.acme.com/team/web.git", "git@github.com:acme/web.git", ""]) {
      assert.equal(describeRepositoryForge(await repository({ gitUrl }), candidates), null, gitUrl);
    }
  });
});

// ──────────────── the Connection that authenticates git ────────────────────

describe("findConnectionForRemote / resolveConnectionForRemote", () => {
  test("answers nothing for a repository that carries its own credential", async () => {
    await connect({ provider: "github", config: githubConfig() });
    for (const authMode of ["https", "ssh"] as const) {
      const repo = await repository({
        gitUrl: "https://github.com/acme/web.git",
        authMode,
        httpsUsername: "x-access-token",
      });
      assert.equal(await findConnectionForRemote(repo), null, authMode);
      assert.deepEqual(await resolveConnectionForRemote(repo), { kind: "none" }, authMode);
    }
  });

  test("returns the sole Connection for the remote", async () => {
    const connection = await connect({ provider: "github", config: githubConfig() });
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });

    assert.equal((await findConnectionForRemote(repo))?.id, connection.id);
    const resolved = await resolveConnectionForRemote(repo);
    assert.equal(resolved.kind, "one");
    assert.equal(resolved.kind === "one" ? resolved.connection.id : null, connection.id);
  });

  test("distinguishes 'connect one' from 'you connected two' so the advice can differ", async () => {
    const first = await connect({ provider: "github", label: "Personal", config: githubConfig() });
    const second = await connect({ provider: "github", label: "Work", config: githubConfig() });
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });

    // Telling someone with two Connections to connect GitHub is advice that
    // cannot possibly help them.
    assert.equal(await findConnectionForRemote(repo), null);
    const resolved = await resolveConnectionForRemote(repo);
    assert.equal(resolved.kind, "ambiguous");
    assert.deepEqual(
      resolved.kind === "ambiguous" ? resolved.connections.map((row) => row.id).sort() : [],
      [first.id, second.id].sort(),
    );
  });

  test("reports none for a github.com remote nobody has connected", async () => {
    const repo = await repository({ gitUrl: "https://github.com/acme/web.git" });

    assert.equal(await findConnectionForRemote(repo), null);
    assert.deepEqual(await resolveConnectionForRemote(repo), { kind: "none" });
  });

  test("reports none for a host no Connection covers", async () => {
    await connect({ provider: "github", config: githubConfig() });
    const repo = await repository({ gitUrl: "https://git.acme.com/team/web.git" });

    assert.equal(await findConnectionForRemote(repo), null);
    assert.deepEqual(await resolveConnectionForRemote(repo), { kind: "none" });
  });
});

// ───────────────────────── the connect picker ──────────────────────────────

describe("listForgeConnections", () => {
  test("falls back to the forge's name when a Connection was never labelled", async () => {
    await connect({ provider: "github", label: "", config: githubConfig() });
    await connect({ provider: "forgejo", label: "", config: forgejoConfig() });

    const byProvider = new Map(
      (await listForgeConnections(companyId)).map((option) => [option.provider, option]),
    );
    assert.equal(byProvider.get("github")?.label, "GitHub");
    assert.equal(byProvider.get("github")?.providerName, "GitHub");
    assert.equal(byProvider.get("forgejo")?.label, "Forgejo");
    assert.equal(byProvider.get("forgejo")?.providerName, "Forgejo");
  });

  test("keeps a label somebody chose", async () => {
    await connect({ provider: "forgejo", label: "Platform team", config: forgejoConfig() });

    const [option] = await listForgeConnections(companyId);
    assert.equal(option.label, "Platform team");
  });

  test("names the host, which is the only thing telling two Forgejo Connections apart", async () => {
    await connect({ provider: "github", config: githubConfig() });
    await connect({
      provider: "forgejo",
      label: "Internal",
      config: forgejoConfig({ baseUrl: "https://git.acme.com" }),
    });
    await connect({
      provider: "forgejo",
      label: "Lab",
      config: forgejoConfig({ baseUrl: "https://git.lab.acme.com:8443/forge" }),
    });

    const byLabel = new Map(
      (await listForgeConnections(companyId)).map((option) => [option.label, option.host]),
    );
    assert.deepEqual(Object.fromEntries(byLabel), {
      GitHub: "github.com",
      Internal: "git.acme.com",
      Lab: "git.lab.acme.com:8443",
    });
  });

  test("takes the account from the config, then the account hint, then gives up", async () => {
    await connect({ provider: "github", label: "Login", config: githubConfig({ login: "ada" }) });
    await connect({
      provider: "github",
      label: "Account",
      config: { apiKey: "t", account: "acme-org" },
    });
    await connect({
      provider: "github",
      label: "Hint",
      config: { apiKey: "t" },
      accountHint: "ada@example.com",
    });
    await connect({ provider: "github", label: "Nothing", config: { apiKey: "t" } });

    const byLabel = new Map(
      (await listForgeConnections(companyId)).map((option) => [option.label, option.accountLogin]),
    );
    assert.deepEqual(Object.fromEntries(byLabel), {
      Login: "ada",
      Account: "acme-org",
      Hint: "ada@example.com",
      Nothing: null,
    });
  });

  test("one unreadable Connection does not take the rest of the list down with it", async () => {
    await connect({ provider: "github", label: "Good", config: githubConfig() });
    // Encrypted under a key ring this instance no longer has.
    await connect({ provider: "github", label: "Unreadable", encryptedConfig: "v2.bogus" });

    const options = await listForgeConnections(companyId);
    assert.deepEqual(
      options.map((option) => option.label),
      ["Good"],
    );
  });

  test("lists only this company's connected forge Connections", async () => {
    await connect({ provider: "github", label: "Mine", config: githubConfig() });
    await connect({ provider: "github", label: "Broken", status: "error", config: githubConfig() });
    await connect({ provider: "slack", label: "Slack", config: { apiKey: "xoxb" } });
    await connect({
      provider: "github",
      label: "Theirs",
      companyId: "co_other",
      config: githubConfig(),
    });

    const options = await listForgeConnections(companyId);
    assert.deepEqual(
      options.map((option) => option.label),
      ["Mine"],
    );
  });
});

// ────────────────────────── credential resolution ──────────────────────────

describe("resolveConnectionToken", () => {
  test("hands back the token, the login and where to send them, per provider", async () => {
    const github = await connect({
      provider: "github",
      config: githubConfig({ apiKey: "ghp_live", login: "acme" }),
    });
    const resolvedGithub = await resolveConnectionToken(github);
    assert.equal(resolvedGithub.token, "ghp_live");
    assert.equal(resolvedGithub.login, "acme");
    assert.equal(resolvedGithub.provider, "github");
    assert.deepEqual(resolvedGithub.endpoint, GITHUB_ENDPOINT);

    const forgejo = await connect({
      provider: "forgejo",
      config: forgejoConfig({ apiKey: "forgejo_live", login: "ada" }),
    });
    const resolvedForgejo = await resolveConnectionToken(forgejo);
    assert.equal(resolvedForgejo.token, "forgejo_live");
    assert.equal(resolvedForgejo.login, "ada");
    assert.equal(resolvedForgejo.provider, "forgejo");
    assert.deepEqual(resolvedForgejo.endpoint, {
      flavor: "forgejo",
      apiBase: "https://git.acme.com/api/v1",
      webBase: "https://git.acme.com",
    });
  });

  test("refuses a Connection that is not a git forge, and says which one", async () => {
    const slack = await connect({
      provider: "slack",
      label: "Acme Slack",
      config: { apiKey: "xoxb" },
    });
    await assert.rejects(
      () => resolveConnectionToken(slack),
      /Acme Slack is not a git forge Connection/,
    );

    const unlabelled = await connect({ provider: "stripe", label: "", config: { apiKey: "sk" } });
    await assert.rejects(() => resolveConnectionToken(unlabelled), /stripe is not a git forge/);
  });

  test("names the forge when a Connection has no usable credential", async () => {
    const github = await connect({ provider: "github", config: { login: "acme" } });
    await assert.rejects(
      () => resolveConnectionToken(github),
      /That GitHub Connection is missing its credentials\. Reconnect it from Settings/,
    );

    const forgejo = await connect({
      provider: "forgejo",
      config: { baseUrl: "https://git.acme.com" },
    });
    await assert.rejects(
      () => resolveConnectionToken(forgejo),
      /That Forgejo Connection is missing its credentials/,
    );
  });

  test("refuses a token carrying a line break rather than letting it reach a credential helper", async () => {
    const connection = await connect({
      provider: "forgejo",
      config: forgejoConfig({ apiKey: "token\nprotocol=https" }),
    });
    await assert.rejects(() => resolveConnectionToken(connection), /invalid line break/);
  });

  test("persists a rotated OAuth credential so the next call does not refresh again", async () => {
    const connection = await connect({
      provider: "github",
      authMode: "oauth2",
      config: {
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "expiring-token",
        refreshToken: "refresh-1",
        // Inside the one-minute window that triggers a refresh.
        expiresAt: Date.now() + 5_000,
        scope: "repo",
        login: "ada",
        userId: 7,
        repos: [],
      },
    });
    const priorConfig = connection.encryptedConfig;
    const calls = record((call) => {
      assert.equal(call.url.href, "https://github.com/login/oauth/access_token");
      return json({
        access_token: "rotated-token",
        refresh_token: "refresh-2",
        expires_in: 28_800,
        scope: "repo",
      });
    });

    const resolved = await resolveConnectionToken(connection);
    assert.equal(calls.length, 1);
    assert.equal(resolved.token, "rotated-token");

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.notEqual(stored.encryptedConfig, priorConfig);
    const config = decryptConnectionConfig(stored) as { accessToken: string; refreshToken: string };
    assert.equal(config.accessToken, "rotated-token");
    assert.equal(config.refreshToken, "refresh-2");
  });

  test("leaves the stored config alone when nothing rotated", async () => {
    const connection = await connect({ provider: "forgejo", config: forgejoConfig() });
    const priorConfig = connection.encryptedConfig;

    await resolveConnectionToken(connection);

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(stored.encryptedConfig, priorConfig);
  });
});

describe("connectionsById", () => {
  test("hydrates the requested rows and nobody else's", async () => {
    const mine = await connect({ provider: "github", config: githubConfig() });
    const theirs = await connect({
      provider: "github",
      companyId: "co_other",
      config: githubConfig(),
    });

    const found = await connectionsById(companyId, [mine.id, mine.id, theirs.id, ""]);
    assert.deepEqual([...found.keys()], [mine.id]);
    assert.equal(found.get(mine.id)?.id, mine.id);
  });

  test("returns an empty map when every id is blank", async () => {
    assert.equal((await connectionsById(companyId, [])).size, 0);
    assert.equal((await connectionsById(companyId, ["", ""])).size, 0);
  });
});

// ───────────────────────────── forge API calls ─────────────────────────────

describe("forgeDefaultBranch", () => {
  test("asks GitHub for the trunk with GitHub's headers", async () => {
    const calls = record(() => json({ default_branch: "trunk" }));

    assert.equal(await forgeDefaultBranch(GITHUB_ENDPOINT, "ghp_x", "acme", "web"), "trunk");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, "https://api.github.com/repos/acme/web");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.get("authorization"), "Bearer ghp_x");
    assert.equal(calls[0].headers.get("accept"), "application/vnd.github+json");
    assert.equal(calls[0].headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(calls[0].headers.get("user-agent"), "genosyn");
  });

  test("asks Forgejo under /api/v1 with Forgejo's token header", async () => {
    const calls = record(() => json({ default_branch: "master" }));

    assert.equal(await forgeDefaultBranch(FORGEJO_ENDPOINT, "fj_x", "team", "web"), "master");
    assert.equal(calls[0].url.href, "https://git.acme.com/api/v1/repos/team/web");
    // Forgejo's own swagger documents `token <t>`; `Bearer` only works on
    // recent versions, and self-hosters run whatever they run.
    assert.equal(calls[0].headers.get("authorization"), "token fj_x");
    assert.equal(calls[0].headers.get("accept"), "application/json");
    assert.equal(calls[0].headers.get("x-github-api-version"), null);
  });

  test("encodes an owner and repository that need it", async () => {
    const calls = record(() => json({ default_branch: "main" }));

    await forgeDefaultBranch(FORGEJO_ENDPOINT, "fj_x", "acme labs", "web/api");
    assert.equal(calls[0].url.pathname, "/api/v1/repos/acme%20labs/web%2Fapi");
  });

  test("answers null rather than throwing, because the row's own value is a usable fallback", async () => {
    record(() => json({ message: "Not Found" }, 404, "Not Found"));
    assert.equal(await forgeDefaultBranch(GITHUB_ENDPOINT, "ghp_x", "acme", "web"), null);

    for (const payload of [{}, { default_branch: "" }, { default_branch: 7 }, []]) {
      record(() => json(payload));
      assert.equal(
        await forgeDefaultBranch(FORGEJO_ENDPOINT, "fj_x", "team", "web"),
        null,
        JSON.stringify(payload),
      );
    }
  });
});

describe("createForgePullRequest", () => {
  for (const endpoint of [GITHUB_ENDPOINT, FORGEJO_ENDPOINT]) {
    test(`posts the branch, base, title and body to ${endpoint.flavor}`, async () => {
      const calls = record(() =>
        json({ number: 12, html_url: `${endpoint.webBase}/acme/web/pulls/12`, state: "open" }),
      );

      const pr = await createForgePullRequest(endpoint, "token-1", {
        owner: "acme",
        repo: "web",
        head: "genosyn/ada/fix",
        base: "main",
        title: "Fix the thing",
        body: "Opened by Ada.",
      });

      assert.deepEqual(pr, {
        number: 12,
        htmlUrl: `${endpoint.webBase}/acme/web/pulls/12`,
        state: "open",
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.href, `${endpoint.apiBase}/repos/acme/web/pulls`);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].headers.get("content-type"), "application/json");
      assert.deepEqual(calls[0].body, {
        title: "Fix the thing",
        body: "Opened by Ada.",
        head: "genosyn/ada/fix",
        base: "main",
      });
    });
  }

  test("defaults a missing state to open rather than reporting an empty one", async () => {
    record(() => json({ number: 3, html_url: "https://github.com/acme/web/pull/3" }));

    const pr = await createForgePullRequest(GITHUB_ENDPOINT, "t", {
      owner: "acme",
      repo: "web",
      head: "topic",
      base: "main",
      title: "T",
      body: "",
    });
    assert.equal(pr.state, "open");
  });

  test("refuses a payload with no number or URL instead of returning a broken link", async () => {
    for (const payload of [{}, { number: 3 }, { html_url: "https://git.acme.com/x/y/pulls/3" }]) {
      record(() => json(payload));
      await assert.rejects(
        () =>
          createForgePullRequest(FORGEJO_ENDPOINT, "t", {
            owner: "team",
            repo: "web",
            head: "topic",
            base: "main",
            title: "T",
            body: "",
          }),
        /Forgejo did not return a usable pull request/,
        JSON.stringify(payload),
      );
    }
  });
});

describe("getForgePullRequest", () => {
  test("fetches one pull request by number on either forge", async () => {
    for (const endpoint of [GITHUB_ENDPOINT, FORGEJO_ENDPOINT]) {
      const calls = record(() =>
        json({ number: 41, html_url: `${endpoint.webBase}/acme/web/pulls/41`, state: "closed" }),
      );

      const pr = await getForgePullRequest(endpoint, "t", {
        owner: "acme",
        repo: "web",
        number: 41,
      });
      assert.equal(pr?.number, 41);
      assert.equal(pr?.state, "closed");
      assert.equal(calls[0].url.href, `${endpoint.apiBase}/repos/acme/web/pulls/41`);
      assert.equal(calls[0].method, "GET");
    }
  });

  test("answers null for a pull request that is gone or unreadable", async () => {
    record(() => json({ message: "Not Found" }, 404, "Not Found"));
    assert.equal(
      await getForgePullRequest(GITHUB_ENDPOINT, "t", { owner: "acme", repo: "web", number: 9 }),
      null,
    );

    record(() => json({ number: "nine" }));
    assert.equal(
      await getForgePullRequest(GITHUB_ENDPOINT, "t", { owner: "acme", repo: "web", number: 9 }),
      null,
    );
  });
});

describe("findOpenForgePullRequest — pressing the button twice must update, not fail", () => {
  test("uses the number the session recorded and asks nothing else", async () => {
    const calls = record(() =>
      json({ number: 21, html_url: "https://github.com/acme/web/pull/21", state: "open" }),
    );

    const pr = await findOpenForgePullRequest(GITHUB_ENDPOINT, "t", {
      owner: "acme",
      repo: "web",
      head: "topic",
      number: 21,
    });

    assert.equal(pr?.number, 21);
    // The by-number lookup is the only one that works for a credential that
    // may open a pull request but may not list them.
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      ["/repos/acme/web/pulls/21"],
    );
  });

  test("falls through to the list when the recorded pull request has been closed", async () => {
    const calls = record((call) => {
      if (call.url.pathname.endsWith("/pulls/21")) {
        return json({
          number: 21,
          html_url: "https://git.acme.com/team/web/pulls/21",
          state: "closed",
        });
      }
      return json([
        {
          number: 30,
          html_url: "https://git.acme.com/team/web/pulls/30",
          state: "open",
          head: { ref: "other" },
        },
        {
          number: 31,
          html_url: "https://git.acme.com/team/web/pulls/31",
          state: "open",
          head: { ref: "topic" },
        },
      ]);
    });

    const pr = await findOpenForgePullRequest(FORGEJO_ENDPOINT, "t", {
      owner: "team",
      repo: "web",
      head: "topic",
      number: 21,
    });

    assert.equal(pr?.number, 31, "a closed pull request cannot be updated; find the open one");
    assert.equal(calls.length, 2);
  });

  test("falls through to the list when the recorded number no longer resolves", async () => {
    const calls = record((call) => {
      if (call.url.pathname.endsWith("/pulls/21")) return json({ message: "Not Found" }, 404);
      return json([{ number: 32, html_url: "https://github.com/acme/web/pull/32", state: "open" }]);
    });

    const pr = await findOpenForgePullRequest(GITHUB_ENDPOINT, "t", {
      owner: "acme",
      repo: "web",
      head: "topic",
      number: 21,
    });
    assert.equal(pr?.number, 32);
    assert.equal(calls.length, 2);
  });

  test("filters GitHub's pull request list by owner:branch", async () => {
    const calls = record(() =>
      json([{ number: 5, html_url: "https://github.com/acme/web/pull/5", state: "open" }]),
    );

    const pr = await findOpenForgePullRequest(GITHUB_ENDPOINT, "t", {
      owner: "acme",
      repo: "web",
      head: "genosyn/ada/fix",
      number: null,
    });

    assert.equal(pr?.number, 5);
    assert.equal(calls[0].url.pathname, "/repos/acme/web/pulls");
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
      state: "open",
      head: "acme:genosyn/ada/fix",
    });
  });

  test("matches Forgejo's head branch here, because Forgejo has no head filter", async () => {
    const calls = record(() =>
      json([
        // No head at all: a malformed entry must not take the lookup down.
        { number: 40, html_url: "https://git.acme.com/team/web/pulls/40", state: "open" },
        {
          number: 41,
          html_url: "https://git.acme.com/team/web/pulls/41",
          state: "open",
          head: { ref: "genosyn/ada/fix-2" },
        },
        {
          number: 42,
          html_url: "https://git.acme.com/team/web/pulls/42",
          state: "open",
          head: { ref: "genosyn/ada/fix" },
        },
      ]),
    );

    const pr = await findOpenForgePullRequest(FORGEJO_ENDPOINT, "t", {
      owner: "team",
      repo: "web",
      head: "genosyn/ada/fix",
      number: null,
    });

    assert.equal(pr?.number, 42, "a prefix of the branch name is not the branch");
    assert.equal(calls[0].url.pathname, "/api/v1/repos/team/web/pulls");
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
      state: "open",
      // `limit`, not `per_page`: Forgejo ignores GitHub's name and would page
      // at its default, hiding an existing pull request behind the first page.
      limit: "100",
    });
    assert.equal(
      calls[0].url.searchParams.get("head"),
      null,
      "Forgejo has no head filter; sending one would be silently ignored",
    );
  });

  test("answers null when neither forge has an open pull request for the branch", async () => {
    record(() => json([]));
    assert.equal(
      await findOpenForgePullRequest(GITHUB_ENDPOINT, "t", {
        owner: "acme",
        repo: "web",
        head: "topic",
      }),
      null,
    );

    record(() =>
      json([
        {
          number: 1,
          html_url: "https://git.acme.com/team/web/pulls/1",
          state: "open",
          head: { ref: "other" },
        },
      ]),
    );
    assert.equal(
      await findOpenForgePullRequest(FORGEJO_ENDPOINT, "t", {
        owner: "team",
        repo: "web",
        head: "topic",
      }),
      null,
    );
  });

  test("answers null on a payload that is not a list", async () => {
    for (const payload of [{ ok: true, data: [] }, null, "nope"]) {
      record(() => json(payload));
      assert.equal(
        await findOpenForgePullRequest(FORGEJO_ENDPOINT, "t", {
          owner: "team",
          repo: "web",
          head: "topic",
        }),
        null,
        JSON.stringify(payload),
      );
    }
  });

  test("swallows a failed lookup, because it must not block the create call behind it", async () => {
    for (const endpoint of [GITHUB_ENDPOINT, FORGEJO_ENDPOINT]) {
      record(() => json({ message: "Resource not accessible by integration" }, 403, "Forbidden"));
      assert.equal(
        await findOpenForgePullRequest(endpoint, "t", {
          owner: "acme",
          repo: "web",
          head: "topic",
        }),
        null,
        endpoint.flavor,
      );
    }
  });
});

describe("createForgeRepository", () => {
  test("creates under the authenticated user when no owner is named", async () => {
    const calls = record(() =>
      json({
        clone_url: "https://github.com/ada/web.git",
        html_url: "https://github.com/ada/web",
        default_branch: "main",
      }),
    );

    const created = await createForgeRepository({
      endpoint: GITHUB_ENDPOINT,
      token: "ghp_x",
      name: "web",
      private: true,
    });

    assert.deepEqual(created, {
      gitUrl: "https://github.com/ada/web.git",
      htmlUrl: "https://github.com/ada/web",
      defaultBranch: "main",
    });
    assert.equal(calls[0].url.href, "https://api.github.com/user/repos");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, {
      name: "web",
      private: true,
      // Never auto-initialised: an initial commit on the remote turns the
      // push of the existing history into a non-fast-forward nobody here can
      // resolve.
      auto_init: false,
    });
  });

  test("creates under an organisation when one is named, on either forge", async () => {
    for (const endpoint of [GITHUB_ENDPOINT, FORGEJO_ENDPOINT]) {
      const calls = record(() => json({ clone_url: `${endpoint.webBase}/acme labs/web.git` }));

      await createForgeRepository({
        endpoint,
        token: "t",
        name: "web",
        owner: "acme labs",
        private: false,
        description: "The website",
      });

      assert.equal(calls[0].url.href, `${endpoint.apiBase}/orgs/acme%20labs/repos`);
      assert.deepEqual(calls[0].body, {
        name: "web",
        private: false,
        description: "The website",
        auto_init: false,
      });
    }
  });

  test("treats a blank owner as no owner rather than creating an org called nothing", async () => {
    for (const owner of ["", "   ", null, undefined]) {
      const calls = record(() => json({ clone_url: "https://github.com/ada/web.git" }));
      await createForgeRepository({
        endpoint: GITHUB_ENDPOINT,
        token: "t",
        name: "web",
        owner,
        private: false,
      });
      assert.equal(calls[0].url.pathname, "/user/repos", JSON.stringify(owner));
    }
  });

  test("keeps the description out of the body when there is none", async () => {
    const calls = record(() => json({ clone_url: "https://github.com/ada/web.git" }));

    await createForgeRepository({
      endpoint: GITHUB_ENDPOINT,
      token: "t",
      name: "web",
      private: false,
      description: "",
    });
    assert.deepEqual(calls[0].body, { name: "web", private: false, auto_init: false });
  });

  test("reports a missing clone URL against the forge that produced it", async () => {
    record(() => json({ html_url: "https://git.acme.com/team/web" }));
    await assert.rejects(
      () =>
        createForgeRepository({
          endpoint: FORGEJO_ENDPOINT,
          token: "t",
          name: "web",
          private: false,
        }),
      /Forgejo created the repository but did not return a clone URL/,
    );

    record(() => json({ clone_url: 42 }));
    await assert.rejects(
      () =>
        createForgeRepository({
          endpoint: GITHUB_ENDPOINT,
          token: "t",
          name: "web",
          private: false,
        }),
      /GitHub created the repository but did not return a clone URL/,
    );
  });

  test("leaves the optional halves null when the forge omits them", async () => {
    record(() => json({ clone_url: "https://git.acme.com/team/web.git" }));

    const created = await createForgeRepository({
      endpoint: FORGEJO_ENDPOINT,
      token: "t",
      name: "web",
      private: false,
    });
    assert.deepEqual(created, {
      gitUrl: "https://git.acme.com/team/web.git",
      htmlUrl: null,
      defaultBranch: null,
    });
  });
});

// ─────────────────────────── error enrichment ──────────────────────────────

describe("a failed forge call a Member is watching", () => {
  test("surfaces GitHub's validation detail instead of only the headline", async () => {
    const body = {
      message: "Repository creation failed.",
      errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
    };
    record(() => json(body, 422, "Unprocessable Entity"));

    const error = await createForgeRepository({
      endpoint: GITHUB_ENDPOINT,
      token: "t",
      name: "web",
      private: false,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error instanceof ForgeApiError);
    assert.match(error.message, /Repository creation failed/);
    // The transport's own message stops at the headline; this is the whole
    // point of the enrichment.
    assert.match(error.message, /name already_exists/);
    assert.equal(error.status, 422);
    assert.deepEqual(error.body, body);
    assert.equal(error.flavor, "github");
  });

  test("prefers an explicit per-error message when GitHub gives one", async () => {
    record(() =>
      json(
        {
          message: "Validation Failed",
          errors: [{ message: "name already exists on this account" }],
        },
        422,
      ),
    );

    await assert.rejects(
      () =>
        createForgePullRequest(GITHUB_ENDPOINT, "t", {
          owner: "acme",
          repo: "web",
          head: "topic",
          base: "main",
          title: "T",
          body: "",
        }),
      /name already exists on this account/,
    );
  });

  test("explains a permission failure instead of restating the status", async () => {
    record(() => json({ message: "Not Found" }, 403, "Forbidden"));

    const error = await createForgeRepository({
      endpoint: GITHUB_ENDPOINT,
      token: "t",
      name: "web",
      private: false,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error instanceof ForgeApiError);
    // Deliberately not "permission to create repositories": every forge call
    // in this module lands here, and naming one operation made the sentence
    // wrong for opening a pull request, which is where people actually meet it.
    assert.match(error.message, /permission for this/);
    assert.match(error.message, /reconnect/i);
    assert.doesNotMatch(error.message, /\.\./, "a headline ending in a period must not double it");
    assert.equal(error.status, 403);
  });

  test("keeps the forge's per-error detail on a permission failure", async () => {
    record(() =>
      json(
        {
          message: "Repository was archived so is read-only.",
          errors: [{ message: "archived" }],
        },
        403,
      ),
    );

    const error = await createForgePullRequest(GITHUB_ENDPOINT, "t", {
      owner: "acme",
      repo: "web",
      head: "topic",
      base: "main",
      title: "T",
      body: "",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error instanceof ForgeApiError);
    assert.match(error.message, /Repository was archived/);
    assert.match(error.message, /archived/);
    assert.doesNotMatch(error.message, /\.\./);
  });

  test("names Forgejo, not GitHub, when Forgejo is the one refusing", async () => {
    // Forgejo answers a duplicate pull request with 409 and a flat body — no
    // `errors` array to expand, so the sentence is the forge's own wording.
    const body = {
      message: "pull request already exists",
      url: "https://git.acme.com/api/swagger",
    };
    record(() => json(body, 409, "Conflict"));

    const error = await createForgePullRequest(FORGEJO_ENDPOINT, "t", {
      owner: "team",
      repo: "web",
      head: "topic",
      base: "main",
      title: "T",
      body: "",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error instanceof ForgeApiError);
    assert.equal(error.message, "pull request already exists");
    assert.equal(error.status, 409);
    assert.equal(error.flavor, "forgejo");
    assert.deepEqual(error.body, body);
  });

  test("names the forge and the status when the body says nothing useful", async () => {
    globalThis.fetch = (async () =>
      new Response("gateway timeout", {
        status: 504,
        statusText: "Gateway Timeout",
      })) as typeof fetch;

    await assert.rejects(
      () =>
        createForgeRepository({
          endpoint: GITHUB_ENDPOINT,
          token: "t",
          name: "web",
          private: false,
        }),
      /GitHub returned 504/,
    );

    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () =>
        createForgeRepository({
          endpoint: FORGEJO_ENDPOINT,
          token: "t",
          name: "web",
          private: false,
        }),
      /Forgejo returned 500/,
    );
  });

  test("still reports the failure when the error body is a shape no forge documents", async () => {
    // A proxy, a WAF, or a Forgejo version nobody here has seen. Building the
    // sentence must not turn a 400 the caller can act on into a TypeError
    // thrown from inside the error handler.
    for (const body of [42, [], { errors: "nope" }, { message: 7 }, null]) {
      record(() => json(body, 400, "Bad Request"));
      const error = await createForgeRepository({
        endpoint: GITHUB_ENDPOINT,
        token: "t",
        name: "web",
        private: false,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      assert.ok(error instanceof ForgeApiError, JSON.stringify(body));
      assert.equal(error.status, 400, JSON.stringify(body));
      assert.match(error.message, /GitHub returned 400/, JSON.stringify(body));
    }
  });

  test("lets a transport failure through unchanged rather than dressing it as a forge answer", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await assert.rejects(
      () =>
        createForgeRepository({
          endpoint: FORGEJO_ENDPOINT,
          token: "t",
          name: "web",
          private: false,
        }),
      (error: unknown) => error instanceof TypeError && /fetch failed/.test(error.message),
    );
  });
});
