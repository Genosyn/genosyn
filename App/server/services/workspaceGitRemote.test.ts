import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { inlineEnvCredentialHelper } from "./gitCredentialHelper.js";
import {
  buildPrivateFetchSshCommand,
  cloneWorkspaceGitRemote,
  fetchWorkspaceGitRemote,
} from "./workspaceGitRemote.js";

const exec = promisify(execFile);
const mutableCodingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...mutableCodingTools };

// These integration tests intentionally launch local Git against loopback
// fixtures. Make that unsafe host access explicit instead of relying on a
// permissive product default.
before(() => {
  mutableCodingTools.enabled = true;
  mutableCodingTools.executionMode = "host";
  mutableCodingTools.allowUnsafeHostExecution = true;
});

after(() => {
  mutableCodingTools.enabled = originalCodingTools.enabled;
  mutableCodingTools.executionMode = originalCodingTools.executionMode;
  mutableCodingTools.allowUnsafeHostExecution = originalCodingTools.allowUnsafeHostExecution;
});

test("private SSH fetch paths remain valid after the bubblewrap remount", () => {
  const command = buildPrivateFetchSshCommand(
    "/private/fetch",
    "/private/fetch/ssh-key",
    "/private/fetch/known_hosts",
    "bubblewrap",
  );
  assert.match(command, /-i '\/workspace\/ssh-key'/);
  assert.match(command, /UserKnownHostsFile='\/workspace\/known_hosts'/);
  assert.doesNotMatch(command, /\/private\/fetch/);
  assert.throws(
    () =>
      buildPrivateFetchSshCommand(
        "/private/fetch",
        "/employee/ssh-key",
        "/private/fetch/known_hosts",
        "bubblewrap",
      ),
    /escapes/,
  );
});

test("clone rejects an unsafe destination filename before materialization", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-clone-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    cloneWorkspaceGitRemote({
      workspaceRoot: root,
      destinationPath: path.join(root, "unsafe\0checkout"),
      remoteUrl: "https://example.invalid/acme/repo.git",
    }),
    /unsafe filename/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("authenticated clone stays private until its checkout is complete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-private-clone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "served", "remote.git");
  const seed = path.join(root, "seed");
  const destination = path.join(root, "checkout");
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["init", "--quiet", seed]);
  await exec("git", ["config", "user.name", "Genosyn Test"], { cwd: seed });
  await exec("git", ["config", "user.email", "test@genosyn.local"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "README.md"), "private clone\n");
  await exec("git", ["add", "README.md"], { cwd: seed });
  await exec("git", ["commit", "--quiet", "-m", "Initial"], { cwd: seed });
  await exec("git", ["branch", "-M", "main"], { cwd: seed });
  await exec("git", ["push", "--quiet", remote, "main"], { cwd: seed });
  await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  await exec("git", ["update-server-info"], { cwd: remote });

  const envKey = "GENOSYN_REPO_TOKEN_CLONE_TEST";
  const token = "turn-only-secret";
  const expectedAuthorization = `Basic ${Buffer.from(`git:${token}`).toString("base64")}`;
  const configuredRequests: string[] = [];
  const configuredServer = staticGitServer(path.dirname(remote), configuredRequests, {
    expectedAuthorization,
    challengeDelayMs: 75,
  });
  const configuredUrl = await listen(configuredServer, t, "/remote.git");
  const redirectedRequests: string[] = [];
  const redirect = captureServer(redirectedRequests);
  const redirectUrl = await listen(redirect, t, "/steal/");
  const testHelper =
    `!f() { if [ "$1" = "get" ]; then ` +
    `printf 'username=%s\\npassword=%s\\n' git "$${envKey}"; fi; }; f`;

  let stopAdversary = false;
  let cloneCompleted = false;
  const adversary = (async () => {
    while (!stopAdversary) {
      if (fs.existsSync(path.join(destination, ".git", "config"))) {
        await exec("git", ["config", "--local", `url.${redirectUrl}.insteadOf`, configuredUrl], {
          cwd: destination,
        });
        await exec("git", ["config", "--local", "http.proxy", redirectUrl], {
          cwd: destination,
        });
        return true;
      }
      if (cloneCompleted) return false;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return false;
  })();

  try {
    await cloneWorkspaceGitRemote({
      workspaceRoot: root,
      destinationPath: destination,
      remoteUrl: configuredUrl,
      extraEnv: { [envKey]: token },
      credentialHelper: testHelper,
    });
    cloneCompleted = true;
    assert.equal(await adversary, true, "adversary did not observe the completed checkout");
    assert.equal(fs.readFileSync(path.join(destination, "README.md"), "utf8"), "private clone\n");
    assert.ok(configuredRequests.some((request) => request.includes(expectedAuthorization)));
    assert.deepEqual(redirectedRequests, []);
  } finally {
    stopAdversary = true;
    await adversary.catch(() => false);
  }
});

