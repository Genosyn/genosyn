import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { config } from "../../../../config.js";
import type { AgentTool, ToolResult } from "../types.js";
import { CODING_TOOL_NAMES, codingTools, type CodingToolContext } from "./coding.js";

type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
type CleanupContext = { after: (fn: () => void | Promise<void>) => void };

const mutableCodingConfig = config.agent.codingTools as {
  executionMode: "host" | "bubblewrap" | "disabled";
  bubblewrapPath: string;
  allowUnsafeHostExecution: boolean;
};
const originalExecutionMode = mutableCodingConfig.executionMode;
const originalBubblewrapPath = mutableCodingConfig.bubblewrapPath;
const originalAllowUnsafeHostExecution = mutableCodingConfig.allowUnsafeHostExecution;
const exec = promisify(execFile);
const CODING_MODULE_URL = new URL("./coding.ts", import.meta.url).href;

before(() => {
  // Process behavior is tested without depending on bubblewrap being installed
  // on the developer machine. The namespace command itself has a separate
  // pure-construction suite in ../bubblewrap.test.ts.
  mutableCodingConfig.executionMode = "host";
  mutableCodingConfig.allowUnsafeHostExecution = true;
});

after(() => {
  mutableCodingConfig.executionMode = originalExecutionMode;
  mutableCodingConfig.bubblewrapPath = originalBubblewrapPath;
  mutableCodingConfig.allowUnsafeHostExecution = originalAllowUnsafeHostExecution;
});

async function makeWorkspace(t: CleanupContext): Promise<{
  parent: string;
  root: string;
  outside: string;
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-coding-test-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root, outside };
}

