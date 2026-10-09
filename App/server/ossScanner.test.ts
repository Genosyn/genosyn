import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Genosyn is enrolled in Anthropic's OSS Scanner. The scanner builds
 * `.oss-scanner/Dockerfile` with the repository root as its build context and
 * network access, adds its own layer, then scans the finished image with no
 * network, reading `.oss-scanner/threat_model.md` before it starts. Nothing in
 * this repository's CI builds that image, so these tests pin the contract it
 * depends on: the image is built the way this repository builds itself, a slow
 * or failing test can never fail the scanner's build, the build context still
 * carries what a scan needs, and the threat model cites only files and scripts
 * that exist.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNER_DOCKERFILE = ".oss-scanner/Dockerfile";
const THREAT_MODEL = ".oss-scanner/threat_model.md";
const SECURITY_CONTACT = "security@genosyn.com";
/** The scanner's limit on a Dockerfile or threat model kept beside project.yaml. */
const SCANNER_FILE_LIMIT_BYTES = 64 * 1024;
/**
 * The scanner gives a whole build 45 minutes. Tests may take at most this much
 * of it in the worst case, leaving the rest for installing and building.
 */
const TEST_BUDGET_SECONDS = 30 * 60;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

// ---------------------------------------------------------------------------
// Dockerfile parsing
// ---------------------------------------------------------------------------

type Instruction = {
  /** Upper-case keyword: FROM, RUN, COPY, ... */
  keyword: string;
  /** Arguments with continuation lines joined, as the shell receives them. */
  raw: string;
  /** The same with whitespace collapsed, for matching. */
  text: string;
  line: number;
};

/**
 * Split a Dockerfile into instructions the way BuildKit does for the syntax
 * these files use: comment lines (and the `# syntax=` directive) and blank
 * lines are dropped, even inside a continued instruction, and a trailing
 * backslash joins the next line.
 */
function parseDockerfile(source: string): Instruction[] {
  const instructions: Instruction[] = [];
  let pending: { keyword: string; parts: string[]; line: number } | null = null;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const continues = /\\\s*$/.test(line);
    const body = continues ? line.replace(/\\\s*$/, "") : line;
    if (pending) {
      pending.parts.push(body);
    } else {
      const match = /^\s*([A-Za-z]+)\s+(.*)$/.exec(body);
      assert.ok(match, `Dockerfile line ${index + 1} does not start an instruction: ${line}`);
      pending = { keyword: match[1].toUpperCase(), parts: [match[2]], line: index + 1 };
    }
    if (!continues) {
      const raw = pending.parts.join(" ");
      instructions.push({
        keyword: pending.keyword,
        raw,
        text: raw.replace(/\s+/g, " ").trim(),
        line: pending.line,
      });
      pending = null;
    }
  }
  assert.equal(pending, null, "the Dockerfile ends inside a continued instruction");
  return instructions;
}

function nodeImages(instructions: Instruction[]): string[] {
  return instructions
    .filter((instruction) => instruction.keyword === "FROM")
    .map((instruction) => instruction.text.split(" ")[0])
    .filter((image) => /^(docker\.io\/library\/)?node:/.test(image));
}

/** The Node major a `node:<tag>` image runs, e.g. 22 for node:22-bookworm-slim. */
function nodeMajor(image: string): string {
  const match = /node:(\d+)/.exec(image);
  assert.ok(match, `${image} does not pin a Node major`);
  return match[1];
}

/** The Debian release a `node:<tag>` image is built on, e.g. bookworm. */
function debianRelease(image: string): string | null {
  return /-(bookworm|bullseye|buster|trixie|forky)(-slim)?$/.exec(image)?.[1] ?? null;
}

/** Seconds a `timeout [-k N] DURATION` bound allows, or null when there is none. */
function timeoutSeconds(command: string): number | null {
  const match = /\btimeout\s+(?:-k\s+\S+\s+|--kill-after=\S+\s+|-s\s+\S+\s+)*(\d+)([smh]?)\s/.exec(
    command,
  );
  if (!match) return null;
  const unit = { "": 1, s: 1, m: 60, h: 3600 }[match[2] as "" | "s" | "m" | "h"];
  return Number(match[1]) * unit;
}