test("clone cannot be redirected by replacing its destination parent during the network wait", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-clone-parent-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const destinationParent = path.join(workspace, "repos");
  const displacedParent = path.join(workspace, "repos-before-swap");
  const destination = path.join(destinationParent, "checkout");
  const outside = path.join(root, "outside");
  const remote = path.join(root, "served", "remote.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(destinationParent, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker"), "outside-must-not-change\n");
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["init", "--quiet", seed]);
  await exec("git", ["config", "user.name", "Genosyn Test"], { cwd: seed });
  await exec("git", ["config", "user.email", "test@genosyn.local"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "README.md"), "parent swap\n");
  await exec("git", ["add", "README.md"], { cwd: seed });
  await exec("git", ["commit", "--quiet", "-m", "Initial"], { cwd: seed });
  await exec("git", ["branch", "-M", "main"], { cwd: seed });
  await exec("git", ["push", "--quiet", remote, "main"], { cwd: seed });
  await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  await exec("git", ["update-server-info"], { cwd: remote });

  const envKey = "GENOSYN_REPO_TOKEN_PARENT_SWAP";
  const token = "parent-swap-secret";
  const expectedAuthorization = `Basic ${Buffer.from(`git:${token}`).toString("base64")}`;
  const requests: string[] = [];
  const server = staticGitServer(path.dirname(remote), requests, {
    expectedAuthorization,
    challengeDelayMs: 75,
    responseDelayMs: 150,
  });
  const remoteUrl = await listen(server, t, "/remote.git");
  const helper =
    `!f() { if [ "$1" = "get" ]; then ` +
    `printf 'username=%s\\npassword=%s\\n' git "$${envKey}"; fi; }; f`;
  const clone = cloneWorkspaceGitRemote({
    workspaceRoot: workspace,
    destinationPath: destination,
    remoteUrl,
    extraEnv: { [envKey]: token },
    credentialHelper: helper,
  });

  await waitUntil(() => requests.length > 0);
  fs.renameSync(destinationParent, displacedParent);
  fs.symlinkSync(outside, destinationParent);

  await assert.rejects(clone, /escapes|changed during repository synchronization/);
  assert.equal(fs.readFileSync(path.join(outside, "marker"), "utf8"), "outside-must-not-change\n");
  assert.deepEqual(fs.readdirSync(outside), ["marker"]);
  assert.equal(fs.existsSync(path.join(outside, "checkout")), false);
  assert.equal(fs.existsSync(path.join(displacedParent, "checkout")), false);
});