function toolset(
  cwd: string,
  options: Partial<Omit<CodingToolContext, "cwd">> = {},
): Record<CodingToolName, AgentTool> {
  const tools = codingTools({
    cwd,
    env: options.env ?? {},
    bashTimeoutMs: options.bashTimeoutMs ?? 2_000,
    signal: options.signal,
    registerProcessCleanup: options.registerProcessCleanup,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    CodingToolName,
    AgentTool
  >;
}

function assertToolError(result: ToolResult, pattern?: RegExp): void {
  assert.equal(result.isError, true, result.content);
  if (pattern) assert.match(result.content, pattern);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

function abortAtAtomicCommit(): { signal: AbortSignal; checks: () => number } {
  const controller = new AbortController();
  const signal = controller.signal;
  const throwIfAborted = signal.throwIfAborted.bind(signal);
  let checks = 0;
  Object.defineProperty(signal, "throwIfAborted", {
    value: () => {
      checks += 1;
      // writeFileAtomically checks once before opening its private temp file and
      // again after the complete payload is closed, immediately before rename.
      if (checks === 2) controller.abort();
      throwIfAborted();
    },
  });
  return { signal, checks: () => checks };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runToolInWatchdog(
  cwd: string,
  name: CodingToolName,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const script = `
    import { codingTools } from ${JSON.stringify(CODING_MODULE_URL)};
    const tools = Object.fromEntries(codingTools({
      cwd: ${JSON.stringify(cwd)}, env: {}, bashTimeoutMs: 1000
    }).map((tool) => [tool.name, tool]));
    const started = Date.now();
    const result = await tools[${JSON.stringify(name)}].run(${JSON.stringify(input)});
    process.stdout.write(JSON.stringify({ result, elapsedMs: Date.now() - started }));
  `;
  const { stdout } = await exec(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: os.tmpdir(),
      },
      timeout: 10_000,
    },
  );
  const response = JSON.parse(stdout) as { result: ToolResult; elapsedMs: number };
  assert.ok(response.elapsedMs < 2_000, `${name} took ${response.elapsedMs}ms to reject`);
  return response.result;
}

describe("coding tool contracts", () => {
  test("exports the seven tools with strict object schemas", () => {
    const tools = toolset(os.tmpdir());
    assert.deepEqual(Object.keys(tools), [...CODING_TOOL_NAMES]);

    const required: Record<CodingToolName, string[]> = {
      bash: ["command"],
      read_file: ["path"],
      write_file: ["path", "content"],
      edit_file: ["path", "old_string", "new_string"],
      list_dir: [],
      glob: ["pattern"],
      grep: ["pattern"],
    };

    for (const name of CODING_TOOL_NAMES) {
      const schema = tools[name].inputSchema;
      assert.equal(schema.type, "object", name);
      assert.equal(schema.additionalProperties, false, name);
      assert.deepEqual(schema.required ?? [], required[name], name);
    }
  });

  test("rejects missing required inputs without mutating the workspace", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const editable = path.join(root, "editable.txt");
    await fs.writeFile(editable, "keep remove");

    assertToolError(await tools.bash.run({}), /command.*required/i);
    assertToolError(await tools.read_file.run({}), /path.*required/i);
    assertToolError(await tools.write_file.run({ path: "empty.txt" }), /content.*required/i);
    assertToolError(await tools.write_file.run({ content: "unsafe" }), /path.*required/i);
    assertToolError(
      await tools.edit_file.run({ path: "editable.txt", old_string: " remove" }),
      /new_string.*required/i,
    );
    assertToolError(
      await tools.edit_file.run({ path: "editable.txt", new_string: "replacement" }),
      /old_string.*required/i,
    );
    assertToolError(await tools.glob.run({}), /pattern.*required/i);
    assertToolError(await tools.grep.run({}), /pattern.*required/i);

    assert.equal(await pathExists(path.join(root, "empty.txt")), false);
    assert.equal(await fs.readFile(editable, "utf8"), "keep remove");
    assert.equal((await tools.list_dir.run({})).isError, undefined);
  });
});

describe("path confinement", () => {
  test("rejects relative and absolute traversal for every path-based tool", async (t) => {
    const { root, outside } = await makeWorkspace(t);
    const tools = toolset(root);
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "outside");

    const relative = "../outside/secret.txt";
    const attempts = [
      tools.read_file.run({ path: relative }),
      tools.write_file.run({ path: relative, content: "changed" }),
      tools.edit_file.run({ path: relative, old_string: "outside", new_string: "changed" }),
      tools.list_dir.run({ path: "../outside" }),
      tools.glob.run({ path: "../outside", pattern: "*" }),
      tools.grep.run({ path: "../outside", pattern: "outside" }),
      tools.read_file.run({ path: secret }),
      tools.write_file.run({ path: secret, content: "changed" }),
    ];

    for (const result of await Promise.all(attempts)) {
      assertToolError(result, /(escape|outside|working directory)/i);
    }
    assert.equal(await fs.readFile(secret, "utf8"), "outside");
  });

  test("rejects existing file and directory symlinks that leave the workspace", async (t) => {
    if (process.platform === "win32") {
      t.skip("symlink behavior is platform-specific");
      return;
    }
    const { root, outside } = await makeWorkspace(t);
    const tools = toolset(root);
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(outsideFile, path.join(root, "linked-file.txt"));
    await fs.symlink(outside, path.join(root, "linked-directory"));

    assertToolError(
      await tools.read_file.run({ path: "linked-file.txt" }),
      /(symlink|outside|working directory)/i,
    );
    assertToolError(
      await tools.edit_file.run({
        path: "linked-file.txt",
        old_string: "outside",
        new_string: "changed",
      }),
      /(symlink|outside|working directory)/i,
    );
    assertToolError(
      await tools.write_file.run({ path: "linked-directory/new.txt", content: "changed" }),
      /(symlink|outside|working directory)/i,
    );
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside");
    assert.equal(await pathExists(path.join(outside, "new.txt")), false);
  });

  test("rejects a dangling symlink whose future target is outside", async (t) => {
    if (process.platform === "win32") {
      t.skip("symlink behavior is platform-specific");
      return;
    }
    const { root, outside } = await makeWorkspace(t);
    const tools = toolset(root);
    const futureTarget = path.join(outside, "created-through-link.txt");
    await fs.symlink(futureTarget, path.join(root, "dangling.txt"));

    assertToolError(
      await tools.write_file.run({ path: "dangling.txt", content: "must stay inside" }),
      /(resolve|symlink|outside|working directory)/i,
    );
    assert.equal(await pathExists(futureTarget), false);
  });

  test("blocks App-private state and Git control paths through direct, case, and symlink aliases", async (t) => {
    if (process.platform === "win32") {
      t.skip("symlink behavior is platform-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, "repositories", ".ssh"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "SAFE_GIT_CONFIG");
    await fs.writeFile(path.join(root, "repositories", ".ssh", "deploy-key"), "PRIVATE_KEY");
    await fs.writeFile(path.join(root, ".browser-state.json"), "BROWSER_COOKIE");
    await fs.symlink(".browser-state.json", path.join(root, "state-link"));
    await fs.symlink(".git", path.join(root, "git-link"));

    const attempts = [
      tools.read_file.run({ path: ".git/config" }),
      tools.read_file.run({ path: ".GIT/config" }),
      tools.write_file.run({ path: ".git/commondir", content: "../../outside" }),
      tools.edit_file.run({
        path: "repositories/.ssh/deploy-key",
        old_string: "PRIVATE_KEY",
        new_string: "changed",
      }),
      tools.read_file.run({ path: ".browser-state.json" }),
      tools.read_file.run({ path: ".BROWSER-STATE.JSON" }),
      tools.read_file.run({ path: "state-link" }),
      tools.write_file.run({ path: "git-link/commondir", content: "../../outside" }),
      tools.list_dir.run({ path: ".ssh" }),
      tools.glob.run({ pattern: "*", path: ".git" }),
      tools.grep.run({ pattern: "COOKIE", path: "." }),
    ];
    const results = await Promise.all(attempts);
    for (const [index, result] of results.entries()) {
      if (index === results.length - 1) {
        assert.equal(result.isError, undefined);
        assert.doesNotMatch(result.content, /BROWSER_COOKIE|PRIVATE_KEY|SAFE_GIT_CONFIG/);
      } else {
        assertToolError(result, /(App-managed|reserved|no such)/i);
        assert.doesNotMatch(result.content, /BROWSER_COOKIE|PRIVATE_KEY|SAFE_GIT_CONFIG/);
      }
    }

    const listed = await tools.list_dir.run({ path: "." });
    assert.equal(listed.isError, undefined);
    assert.doesNotMatch(listed.content, /browser-state|state-link|git-link|\.git|\.ssh/);
    assert.equal(await fs.readFile(path.join(root, ".git", "config"), "utf8"), "SAFE_GIT_CONFIG");
    assert.equal(
      await fs.readFile(path.join(root, "repositories", ".ssh", "deploy-key"), "utf8"),
      "PRIVATE_KEY",
    );
    await assert.rejects(fs.stat(path.join(root, ".git", "commondir")), /ENOENT/);
  });
});

describe("read_file", () => {
  test("reads ordinary and Unicode text and honors one-based slices", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const text = "first\ncafé ☕\n第三行\nlast";
    await fs.writeFile(path.join(root, "unicode.txt"), text);

    assert.deepEqual(await tools.read_file.run({ path: "unicode.txt" }), { content: text });
    assert.deepEqual(await tools.read_file.run({ path: "unicode.txt", offset: 2, limit: 2 }), {
      content: "café ☕\n第三行",
    });
  });

  test("allows a bounded slice of a large text file while rejecting a full read", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const lines = Array.from(
      { length: 520 },
      (_, index) => `${String(index + 1).padStart(4, "0")}:${"x".repeat(900)}`,
    );
    await fs.writeFile(path.join(root, "large.txt"), lines.join("\n"));

    assertToolError(await tools.read_file.run({ path: "large.txt" }), /too large/i);
    assert.deepEqual(await tools.read_file.run({ path: "large.txt", offset: 250, limit: 2 }), {
      content: `${lines[249]}\n${lines[250]}`,
    });
  });

  test("refuses directories and external special-file symlinks without blocking", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await fs.mkdir(path.join(root, "folder"));
    assertToolError(await tools.read_file.run({ path: "folder" }), /directory/i);

    if (process.platform !== "win32") {
      await fs.symlink("/dev/null", path.join(root, "device"));
      assertToolError(
        await tools.read_file.run({ path: "device" }),
        /(symlink|outside|working directory)/i,
      );
    }
  });

  test("rejects FIFOs in read, write, and edit paths without waiting for a peer", async (t) => {
    if (process.platform === "win32") {
      t.skip("FIFOs are POSIX-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const made = await tools.bash.run({ command: "mkfifo named-pipe" });
    assert.equal(made.isError, false, made.content);

    assertToolError(
      await runToolInWatchdog(root, "read_file", { path: "named-pipe" }),
      /regular file/i,
    );
    assertToolError(
      await runToolInWatchdog(root, "write_file", { path: "named-pipe", content: "blocked" }),
      /regular file/i,
    );
    assertToolError(
      await runToolInWatchdog(root, "edit_file", {
        path: "named-pipe",
        old_string: "old",
        new_string: "new",
      }),
      /regular file/i,
    );
  });
});

describe("write_file and edit_file", () => {
  test("creates nested parents, overwrites content, and reports UTF-8 bytes", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const rel = "nested/deeper/message.txt";
    const content = "héllo 👋";

    const first = await tools.write_file.run({ path: rel, content });
    assert.equal(first.isError, undefined);
    assert.match(first.content, new RegExp(`Wrote ${Buffer.byteLength(content, "utf8")} bytes`));
    assert.equal(await fs.readFile(path.join(root, rel), "utf8"), content);

    await fs.chmod(path.join(root, rel), 0o700);
    await tools.write_file.run({ path: rel, content: "replacement" });
    assert.equal(await fs.readFile(path.join(root, rel), "utf8"), "replacement");
    assert.equal((await fs.stat(path.join(root, rel))).mode & 0o777, 0o700);
  });

  test("edits one exact match, rejects ambiguous edits, and replaces all on request", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const target = path.join(root, "edit.txt");
    await fs.writeFile(target, "alpha beta beta");

    assertToolError(
      await tools.edit_file.run({
        path: "edit.txt",
        old_string: "beta",
        new_string: "gamma",
      }),
      /appears 2 times/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), "alpha beta beta");

    const replaced = await tools.edit_file.run({
      path: "edit.txt",
      old_string: "beta",
      new_string: "gamma",
      replace_all: true,
    });
    assert.equal(replaced.isError, undefined);
    assert.match(replaced.content, /2 replacements/i);
    assert.equal(await fs.readFile(target, "utf8"), "alpha gamma gamma");

    await tools.edit_file.run({
      path: "edit.txt",
      old_string: "alpha ",
      new_string: "",
    });
    assert.equal(await fs.readFile(target, "utf8"), "gamma gamma");
  });

  test("treats replacement metacharacters literally", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const literal = "$& $$ $` $'";
    await fs.writeFile(path.join(root, "literal.txt"), "before TOKEN after");

    const result = await tools.edit_file.run({
      path: "literal.txt",
      old_string: "TOKEN",
      new_string: literal,
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      await fs.readFile(path.join(root, "literal.txt"), "utf8"),
      `before ${literal} after`,
    );
  });

  test("bounds large writes and edits without changing the target", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    const tooLarge = "x".repeat(400 * 1024 + 1);

    assertToolError(
      await tools.write_file.run({ path: "too-large.txt", content: tooLarge }),
      /too large|at most/i,
    );
    assert.equal(await pathExists(path.join(root, "too-large.txt")), false);

    const target = path.join(root, "large-edit.txt");
    await fs.writeFile(target, tooLarge);
    assertToolError(
      await tools.edit_file.run({
        path: "large-edit.txt",
        old_string: "x",
        new_string: "y",
      }),
      /too large/i,
    );
    assert.equal((await fs.stat(target)).size, Buffer.byteLength(tooLarge));
    assert.equal((await fs.readFile(target, "utf8")).startsWith("x"), true);
  });

  test("leaves existing files intact when cancellation arrives after the temp payload is complete", async (t) => {
    const { root } = await makeWorkspace(t);
    const target = path.join(root, "kept.txt");
    await fs.writeFile(target, "keep me");

    const writeAbort = abortAtAtomicCommit();
    assertToolError(
      await toolset(root, { signal: writeAbort.signal }).write_file.run({
        path: "kept.txt",
        content: "replacement",
      }),
      /abort/i,
    );
    assert.equal(writeAbort.checks(), 2);

    const editAbort = abortAtAtomicCommit();
    assertToolError(
      await toolset(root, { signal: editAbort.signal }).edit_file.run({
        path: "kept.txt",
        old_string: "keep",
        new_string: "lose",
      }),
      /abort/i,
    );
    assert.equal(editAbort.checks(), 2);
    assert.equal(await fs.readFile(target, "utf8"), "keep me");
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.startsWith(".genosyn-write-")),
      [],
    );
  });
});