// ---------------------------------------------------------------------------
// Running one RUN instruction against fakes
// ---------------------------------------------------------------------------

/**
 * Stand-ins for the commands a RUN step reaches for. Each scenario picks their
 * behavior through the environment, so a step can be made to see a failing
 * test, a test that hits its bound, a crashing or silent server, and so on.
 * `npx` and `apt-get` refuse outright: no simulated step may install anything.
 */
const REAL_SLEEP = ["/bin/sleep", "/usr/bin/sleep"].find((candidate) => fs.existsSync(candidate));
const FAKE_TOOLS: Record<string, string[]> = {
  timeout: [
    "#!/bin/sh",
    "# Drop timeout's own options and duration, then run the command, unless the",
    "# scenario says the bound was reached.",
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    -k|-s) shift 2 ;;",
    "    -*) shift ;;",
    "    *) break ;;",
    "  esac",
    "done",
    "shift",
    'if [ "${FAKE_TIMEOUT_REACHED:-0}" = 1 ]; then echo "fake timeout: bound reached"; exit 124; fi',
    'exec "$@"',
  ],
  npm: [
    "#!/bin/sh",
    'echo "fake npm $*"',
    'case "$1 $2" in',
    '  "test "*|"run test"*) exit "${FAKE_TEST_EXIT:-0}" ;;',
    "esac",
    'exit "${FAKE_NPM_EXIT:-0}"',
  ],
  node: [
    "#!/bin/sh",
    'if [ "$1" = "-p" ]; then echo "${FAKE_NODE_PRINT:-}"; exit 0; fi',
    "# The App writes its database and instance secrets as it boots.",
    "mkdir -p data && echo '{}' > data/.instance-secrets.json",
    'echo "fake server: ${FAKE_SERVER:-crash}"',
    `if [ "\${FAKE_SERVER:-crash}" = serve ]; then exec ${REAL_SLEEP ?? "sleep"} 30; fi`,
    "exit 1",
  ],
  curl: ["#!/bin/sh", 'exit "${FAKE_CURL_EXIT:-7}"'],
  sleep: ["#!/bin/sh", "exit 0"],
  npx: [
    "#!/bin/sh",
    "# Only the test runner is simulated; anything else would install or download.",
    'case " $* " in',
    '  *" tsx --test "*) echo "fake test runner $*"; exit "${FAKE_TEST_EXIT:-0}" ;;',
    "esac",
    'echo "npx is not simulated: $*"',
    "exit 97",
  ],
  "apt-get": ["#!/bin/sh", 'echo "apt-get is not simulated: $*"', "exit 97"],
};