test("server-managed fetch ignores local URL rewrites and proxy settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-safe-fetch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remote = path.join(root, "served", "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["init", "--quiet", seed]);
  await exec("git", ["config", "user.name", "Genosyn Test"], { cwd: seed });
  await exec("git", ["config", "user.email", "test@genosyn.local"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "README.md"), "safe remote\n");
  await exec("git", ["add", "README.md"], { cwd: seed });
  await exec("git", ["commit", "--quiet", "-m", "Initial"], { cwd: seed });
  await exec("git", ["branch", "-M", "main"], { cwd: seed });
  await exec("git", ["tag", "v1"], { cwd: seed });
  await exec("git", ["push", "--quiet", "--tags", remote, "main"], { cwd: seed });
  await exec("git", ["update-server-info"], { cwd: remote });
  await exec("git", ["init", "--quiet", checkout]);

  const configuredRequests: string[] = [];
  const configuredServer = staticGitServer(path.dirname(remote), configuredRequests);
  const configuredUrl = await listen(configuredServer, t, "/remote.git");
  const redirectedRequests: string[] = [];
  const redirectedServer = captureServer(redirectedRequests);
  const redirectedUrl = await listen(redirectedServer, t, "/redirected/");

  await exec("git", ["config", "--local", `url.${redirectedUrl}.insteadOf`, configuredUrl], {
    cwd: checkout,
  });
  await exec("git", ["config", "--local", "http.proxy", redirectedUrl], { cwd: checkout });
  await exec("git", ["config", "--local", `http.${configuredUrl}.sslVerify`, "false"], {
    cwd: checkout,
  });

  const { stdout: expectedHead } = await exec("git", ["rev-parse", "main"], { cwd: remote });
  await fetchWorkspaceGitRemote({ workspaceRoot: root, cwd: checkout, remoteUrl: configuredUrl });
  await exec("git", ["update-ref", "refs/remotes/origin/stale", expectedHead.trim()], {
    cwd: checkout,
  });
  await fetchWorkspaceGitRemote({ workspaceRoot: root, cwd: checkout, remoteUrl: configuredUrl });

  const { stdout: actualHead } = await exec("git", ["rev-parse", "refs/remotes/origin/main"], {
    cwd: checkout,
  });
  assert.equal(actualHead.trim(), expectedHead.trim());
  await assert.rejects(
    exec("git", ["show-ref", "--verify", "refs/remotes/origin/stale"], {
      cwd: checkout,
    }),
  );
  const { stdout: tag } = await exec("git", ["rev-parse", "refs/tags/v1"], { cwd: checkout });
  assert.equal(tag.trim(), expectedHead.trim());

  await exec("git", ["update-ref", "refs/heads/main", expectedHead.trim()], { cwd: checkout });
  const linkedWorktree = path.join(root, "linked-worktree");
  await exec("git", ["worktree", "add", "--quiet", linkedWorktree, "main"], { cwd: checkout });
  fs.writeFileSync(path.join(seed, "SECOND.md"), "second commit\n");
  await exec("git", ["add", "SECOND.md"], { cwd: seed });
  await exec("git", ["commit", "--quiet", "-m", "Second"], { cwd: seed });
  await exec("git", ["push", "--quiet", remote, "main"], { cwd: seed });
  await exec("git", ["update-server-info"], { cwd: remote });
  const { stdout: secondHead } = await exec("git", ["rev-parse", "main"], { cwd: remote });
  await fetchWorkspaceGitRemote({
    workspaceRoot: root,
    cwd: linkedWorktree,
    remoteUrl: configuredUrl,
  });
  const { stdout: linkedHead } = await exec("git", ["rev-parse", "refs/remotes/origin/main"], {
    cwd: linkedWorktree,
  });
  assert.equal(linkedHead.trim(), secondHead.trim());

  // A local tag that intentionally diverges from the remote must not be
  // clobbered, matching normal fetch's auto-follow behavior.
  await exec("git", ["update-ref", "refs/tags/v1", secondHead.trim()], { cwd: checkout });
  await fetchWorkspaceGitRemote({
    workspaceRoot: root,
    cwd: linkedWorktree,
    remoteUrl: configuredUrl,
  });
  const { stdout: preservedTag } = await exec("git", ["rev-parse", "refs/tags/v1"], {
    cwd: checkout,
  });
  assert.equal(preservedTag.trim(), secondHead.trim());
  assert.ok(configuredRequests.length > 0);
  assert.deepEqual(redirectedRequests, []);
});