describe("list_dir", () => {
  test("is deterministic, marks directories, and hides only .git and node_modules", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await Promise.all([
      fs.mkdir(path.join(root, "zeta")),
      fs.mkdir(path.join(root, "alpha")),
      fs.mkdir(path.join(root, ".git")),
      fs.mkdir(path.join(root, ".github")),
      fs.mkdir(path.join(root, "node_modules")),
      fs.writeFile(path.join(root, "middle.txt"), "middle"),
      fs.writeFile(path.join(root, ".gitignore"), "dist\n"),
      fs.writeFile(path.join(root, ".gitattributes"), "* text=auto\n"),
      fs.writeFile(path.join(root, ".gitkeep"), ""),
    ]);

    const expected = [
      ".gitattributes",
      ".github/",
      ".gitignore",
      ".gitkeep",
      "alpha/",
      "middle.txt",
      "zeta/",
    ]
      .sort((a, b) => a.localeCompare(b))
      .join("\n");
    const first = await tools.list_dir.run({});
    const second = await tools.list_dir.run({ path: "." });
    assert.deepEqual(first, { content: expected });
    assert.deepEqual(second, first);
    assert.doesNotMatch(first.content, /(^|\n)\.git\/?($|\n)/);
    assert.doesNotMatch(first.content, /node_modules/);
  });

  test("reports empty and non-directory paths clearly", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await fs.mkdir(path.join(root, "empty"));
    await fs.writeFile(path.join(root, "file.txt"), "text");
    assert.deepEqual(await tools.list_dir.run({ path: "empty" }), { content: "(empty)" });
    assertToolError(await tools.list_dir.run({ path: "file.txt" }), /directory/i);
  });
});