const PACKAGES_IN_SANDBOX = ["App", "Connect", "Home"];
/** `/src` as a path of its own in a shell command, not as part of a longer one. */
const IMAGE_SRC_PATH = /(^|[\s;&|(=])\/src(?=[/\s;]|$)/;
/** System directories a simulated step must never reach (the sandbox itself may live in /var). */
const HOST_SYSTEM_PATH = /(^|[\s;&|(>=])\/(var\/(lib|log|cache)|etc|usr|opt|root)\b/;
const sandboxes: string[] = [];
after(() => {
  for (const sandbox of sandboxes) fs.rmSync(sandbox, { recursive: true, force: true });
});

type Simulation = { status: number | null; output: string; src: string };

/**
 * Run one RUN instruction's shell command as the image build would, with /src
 * and the test-log directory moved into a temporary directory and the slow,
 * networked, or installing commands replaced by FAKE_TOOLS. The shell starts
 * in an empty directory of the sandbox, so even a failed `cd` stays inside it.
 */
function simulate(
  instruction: Instruction,
  env: Record<string, string>,
  prepare?: (src: string) => void,
): Simulation {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-oss-scanner-"));
  sandboxes.push(sandbox);
  const bin = path.join(sandbox, "bin");
  const src = path.join(sandbox, "src");
  const logs = path.join(sandbox, "logs");
  const cwd = path.join(sandbox, "cwd");
  for (const directory of [bin, logs, cwd, ...PACKAGES_IN_SANDBOX.map((p) => path.join(src, p))]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const [name, lines] of Object.entries(FAKE_TOOLS)) {
    fs.writeFileSync(path.join(bin, name), `${lines.join("\n")}\n`, { mode: 0o755 });
  }
  prepare?.(src);

  const command = instruction.raw
    .replaceAll("/var/log/genosyn-tests", logs)
    .replace(new RegExp(IMAGE_SRC_PATH.source, "g"), `$1${src}`);
  assert.doesNotMatch(command, IMAGE_SRC_PATH, "every /src path must be moved into the sandbox");
  assert.doesNotMatch(command, HOST_SYSTEM_PATH, "no simulated step may touch the host's system");

  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: sandbox, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, src };
}

// ---------------------------------------------------------------------------
// .dockerignore matching
// ---------------------------------------------------------------------------

type IgnoreRule = { exclude: boolean; pattern: RegExp; source: string };

/** Docker's .dockerignore glob: `**` spans directories, `*` and `?` stay within one. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function dockerignoreRules(source: string): IgnoreRule[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const exclude = !line.startsWith("!");
      const glob = (exclude ? line : line.slice(1)).trim().replace(/^\.?\/+/, "");
      return { exclude, pattern: globToRegExp(glob), source: line };
    });
}

/**
 * Whether Docker leaves `file` out of the build context: the last rule that
 * matches the file, or any directory above it, decides.
 */
function excludedFromContext(rules: IgnoreRule[], file: string): boolean {
  const parts = file.split("/");
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.pattern.test(candidate))) excluded = rule.exclude;
  }
  return excluded;
}

// ---------------------------------------------------------------------------
// The repository's files and packages
// ---------------------------------------------------------------------------

/**
 * Dependencies, build output, and local tool state: never sources, rebuilt
 * inside the image, and left out of the build context on purpose.
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "data",
  "coverage",
  ".cache",
  ".vite",
  ".turbo",
  ".next",
  ".claude",
]);

/** Every file under `root`, as repository-relative paths, skipping SKIPPED_DIRECTORIES. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
      } else {
        found.push(child);
      }
    }
  };
  walk(root);
  return found;
}

type PackageJson = {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
};

function packageJson(relativePath: string): PackageJson {
  return JSON.parse(read(relativePath)) as PackageJson;
}

/** Top-level folders that hold an npm package with a build script. */
function buildablePackages(): string[] {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => exists(`${name}/package.json`))
    .filter((name) => Boolean(packageJson(`${name}/package.json`).scripts?.build))
    .sort();
}

// ---------------------------------------------------------------------------
// The scanner image
// ---------------------------------------------------------------------------