test("fetch cannot copy objects through a replaced object-directory parent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-object-parent-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "served", "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker"), "outside-must-not-change\n");
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["init", "--quiet", seed]);
  await exec("git", ["config", "user.name", "Genosyn Test"], { cwd: seed });
  await exec("git", ["config", "user.email", "test@genosyn.local"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "README.md"), "object swap\n");
  await exec("git", ["add", "README.md"], { cwd: seed });
  await exec("git", ["commit", "--quiet", "-m", "Initial"], { cwd: seed });
  await exec("git", ["branch", "-M", "main"], { cwd: seed });
  await exec("git", ["push", "--quiet", remote, "main"], { cwd: seed });
  await exec("git", ["update-server-info"], { cwd: remote });
  await exec("git", ["init", "--quiet", checkout]);

  const requests: string[] = [];
  const server = staticGitServer(path.dirname(remote), requests, { responseDelayMs: 150 });
  const remoteUrl = await listen(server, t, "/remote.git");
  const fetch = fetchWorkspaceGitRemote({ workspaceRoot: root, cwd: checkout, remoteUrl });

  await waitUntil(() => requests.length > 0);
  const objectDirectory = path.join(checkout, ".git", "objects");
  const displacedObjects = path.join(checkout, ".git", "objects-before-swap");
  fs.renameSync(objectDirectory, displacedObjects);
  fs.symlinkSync(outside, objectDirectory);

  await assert.rejects(fetch, /escapes|changed during repository synchronization/);
  assert.equal(fs.readFileSync(path.join(outside, "marker"), "utf8"), "outside-must-not-change\n");
  assert.deepEqual(fs.readdirSync(outside), ["marker"]);
  await assert.rejects(
    exec("git", ["show-ref", "--verify", "refs/remotes/origin/main"], { cwd: checkout }),
  );
});

test("malicious local config cannot redirect or proxy an authenticated fetch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-fetch-exfil-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  await exec("git", ["init", "--quiet", checkout]);

  const capturedRequests: string[] = [];
  const capture = captureServer(capturedRequests);
  const captureUrl = await listen(capture, t, "/steal/");
  const configuredUrl = "https://credential-target.invalid/acme/private.git";
  await exec("git", ["config", "--local", `url.${captureUrl}.insteadOf`, configuredUrl], {
    cwd: checkout,
  });
  await exec("git", ["config", "--local", "http.proxy", captureUrl], { cwd: checkout });
  await exec("git", ["config", "--local", "http.sslVerify", "false"], { cwd: checkout });
  await exec("git", ["config", "--local", `http.${configuredUrl}.proxy`, captureUrl], {
    cwd: checkout,
  });

  const envKey = "GENOSYN_REPO_TOKEN_EXFIL_TEST";
  await assert.rejects(
    fetchWorkspaceGitRemote({
      workspaceRoot: root,
      cwd: checkout,
      remoteUrl: configuredUrl,
      extraEnv: { [envKey]: "turn-only-secret" },
      credentialHelper: inlineEnvCredentialHelper("x-access-token", envKey, configuredUrl),
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /turn-only-secret/);
      return true;
    },
  );
  assert.deepEqual(capturedRequests, []);
});

function captureServer(requests: string[]): http.Server {
  return http.createServer((req, res) => {
    requests.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers.authorization ?? ""}`);
    res.writeHead(401, { "www-authenticate": 'Basic realm="capture"' });
    res.end("denied");
  });
}

function staticGitServer(
  root: string,
  requests: string[],
  options?: {
    expectedAuthorization?: string;
    challengeDelayMs?: number;
    responseDelayMs?: number;
  },
): http.Server {
  const resolvedRoot = path.resolve(root);
  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push(`${pathname} ${req.headers.authorization ?? ""}`);
    if (
      options?.expectedAuthorization &&
      req.headers.authorization !== options.expectedAuthorization
    ) {
      setTimeout(() => {
        res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
        res.end("credentials required");
      }, options.challengeDelayMs ?? 0);
      return;
    }
    const candidate = path.resolve(resolvedRoot, `.${decodeURIComponent(pathname)}`);
    const relative = path.relative(resolvedRoot, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      res.writeHead(404).end();
      return;
    }
    const respond = () => {
      fs.readFile(candidate, (error, body) => {
        if (error) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": pathname.endsWith("/info/refs")
            ? "text/plain"
            : "application/octet-stream",
        });
        res.end(body);
      });
    };
    if (options?.responseDelayMs) setTimeout(respond, options.responseDelayMs);
    else respond();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Git request.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function listen(server: http.Server, t: test.TestContext, suffix: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return `http://127.0.0.1:${address.port}${suffix}`;
}