describe("glob", () => {
  test("supports *, ?, and ** with deterministic paths relative to the search root", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await Promise.all([
      fs.mkdir(path.join(root, "src/nested"), { recursive: true }),
      fs.mkdir(path.join(root, "dist")),
      fs.mkdir(path.join(root, "node_modules")),
      fs.mkdir(path.join(root, ".git")),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, "root.ts"), "root"),
      fs.writeFile(path.join(root, "src/a.ts"), "a"),
      fs.writeFile(path.join(root, "src/nested/b.ts"), "b"),
      fs.writeFile(path.join(root, "src/nested/note.txt"), "note"),
      fs.writeFile(path.join(root, "dist/ignored.ts"), "ignored"),
      fs.writeFile(path.join(root, "node_modules/ignored.ts"), "ignored"),
      fs.writeFile(path.join(root, ".git/ignored.ts"), "ignored"),
    ]);

    assert.deepEqual(await tools.glob.run({ pattern: "*.ts" }), { content: "root.ts" });
    assert.deepEqual(await tools.glob.run({ pattern: "?.ts", path: "src" }), {
      content: "a.ts",
    });
    assert.deepEqual(await tools.glob.run({ pattern: "**/*.ts" }), {
      content: "root.ts\nsrc/a.ts\nsrc/nested/b.ts",
    });
    assert.deepEqual(await tools.glob.run({ pattern: "**/*.ts", path: "src" }), {
      content: "a.ts\nnested/b.ts",
    });
  });

  test("reports a missing search path instead of pretending it has no matches", async (t) => {
    const { root } = await makeWorkspace(t);
    const result = await toolset(root).glob.run({ pattern: "*.ts", path: "missing" });
    assertToolError(result, /(no such|not exist|directory)/i);
  });

  test("caps deterministic results and announces truncation", async (t) => {
    const { root } = await makeWorkspace(t);
    const many = path.join(root, "many");
    await fs.mkdir(many);
    for (let index = 0; index < 500; index++) {
      await fs.writeFile(path.join(many, `file-${String(index).padStart(4, "0")}.ts`), "");
    }

    const tools = toolset(root);
    const exact = await tools.glob.run({ pattern: "*.ts", path: "many" });
    assert.equal(exact.isError, undefined);
    assert.equal(exact.content.split("\n").length, 500);
    assert.doesNotMatch(exact.content, /trunc/i);

    for (let index = 500; index < 505; index++) {
      await fs.writeFile(path.join(many, `file-${String(index).padStart(4, "0")}.ts`), "");
    }
    const result = await tools.glob.run({ pattern: "*.ts", path: "many" });
    assert.equal(result.isError, undefined);
    const lines = result.content.split("\n");
    assert.match(lines.at(-1) ?? "", /more.*trunc/i);
    const paths = lines.slice(0, -1);
    assert.equal(paths.length, 500);
    assert.deepEqual(
      paths,
      [...paths].sort((a, b) => a.localeCompare(b)),
    );
    assert.equal(paths[0], "file-0000.ts");
    assert.equal(paths.at(-1), "file-0499.ts");
  });

  test("honors a signal that is already aborted", async (t) => {
    const { root } = await makeWorkspace(t);
    const controller = new AbortController();
    controller.abort();
    const result = await toolset(root, { signal: controller.signal }).glob.run({ pattern: "**/*" });
    assertToolError(result, /abort/i);
  });
});