test("the Dockerfile parser reads instructions the way BuildKit does", () => {
  const parsed = parseDockerfile(
    [
      "# syntax=docker/dockerfile:1.7",
      "FROM node:22-bookworm-slim AS base",
      "",
      "RUN echo one \\",
      "    # a comment inside the instruction is dropped",
      "",
      '    && echo "two  spaces"',
      "COPY . /src",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.map(({ keyword, text, line }) => ({ keyword, text, line })),
    [
      { keyword: "FROM", text: "node:22-bookworm-slim AS base", line: 2 },
      { keyword: "RUN", text: 'echo one && echo "two spaces"', line: 4 },
      { keyword: "COPY", text: ". /src", line: 8 },
    ],
  );
  assert.equal(parsed[1].raw, 'echo one      && echo "two  spaces"');
  assert.throws(() => parseDockerfile("RUN echo \\\n"), /ends inside a continued instruction/);
  assert.equal(nodeMajor("node:22-bookworm-slim"), "22");
  assert.equal(debianRelease("node:22-bookworm-slim"), "bookworm");
  assert.equal(debianRelease("node:22-alpine"), null);
  assert.equal(timeoutSeconds("timeout -k 30 180 npm test"), 180);
  assert.equal(timeoutSeconds("timeout 15m npm test"), 900);
  assert.equal(timeoutSeconds("npm test"), null);
});

describe("the OSS Scanner image (.oss-scanner/Dockerfile)", () => {
  const source = read(SCANNER_DOCKERFILE);
  const instructions = parseDockerfile(source);
  const runs = instructions.filter((instruction) => instruction.keyword === "RUN");
  const packages = buildablePackages();
  const testRuns = runs.filter((run) => /\bnpm (run )?test\b|\btsx --test\b/.test(run.text));
  const bootRun = runs.find((run) => run.text.includes("/api/health"));
  const runtimeRun = runs.find((run) => run.text.includes("opencode --version"));

  test("is a non-empty Dockerfile within the scanner's file limit", () => {
    assert.ok(instructions.length > 0);
    assert.ok(
      Buffer.byteLength(source) <= SCANNER_FILE_LIMIT_BYTES,
      `${SCANNER_DOCKERFILE} must stay under ${SCANNER_FILE_LIMIT_BYTES} bytes`,
    );
    assert.equal(instructions[0].keyword, "FROM", "the first instruction must choose a base image");
  });

  test("runs the Node major pinned in .nvmrc, like the other images, the root engines, and CI", () => {
    const nvmrc = /^v?(\d+)/.exec(read(".nvmrc").trim());
    assert.ok(nvmrc, ".nvmrc must name a Node major");
    const major = nvmrc[1];

    for (const dockerfile of [
      SCANNER_DOCKERFILE,
      "App/Dockerfile",
      "Home/Dockerfile",
      "Connect/Dockerfile",
    ]) {
      const images = nodeImages(parseDockerfile(read(dockerfile)));
      assert.ok(images.length > 0, `${dockerfile} must build on an official node image`);
      for (const image of images) {
        assert.equal(nodeMajor(image), major, `${dockerfile} uses ${image}; .nvmrc says ${major}`);
      }
    }

    const ci = read(".github/workflows/lint.yml");
    const ciVersions = [...ci.matchAll(/node-version:\s*"?(\d+)/g)].map((match) => match[1]);
    assert.ok(ciVersions.length > 0, "lint.yml must pin a Node version");
    for (const version of ciVersions)
      assert.equal(version, major, "CI must test on the .nvmrc major");

    assert.equal(packageJson("package.json").engines?.node, `${major}.x`);
  });

  test("builds on the same Debian release as the App image, so native addons match", () => {
    const scannerImages = nodeImages(instructions);
    const appImages = nodeImages(parseDockerfile(read("App/Dockerfile")));
    const appRuntime = appImages[appImages.length - 1];
    const scannerFinal = scannerImages[scannerImages.length - 1];
    assert.ok(debianRelease(appRuntime), `App/Dockerfile's runtime ${appRuntime} must be Debian`);
    assert.equal(debianRelease(scannerFinal), debianRelease(appRuntime));
  });

  test("puts the checkout at /src and builds there", () => {
    assert.ok(
      instructions.some((i) => i.keyword === "COPY" && i.text === ". /src"),
      "the scanner contract is `COPY . /src`",
    );
    const workdirs = instructions.filter((i) => i.keyword === "WORKDIR");
    assert.equal(workdirs[workdirs.length - 1]?.text, "/src", "the image must end up in /src");
    assert.ok(
      !instructions.some((i) => i.keyword === "USER"),
      "the scan runs as root; a USER switch would only hide files from it",
    );
  });

  test("installs and builds every top-level package from its lockfile", () => {
    assert.deepEqual(packages, ["App", "Connect", "Home"]);
    for (const name of packages) {
      assert.ok(exists(`${name}/package-lock.json`), `${name} must ship a lockfile for npm ci`);
      assert.ok(
        instructions.some(
          (i) =>
            i.keyword === "COPY" &&
            i.text === `${name}/package.json ${name}/package-lock.json /src/${name}/`,
        ),
        `${name}'s manifests must be copied before its dependencies are installed`,
      );
      assert.ok(
        runs.some((run) => new RegExp(`^cd /src/${name} && npm ci\\b`).test(run.text)),
        `${name} must be installed with npm ci`,
      );
      assert.ok(
        runs.some((run) => run.text === `cd /src/${name} && npm run build`),
        `${name} must be built with its own build script`,
      );
    }
  });

  test("lets a failed install or build fail the image, so the scanner reports it", () => {
    const buildRuns = runs.filter((run) =>
      /^cd \/src\/\w+ && npm (ci|run build)\b[^;|&]*$/.test(run.text),
    );
    assert.equal(buildRuns.length, packages.length * 2);
    for (const run of buildRuns) {
      const failing = simulate(run, { FAKE_NPM_EXIT: "1" });
      assert.notEqual(failing.status, 0, `"${run.text}" must fail the build when npm fails`);
      const passing = simulate(run, { FAKE_NPM_EXIT: "0" });
      assert.equal(
        passing.status,
        0,
        `"${run.text}" should pass when npm passes: ${passing.output}`,
      );
    }
  });

  test("runs every package's tests, each bounded by timeout and logged", () => {
    for (const name of packages) {
      if (!packageJson(`${name}/package.json`).scripts?.test) continue;
      const run = testRuns.find((candidate) => candidate.text.startsWith(`cd /src/${name};`));
      assert.ok(run, `${name}'s tests must run in the image`);
      assert.ok(timeoutSeconds(run.text), `${name}'s tests must be bounded by timeout`);
      assert.match(
        run.text,
        new RegExp(`> /var/log/genosyn-tests/${name.toLowerCase()}\\.log 2>&1`),
        `${name}'s full test log must be kept in the image`,
      );
      assert.doesNotMatch(run.text, /\bset -e|errexit/, "a test step must not stop on errors");
    }
  });

  test("runs the App's tests the way npm test does, naming only files that exist", () => {
    const run = testRuns.find((candidate) => candidate.text.startsWith("cd /src/App;"));
    assert.ok(run, "the App's tests must run in the image");
    if (/\bnpm (run )?test\b/.test(run.text)) return; // the whole suite needs no checks

    // A slice must load the same HTTP setup `npm test` loads, or route tests
    // would fail for reasons the real suite does not have.
    const setup = /--import\s+(\S+)/.exec(packageJson("App/package.json").scripts?.test ?? "")?.[1];
    assert.ok(setup, "App's npm test must load its HTTP setup with --import");
    assert.ok(
      run.text.includes(`tsx --test --import ${setup} `),
      "the slice must run like npm test",
    );

    const patterns = [...run.raw.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value) => value.endsWith(".test.ts"));
    assert.ok(patterns.length >= 10, `expected a slice of the suite, saw ${patterns.length}`);
    assert.ok(
      patterns.includes("server/ossScanner.test.ts"),
      "the image must check its own contract",
    );
    const appFiles = filesUnder("App/server").map((file) => file.slice("App/".length));
    for (const pattern of patterns) {
      const glob = globToRegExp(pattern);
      assert.ok(
        appFiles.some((file) => glob.test(file)),
        `${pattern} matches no test file: rename it in ${SCANNER_DOCKERFILE} along with the test`,
      );
    }
  });

  test("never fails the build because a test failed or hit its bound", () => {
    assert.ok(testRuns.length >= 3);
    for (const run of testRuns) {
      const passing = simulate(run, { FAKE_TEST_EXIT: "0" });
      assert.equal(passing.status, 0, passing.output);
      assert.doesNotMatch(passing.output, /WARNING/);

      for (const [scenario, env] of [
        ["a failing test", { FAKE_TEST_EXIT: "1" }],
        ["a test that hits its bound", { FAKE_TIMEOUT_REACHED: "1" }],
      ] as const) {
        const result = simulate(run, env);
        assert.equal(result.status, 0, `${scenario} must not fail "${run.text}": ${result.output}`);
        assert.match(result.output, /WARNING/, `${scenario} must be reported as a WARNING`);
      }
    }
  });

  test("keeps the worst case of every test bound inside the scanner's build limit", () => {
    let worstCase = 0;
    for (const run of testRuns) worstCase += timeoutSeconds(run.text) ?? Infinity;
    assert.ok(bootRun, "the image must check that the App boots");
    const polls = /\bseq 1 (\d+)/.exec(bootRun.text);
    assert.ok(polls, "the boot check must poll a bounded number of times");
    worstCase += Number(polls[1]);
    assert.ok(
      worstCase <= TEST_BUDGET_SECONDS,
      `tests may take ${worstCase}s in the worst case; the budget is ${TEST_BUDGET_SECONDS}s`,
    );
  });

  test("boots the App against a fresh database, reports the result, and keeps no data", () => {
    assert.ok(bootRun, "the image must check that the App boots");
    assert.match(bootRun.text, /^cd \/src\/App;/);
    assert.match(bootRun.text, /NODE_ENV=production node dist\/server\/index\.js/);

    for (const [scenario, env, healthy] of [
      ["a healthy server", { FAKE_SERVER: "serve", FAKE_CURL_EXIT: "0" }, true],
      ["a server that crashes on boot", { FAKE_SERVER: "crash" }, false],
      ["a server that never answers", { FAKE_SERVER: "serve", FAKE_CURL_EXIT: "7" }, false],
    ] as const) {
      const result = simulate(bootRun, env);
      assert.equal(result.status, 0, `${scenario} must not fail the build: ${result.output}`);
      if (healthy) assert.doesNotMatch(result.output, /WARNING/, scenario);
      else assert.match(result.output, /WARNING/, `${scenario} must be reported as a WARNING`);
      assert.ok(
        !fs.existsSync(path.join(result.src, "App", "data")),
        `${scenario}: the throwaway database and instance secrets must not stay in the image`,
      );
    }
  });

  test("reports the pinned agent runtime without failing the build", () => {
    assert.ok(runtimeRun, "the image must report the OpenCode it installed");
    assert.match(runtimeRun.text, /require\('\.\/package\.json'\)\.dependencies\['opencode-ai'\]/);
    const pinned = packageJson("App/package.json").dependencies?.["opencode-ai"];
    assert.ok(pinned, "App/package.json must pin opencode-ai");

    const binaries = (opencodeVersion: string | null) => (src: string) => {
      const bin = path.join(src, "App", "node_modules", ".bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.0.0\n", {
        mode: 0o755,
      });
      if (opencodeVersion !== null) {
        fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\necho ${opencodeVersion}\n`, {
          mode: 0o755,
        });
      }
    };
    for (const [scenario, version, warns] of [
      ["the pinned OpenCode", pinned, false],
      ["another OpenCode", "0.0.1", true],
      ["no OpenCode at all", null, true],
    ] as const) {
      const result = simulate(runtimeRun, { FAKE_NODE_PRINT: pinned }, binaries(version));
      assert.equal(result.status, 0, `${scenario} must not fail the build: ${result.output}`);
      if (warns) assert.match(result.output, /WARNING/, `${scenario} must be reported`);
      else assert.doesNotMatch(result.output, /WARNING/, scenario);
    }
  });

  test("bakes in no secrets or operator values", () => {
    for (const instruction of instructions) {
      if (instruction.keyword === "ENV" || instruction.keyword === "ARG") {
        assert.doesNotMatch(
          instruction.text,
          /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE)/i,
          `line ${instruction.line} must not set a credential`,
        );
      }
      if (instruction.keyword === "COPY" || instruction.keyword === "ADD") {
        assert.doesNotMatch(instruction.text, /Helm\/Values|(^|\s)(App\/)?data\b/);
      }
    }
    assert.doesNotMatch(source, /--mount=type=secret/);
  });
});

// ---------------------------------------------------------------------------
// The build context
// ---------------------------------------------------------------------------

describe("the root .dockerignore, which the scanner's build context obeys", () => {
  const rules = dockerignoreRules(read(".dockerignore"));

  test("matches the way Docker does for the patterns it uses", () => {
    const sample = dockerignoreRules(
      "# comment\n**/dist\n!App/dist/keep.txt\nHelm/Values/*.yaml\n/.git\n",
    );
    assert.equal(excludedFromContext(sample, "App/dist/server/index.js"), true);
    assert.equal(excludedFromContext(sample, "dist"), true);
    assert.equal(excludedFromContext(sample, "App/dist/keep.txt"), false, "a later ! rule wins");
    assert.equal(excludedFromContext(sample, "App/distribution.ts"), false);
    assert.equal(excludedFromContext(sample, "Helm/Values/prod.values.yaml"), true);
    assert.equal(excludedFromContext(sample, "Helm/Values/README.md"), false);
    assert.equal(excludedFromContext(sample, "Helm/Values/nested/x.yaml"), false, "* stays in one");
    assert.equal(excludedFromContext(sample, ".git/config"), true);
    assert.equal(
      excludedFromContext(sample, "App/.git"),
      false,
      "patterns are rooted, not basenames",
    );
    assert.equal(excludedFromContext(sample, "# comment"), false);
  });

  test("keeps every source, test, lockfile, and document a scan needs", () => {
    for (const file of [
      "AGENTS.md",
      "VERSION",
      "SECURITY.md",
      SCANNER_DOCKERFILE,
      THREAT_MODEL,
      "App/config.ts",
      "App/package.json",
      "App/package-lock.json",
      "App/server/index.ts",
      "App/server/middleware/auth.ts",
      "App/server/middleware/auth.test.ts",
      "App/server/test/httpSetup.ts",
      "App/scripts/test-passkey-signin.ts",
      "Connect/package-lock.json",
      "Connect/src/index.ts",
      "Connect/tests/http.test.ts",
      "Home/package-lock.json",
      "Home/tests/catalogue.test.ts",
      "CLI/genosyn",
      "CLI/install.sh",
      "Helm/genosyn/values.yaml",
    ]) {
      assert.ok(exists(file), `${file} should exist`);
      assert.equal(
        excludedFromContext(rules, file),
        false,
        `.dockerignore must not exclude ${file}`,
      );
    }
  });

  test("excludes no file under the source and test trees", () => {
    // Generated by Home's sync-cli step from CLI/, which is in the context.
    const generated = new Set(["Home/client/public/genosyn", "Home/client/public/install.sh"]);
    const files = [
      "App/server",
      "App/client",
      "App/shared",
      "App/scripts",
      "Connect/src",
      "Connect/tests",
      "Home/client",
      "Home/tests",
      "CLI",
      ".oss-scanner",
    ]
      .flatMap(filesUnder)
      .filter((file) => !file.endsWith("/.DS_Store") && !generated.has(file));
    assert.ok(files.length > 500, `expected to walk the source trees, saw ${files.length} files`);
    assert.deepEqual(
      files.filter((file) => excludedFromContext(rules, file)),
      [],
    );
  });

  test("still keeps operator values, local state, and build output out of every image", () => {
    for (const file of [
      ".git/config",
      "Helm/Values/prod.values.yaml",
      "Helm/Values/test.values.yaml",
      "App/data/app.sqlite",
      "App/data/.instance-secrets.json",
      "App/node_modules/express/package.json",
      "App/dist/server/index.js",
      ".claude/settings.json",
      ".tmp/scratch.txt",
    ]) {
      assert.equal(excludedFromContext(rules, file), true, `.dockerignore must exclude ${file}`);
    }
  });
});

// ---------------------------------------------------------------------------
// What the scanner and reporters read
// ---------------------------------------------------------------------------

describe("the threat model the scanner reads first", () => {
  const threatModel = read(THREAT_MODEL);

  test("fits the scanner's file limit", () => {
    assert.ok(threatModel.trim().length > 0);
    assert.ok(Buffer.byteLength(threatModel) <= SCANNER_FILE_LIMIT_BYTES);
  });

  test("answers each question the scanner's template asks", () => {
    for (const heading of [
      "What Genosyn is and where untrusted input enters",
      "What is by design, not a vulnerability",
      "Components that matter most / least",
      "How to exercise it",
      "How we rate severity",
      "Anything to leave alone",
    ]) {
      assert.ok(
        threatModel.split("\n").some((line) => line.startsWith(`## ${heading}`)),
        `${THREAT_MODEL} must have a "## ${heading}" section`,
      );
    }
  });

  test("states the trust model a report is judged against", () => {
    assert.match(threatModel, /no OS sandbox/);
    assert.match(threatModel, /single-tenant/);
    assert.match(threatModel, /master admin/);
    assert.match(threatModel, /Genosyn Connect/);
  });

  test("cites only repository paths that exist", () => {
    const cited = [...threatModel.matchAll(/`([^`\s]+)`/g)]
      .map((match) => match[1])
      .filter((token) =>
        /^(App|Connect|Home|CLI|Helm|\.oss-scanner|\.github)\/|^[A-Z]+\.md$/.test(token),
      )
      // Runtime and build output exist only once the App has been built or run.
      .filter((token) => !/(^|\/)(data|dist|node_modules)(\/|$)/.test(token))
      .filter((token) => !/[*<>{}]/.test(token));
    assert.ok(
      cited.length >= 20,
      `expected the threat model to cite its sources, saw ${cited.length}`,
    );
    const missing = cited.filter((token) => !exists(token.replace(/\/$/, "")));
    assert.deepEqual(missing, [], "every path the threat model cites must exist");
  });

  test("tells the scanner to run only npm scripts that exist", () => {
    const scripts = new Set(
      ["App", "Connect", "Home"].flatMap((name) =>
        Object.keys(packageJson(`${name}/package.json`).scripts ?? {}),
      ),
    );
    // A placeholder such as `npm run test:<name>` names no script.
    const named = [...threatModel.matchAll(/npm run ([\w:-]+)(?![\w:<-])/g)].map(
      (match) => match[1],
    );
    assert.ok(named.length > 0);
    for (const script of named) assert.ok(scripts.has(script), `npm run ${script} does not exist`);
  });
});

describe("SECURITY.md", () => {
  const policy = read("SECURITY.md");

  test("sends vulnerability reports privately to the security contact", () => {
    assert.match(policy, new RegExp(SECURITY_CONTACT.replace(/[.]/g, "\\.")));
    assert.match(policy, /public (GitHub )?issue/i);
  });

  test("says which versions receive fixes", () => {
    assert.match(policy, /^## Supported versions$/m);
    assert.match(policy, /latest release/i);
  });

  test("points reporters at the threat model for what is by design", () => {
    assert.ok(policy.includes(THREAT_MODEL));
  });
});

describe("the repository guide and CI know about the scanner files", () => {
  test("AGENTS.md lists .oss-scanner/ and SECURITY.md in the repo layout", () => {
    const agents = read("AGENTS.md");
    const start = agents.indexOf("## 2. Repo layout");
    const end = agents.indexOf("## 3.", start);
    assert.ok(start >= 0 && end > start, "AGENTS.md must keep its repo layout section");
    const layout = agents.slice(start, end);
    assert.match(layout, /├── \.oss-scanner\//);
    assert.match(layout, /SECURITY\.md/);
  });

  test("the Lint workflow runs these tests when only the scanner files change", () => {
    const lint = read(".github/workflows/lint.yml");
    for (const trigger of ['".oss-scanner/**"', '".dockerignore"', '".nvmrc"', '"SECURITY.md"']) {
      const count = lint.split(`- ${trigger}`).length - 1;
      assert.equal(count, 2, `lint.yml must run on ${trigger} for pushes and pull requests`);
    }
  });
});
