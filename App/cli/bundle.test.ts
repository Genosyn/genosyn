import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { createMemberOfNewCompany, mintTestApiKey } from "../server/test/apiAccess.js";
import { buildCli, CLI_BUNDLE_FILE } from "./build.js";
import { tempDir } from "./test/support.js";
import { startTestServer, type TestServer } from "./test/server.js";

/**
 * The file people download: `cli/build.ts`'s bundle, run as its own Node
 * process against the real App. Proves it is one dependency-free file that
 * starts from its shebang, carries its release version, and turns errors
 * into the documented exit codes and JSON on stderr.
 */

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

let server: TestServer;
let bundle: string;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "genosyn-cli-bundle-"));
  bundle = await buildCli({ outDir: path.join(workDir, "dist"), version: "9.8.7-test" });
});

after(async () => {
  await server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

type Exec = { code: number; stdout: string; stderr: string };

/** Run the bundle as a separate process; async so this process keeps serving it. */
function exec(args: string[], env: Record<string, string> = {}, file = bundle): Promise<Exec> {
  return new Promise((resolve) => {
    const child = execFile(
      file === bundle ? process.execPath : file,
      file === bundle ? [bundle, ...args] : args,
      {
        env: { PATH: process.env.PATH ?? "", HOME: workDir, NO_COLOR: "1", ...env },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

describe("the bundled CLI", () => {
  test("is one file that imports only Node's built-ins", () => {
    const source = fs.readFileSync(bundle, "utf8");
    assert.equal(path.basename(bundle), CLI_BUNDLE_FILE);
    assert.ok(source.startsWith("#!/usr/bin/env node\n"));
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    const dynamic = [...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
    assert.ok(imports.length > 0);
    for (const specifier of [...imports, ...dynamic]) {
      assert.match(specifier, /^node:/, `${specifier} would need installing`);
    }
    assert.ok(!/\brequire\(/.test(source), "an ES module has no require()");
    assert.ok(!source.includes("__GENOSYN_CLI_VERSION__"), "the version was baked in");
    if (process.platform !== "win32") assert.ok(fs.statSync(bundle).mode & 0o100, "executable");
  });

  test("prints its release version", async () => {
    const result = await exec(["--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).cli, "9.8.7-test");
  });

  test("runs straight from its shebang under any name", { skip: process.platform === "win32" }, async () => {
    const renamed = path.join(workDir, "genosyn-api");
    fs.copyFileSync(bundle, renamed);
    fs.chmodSync(renamed, 0o755);
    const result = await exec(["help", "exit-codes"], {}, renamed);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Exit codes/);
  });

  test("talks to a real install: whoami and a round trip", async (t) => {
    const { user, company } = await createMemberOfNewCompany("owner");
    const { token } = await mintTestApiKey(user.id, company.id);
    const dir = tempDir(t);
    const env = {
      GENOSYN_URL: `${server.baseUrl}/api/companies/${company.id}`,
      GENOSYN_API_KEY: token,
      GENOSYN_CONFIG: path.join(dir, "config.json"),
    };
    const me = await exec(["whoami"], env);
    assert.equal(me.code, 0, me.stderr);
    assert.equal(JSON.parse(me.stdout).company.id, company.id);
    assert.ok(!me.stdout.includes(token) && !me.stderr.includes(token));

    const created = await exec(["goals", "create", "--title", "From the bundle", "--target-value", "3", "--select", "id"], env);
    assert.equal(created.code, 0, created.stderr);
    const id = created.stdout.trim();
    const read = await exec(["call", "getGoal", id], env);
    assert.equal(JSON.parse(read.stdout).title, "From the bundle");
    assert.equal((await exec(["goals", "delete", id], env)).code, 0);

    const missing = await exec(["goals", "get", id], env);
    assert.equal(missing.code, 5);
    const error = JSON.parse(missing.stderr.trim()).error;
    assert.equal(error.kind, "not_found");
    assert.equal(error.exitCode, 5);
  });

  test("exits 3 for a refused key and 2 for a mistake", async (t) => {
    const { company } = await createMemberOfNewCompany("owner");
    const dir = tempDir(t);
    const env = {
      GENOSYN_URL: `${server.baseUrl}/api/companies/${company.id}`,
      GENOSYN_API_KEY: "gen_neverMintedNeverMintedNeverMinted0000000",
      GENOSYN_CONFIG: path.join(dir, "config.json"),
    };
    const refused = await exec(["whoami"], env);
    assert.equal(refused.code, 3);
    assert.equal(JSON.parse(refused.stderr.trim()).error.kind, "auth");
    const mistake = await exec(["frobnicate"], { ...env, GENOSYN_URL: "" });
    assert.equal(mistake.code, 3, "no address: not logged in");
    const usage = await exec(["whoami", "--nope"], env);
    assert.equal(usage.code, 2);
  });

  test("the CLI's sources import nothing outside Node and themselves", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "build.ts") {
          files.push(full);
        }
      }
    };
    walk(CLI_DIR);
    assert.ok(files.length >= 10);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        const specifier = match[1];
        assert.ok(
          specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
          `${path.relative(CLI_DIR, file)} imports ${specifier}`,
        );
        if (specifier.startsWith("../")) {
          assert.ok(
            path.resolve(path.dirname(file), specifier).startsWith(CLI_DIR),
            `${path.relative(CLI_DIR, file)} reaches outside cli/: ${specifier}`,
          );
        }
      }
    }
  });
});