describe("grep", () => {
  test("supports regexes, case folding, file globs, and deterministic line results", async (t) => {
    const { root } = await makeWorkspace(t);
    const tools = toolset(root);
    await Promise.all([
      fs.mkdir(path.join(root, "src/nested"), { recursive: true }),
      fs.mkdir(path.join(root, "dist")),
      fs.mkdir(path.join(root, ".git")),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, "src/a.ts"), "const Needle = 1;\nneedle again\n"),
      fs.writeFile(path.join(root, "src/nested/b.ts"), "NEEDLE\n"),
      fs.writeFile(path.join(root, "notes.txt"), "needle note\n"),
      fs.writeFile(path.join(root, "dist/ignored.ts"), "needle\n"),
      fs.writeFile(path.join(root, ".git/config"), "needle\n"),
    ]);

    assert.deepEqual(await tools.grep.run({ pattern: "needle", glob: "*.ts", ignore_case: true }), {
      content: [
        "src/a.ts:1: const Needle = 1;",
        "src/a.ts:2: needle again",
        "src/nested/b.ts:1: NEEDLE",
      ].join("\n"),
    });
    assert.deepEqual(await tools.grep.run({ pattern: "^needle", path: "src" }), {
      content: "src/a.ts:2: needle again",
    });
    assertToolError(await tools.grep.run({ pattern: "[" }), /invalid regex/i);
  });

  test("reports a missing search path instead of pretending it has no matches", async (t) => {
    const { root } = await makeWorkspace(t);
    const result = await toolset(root).grep.run({ pattern: "needle", path: "missing" });
    assertToolError(result, /(no such|not exist|directory)/i);
  });

  test("caps matches and announces truncation", async (t) => {
    const { root } = await makeWorkspace(t);
    const lines = Array.from(
      { length: 200 },
      (_, index) => `hit ${String(index).padStart(3, "0")}`,
    );
    const target = path.join(root, "hits.txt");
    await fs.writeFile(target, lines.join("\n"));

    const tools = toolset(root);
    const exact = await tools.grep.run({ pattern: "hit" });
    assert.equal(exact.isError, undefined);
    assert.equal(exact.content.split("\n").length, 200);
    assert.doesNotMatch(exact.content, /trunc/i);

    await fs.appendFile(
      target,
      `\n${Array.from({ length: 5 }, (_, index) => `hit ${200 + index}`).join("\n")}`,
    );
    const result = await tools.grep.run({ pattern: "hit" });
    assert.equal(result.isError, undefined);
    const output = result.content.split("\n");
    assert.match(output.at(-1) ?? "", /more.*trunc/i);
    assert.equal(output.slice(0, -1).length, 200);
    assert.equal(output[0], "hits.txt:1: hit 000");
    assert.equal(output.at(-2), "hits.txt:200: hit 199");
  });

  test("bounds pathological regular expressions instead of blocking the server", async (t) => {
    const { root } = await makeWorkspace(t);
    await fs.writeFile(path.join(root, "adversarial.txt"), `${"a".repeat(50_000)}!`);
    const started = Date.now();
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 20);

    let result: ToolResult;
    try {
      result = await toolset(root).grep.run({ pattern: "^(a+)+$" });
    } finally {
      clearInterval(heartbeat);
    }

    assertToolError(result, /safety limit|simpler pattern/i);
    assert.ok(Date.now() - started < 1_500, "regexp deadline did not interrupt the search");
    assert.ok(heartbeats >= 3, `event loop advanced only ${heartbeats} times during regexp work`);
  });

  test("honors a signal that is already aborted", async (t) => {
    const { root } = await makeWorkspace(t);
    const controller = new AbortController();
    controller.abort();
    const result = await toolset(root, { signal: controller.signal }).grep.run({ pattern: "." });
    assertToolError(result, /abort/i);
  });
});

describe("bash", () => {
  test("fails closed when host execution was not explicitly acknowledged", async (t) => {
    const { root } = await makeWorkspace(t);
    mutableCodingConfig.allowUnsafeHostExecution = false;
    try {
      const result = await toolset(root).bash.run({ command: "touch should-not-exist" });
      assertToolError(result, /unsafe host command execution is disabled/i);
      assert.equal(await pathExists(path.join(root, "should-not-exist")), false);
    } finally {
      mutableCodingConfig.allowUnsafeHostExecution = true;
    }
  });

  test("uses the workspace cwd and explicit environment without inheriting App secrets", async (t) => {
    const { root } = await makeWorkspace(t);
    const parentKey = `GENOSYN_CODING_TEST_PARENT_${process.pid}`;
    process.env[parentKey] = "must-not-leak";
    try {
      const command = `printf '%s\\n%s\\n%s\\n%s' "$PWD" "$HOME" "$EXPLICIT_VALUE" "\${${parentKey}-unset}"`;
      const result = await toolset(root, { env: { EXPLICIT_VALUE: "available" } }).bash.run({
        command,
      });
      assert.equal(result.isError, false);
      const [pwd, home, explicit, inherited] = result.content.split("\n");
      assert.equal(pwd, await fs.realpath(root));
      assert.equal(home, root);
      assert.equal(explicit, "available");
      assert.equal(inherited, "unset");
    } finally {
      delete process.env[parentKey];
    }
  });

  test("keeps sandbox variables out of the host-side bubblewrap launcher", async (t) => {
    if (process.platform === "win32") {
      t.skip("executable scripts are POSIX-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    const launcher = path.join(root, "fake-bwrap");
    await fs.writeFile(
      launcher,
      [
        "#!/bin/sh",
        "/usr/bin/env > launcher-env.txt",
        "printf '%s\\n' \"$@\" > launcher-args.txt",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    mutableCodingConfig.executionMode = "bubblewrap";
    mutableCodingConfig.bubblewrapPath = launcher;
    try {
      const result = await toolset(root, {
        env: {
          LD_PRELOAD: "/tmp/must-not-reach-launcher.so",
          TOOL_SECRET: "turn-only-secret",
        },
      }).bash.run({ command: "true" });
      assert.equal(result.isError, false);

      const launcherEnv = await fs.readFile(path.join(root, "launcher-env.txt"), "utf8");
      assert.doesNotMatch(launcherEnv, /^LD_PRELOAD=/m);
      assert.doesNotMatch(launcherEnv, /^TOOL_SECRET=/m);
      assert.match(launcherEnv, /^PATH=/m);

      const args = (await fs.readFile(path.join(root, "launcher-args.txt"), "utf8"))
        .trimEnd()
        .split("\n");
      const preload = args.indexOf("LD_PRELOAD");
      assert.equal(args[preload - 1], "--setenv");
      assert.equal(args[preload + 1], "/tmp/must-not-reach-launcher.so");
      const secret = args.indexOf("TOOL_SECRET");
      assert.equal(args[secret - 1], "--setenv");
      assert.equal(args[secret + 1], "turn-only-secret");
      const home = args.indexOf("HOME");
      assert.equal(args[home - 1], "--setenv");
      assert.equal(args[home + 1], "/workspace");
    } finally {
      mutableCodingConfig.executionMode = "host";
      mutableCodingConfig.bubblewrapPath = originalBubblewrapPath;
    }
  });

  test("distinguishes no output from a nonzero exit", async (t) => {
    const { root } = await makeWorkspace(t);
    const bash = toolset(root).bash;
    assert.deepEqual(await bash.run({ command: "true" }), {
      content: "(no output)",
      isError: false,
    });

    const failed = await bash.run({
      command: "printf 'stdout'; printf 'stderr' >&2; exit 7",
    });
    assertToolError(failed, /exit code 7/);
    assert.match(failed.content, /stdout/);
    assert.match(failed.content, /stderr/);
  });

  test("caps a requested timeout at the context ceiling", async (t) => {
    const { root } = await makeWorkspace(t);
    const started = Date.now();
    const result = await toolset(root, { bashTimeoutMs: 120 }).bash.run({
      command: "sleep 2",
      timeout_ms: 5_000,
    });
    assertToolError(result, /timed out.*120ms/i);
    assert.ok(Date.now() - started < 1_500, "timeout did not stop the command promptly");
  });

  test("does not spawn when the signal is already aborted", async (t) => {
    const { root } = await makeWorkspace(t);
    const controller = new AbortController();
    controller.abort();
    const result = await toolset(root, { signal: controller.signal }).bash.run({
      command: "touch should-not-exist",
    });
    assertToolError(result, /abort/i);
    assert.equal(await pathExists(path.join(root, "should-not-exist")), false);
  });

  test("reports a mid-command abort and prevents later command effects", async (t) => {
    const { root } = await makeWorkspace(t);
    const controller = new AbortController();
    const started = Date.now();
    const pending = toolset(root, { signal: controller.signal, bashTimeoutMs: 2_000 }).bash.run({
      command: "printf 'started'; sleep 5; touch should-not-exist",
    });
    setTimeout(() => controller.abort(), 60);
    const result = await pending;
    assertToolError(result, /abort/i);
    assert.match(result.content, /started/);
    assert.ok(Date.now() - started < 1_500, "abort did not stop the command promptly");
    assert.equal(await pathExists(path.join(root, "should-not-exist")), false);
  });

  test("truncates by UTF-8 bytes without splitting a code point", async (t) => {
    const { root } = await makeWorkspace(t);
    const script = 'process.stdout.write("€".repeat(150000))';
    const result = await toolset(root).bash.run({
      command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
    });
    assert.equal(result.isError, false);
    const marker = "\n… [output truncated]";
    assert.ok(result.content.endsWith(marker), "missing output truncation marker");
    const payload = result.content.slice(0, -marker.length);
    const bytes = Buffer.byteLength(payload, "utf8");
    assert.ok(bytes <= 100 * 1024, `captured ${bytes} bytes`);
    assert.ok(bytes > 100 * 1024 - 64, `captured only ${bytes} bytes`);
    assert.doesNotMatch(payload, /�/);
  });

  test("kills background children when a command times out", async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group behavior is POSIX-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    await fs.writeFile(path.join(root, "child-timeout-gate"), "wait");
    const result = await toolset(root, { bashTimeoutMs: 150 }).bash.run({
      command:
        "touch child-started; (while [ -e child-timeout-gate ]; do sleep 0.05; done; touch child-survived) & wait",
    });
    assertToolError(result, /timed out/i);
    assert.equal(await pathExists(path.join(root, "child-started")), true);
    await fs.unlink(path.join(root, "child-timeout-gate"));
    await delay(500);
    assert.equal(await pathExists(path.join(root, "child-survived")), false);
  });

  test("keeps a background server alive until the model turn cleanup", async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group behavior is POSIX-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    const cleanups = new Set<() => void>();
    const bash = toolset(root, {
      registerProcessCleanup: (cleanup) => {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      },
    }).bash;
    await bash.run({ command: "true" });
    assert.equal(cleanups.size, 0, "completed foreground commands must unregister cleanup");
    await fs.writeFile(path.join(root, "child-release-gate"), "wait");
    const result = await bash.run({
      command:
        "touch successful-child-started; (touch child-available; while [ -e child-release-gate ]; do sleep 0.05; done; touch child-leaked) >/dev/null 2>&1 &",
    });
    assert.equal(result.isError, false);
    assert.equal(cleanups.size, 1);
    assert.equal(await pathExists(path.join(root, "successful-child-started")), true);
    await waitFor(
      () => pathExists(path.join(root, "child-available")),
      "background child did not become available",
    );
    for (const cleanup of cleanups) cleanup();
    assert.equal(cleanups.size, 0);
    await fs.unlink(path.join(root, "child-release-gate"));
    await delay(1_000);
    assert.equal(await pathExists(path.join(root, "child-leaked")), false);
  });

  test("retires a retained cleanup after the background group exits naturally", async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group behavior is POSIX-specific");
      return;
    }
    const { root } = await makeWorkspace(t);
    const cleanups = new Set<() => void>();
    const bash = toolset(root, {
      registerProcessCleanup: (cleanup) => {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      },
    }).bash;

    await fs.writeFile(path.join(root, "natural-exit-gate"), "wait");
    const result = await bash.run({
      command:
        "(touch short-child-started; while [ -e natural-exit-gate ]; do sleep 0.05; done) >/dev/null 2>&1 &",
    });
    assert.equal(result.isError, false);
    assert.equal(cleanups.size, 1);
    await waitFor(
      () => pathExists(path.join(root, "short-child-started")),
      "short-lived background child did not start",
    );
    await fs.unlink(path.join(root, "natural-exit-gate"));
    await waitFor(
      () => cleanups.size === 0,
      "cleanup remained registered after its original process group exited",
    );
    assert.equal(await pathExists(path.join(root, "short-child-started")), true);
  });
});
