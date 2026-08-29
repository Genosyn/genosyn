import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentTool, ToolResult } from "../types.js";

/**
 * Read-only access to the source snapshot shipped with the running Genosyn
 * image. Help conversations get these tools as a resident working set so an
 * AI Employee can answer implementation questions from the actual release,
 * rather than from memory or a stale prose-only knowledge base.
 *
 * Local development resolves the repository one directory above App/. The
 * production image carries the same tree at /app/genosyn-source.
 */

const MAX_READ_BYTES = 400 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;
const MAX_WALK_FILES = 10_000;
const SOURCE_MANIFEST = ".genosyn-help-manifest";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".claude",
  ".playwright-cli",
  ".tmp",
  "coverage",
  "data",
  "dist",
  "node_modules",
]);
const DENIED_SOURCE_PATHS = new Set(["app/config.ts", "app/config.js"]);
const DENIED_SOURCE_BASENAMES = new Set([".env", ".npmrc", ".netrc"]);
const DENIED_FILES = new Set([
  SOURCE_MANIFEST,
  ".instance-secrets.json",
  ".instance-secrets.required",
]);

type HelpSource = {
  root: string | null;
  tools: AgentTool[];
  prompt: string;
};

export function createGenosynHelpSource(sourceRoot = resolveGenosynSourceRoot()): HelpSource {
  let root: string | null = null;
  try {
    root = sourceRoot ? fs.realpathSync(path.resolve(sourceRoot)) : null;
  } catch {
    root = null;
  }
  const publicPaths = root ? resolvePublicSourcePaths(root) : null;
  const safeRoot = root && publicPaths ? root : null;
  const availability = safeRoot
    ? "The complete source snapshot for this running Genosyn release is available through the three read-only source tools below."
    : "This installation does not contain its Genosyn source snapshot. Explain that limitation plainly and answer from the product context below without inventing implementation details.";

  return {
    root: safeRoot,
    tools: [
      listSourceTool(safeRoot, publicPaths),
      searchSourceTool(safeRoot, publicPaths),
      readSourceTool(safeRoot, publicPaths),
    ],
    prompt: [
      "",
      "## Genosyn Help",
      "This is the in-app Help surface. The teammate is asking how Genosyn works, how to use it, configure it, troubleshoot it, or understand its implementation.",
      "Answer as this AI Employee, but treat the shipped Genosyn product and source as the authority. Keep product terminology exact: AI Employee, Soul, Skill, Routine, Run, AI Model, Integration, Connection, and Grant.",
      availability,
      "",
      "Start with the in-app workflow and the labels the teammate can click. For implementation, deployment, configuration, or debugging questions, inspect the source before answering and cite the relevant repository paths in backticks.",
      "Use `AGENTS.md` for architecture and vocabulary, `ROADMAP.md` for shipped behavior and product decisions, `Home/client/docs/pages/` for user-facing documentation, `App/client/` for the product UI, `App/server/` for backend behavior, `CLI/` for operator commands, and `.github/workflows/` plus `RELEASING.md` for delivery.",
      "The source tools are read-only. Never claim you changed the Genosyn application from Help. If the teammate asks you to perform company work or modify one of their granted repositories, direct them to your ordinary Chat surface.",
      "Do not guess about a source-level fact you can verify with the tools. Do not dump large files into the answer; inspect only the relevant slices and synthesize a concise response.",
    ].join("\n"),
  };
}

/**
 * Build a strict public-source allowlist. Development reads only Git-tracked
 * paths; production reads the immutable manifest generated into the Docker
 * source snapshot. If neither authority exists, Help fails closed instead of
 * walking an arbitrary live directory.
 */
export function resolvePublicSourcePaths(root: string): Set<string> | null {
  const manifest = path.join(root, SOURCE_MANIFEST);
  let candidates: string[];
  try {
    if (fs.existsSync(manifest)) {
      candidates = fs.readFileSync(manifest, "utf8").split("\n");
    } else if (fs.existsSync(path.join(root, ".git"))) {
      const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      candidates = output.split("\0");
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const allowed = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    const normalized = normalizeSourcePath(candidate);
    if (!normalized || normalized === "." || sourcePathDenied(normalized)) continue;
    allowed.add(normalized);
  }
  return allowed.size > 0 ? allowed : null;
}

export function resolveGenosynSourceRoot(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "genosyn-source"),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd()),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "AGENTS.md")) &&
      fs.existsSync(path.join(candidate, "ROADMAP.md")) &&
      fs.existsSync(path.join(candidate, "App", "package.json"))
    ) {
      return candidate;
    }
  }
  return null;
}

function ok(content: string): ToolResult {
  return { content };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

function unavailable(): ToolResult {
  return fail("The Genosyn source snapshot is not available in this installation.");
}

function isDeniedSourcePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/").toLowerCase();
  if (DENIED_SOURCE_PATHS.has(normalized)) return true;
  const basename = path.posix.basename(normalized);
  return DENIED_SOURCE_BASENAMES.has(basename) || basename.startsWith(".env.");
}

async function resolveExisting(
  root: string,
  requested: string,
  publicPaths: Set<string>,
): Promise<{ path: string; relative: string } | { error: string }> {
  const raw = requested.trim() || ".";
  if (path.isAbsolute(raw)) {
    return { error: "Use a path relative to the Genosyn repository root." };
  }
  const normalized = normalizeSourcePath(raw);
  if (!normalized) {
    return { error: `Path escapes the Genosyn source snapshot: ${requested}` };
  }
  const relative = normalized;
  if (sourcePathDenied(relative) || !sourcePathAllowed(relative, publicPaths)) {
    return { error: `Source path is not part of the public release snapshot: ${requested}` };
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: `Path escapes the Genosyn source snapshot: ${requested}` };
  }
  try {
    const [realRoot, realTarget, targetStat] = await Promise.all([
      fsp.realpath(root),
      fsp.realpath(target),
      fsp.lstat(target),
    ]);
    if (targetStat.isSymbolicLink()) {
      return {
        error: `Symbolic links are not exposed by the public source snapshot: ${requested}`,
      };
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      return { error: `Path resolves outside the Genosyn source snapshot: ${requested}` };
    }
    const realRelative = path.relative(realRoot, realTarget).split(path.sep).join("/") || ".";
    if (realRelative !== relative) {
      return {
        error: `Symbolic paths are not exposed by the public source snapshot: ${requested}`,
      };
    }
    if (sourcePathDenied(realRelative)) {
      return { error: "That source path is unavailable from Help." };
    }
    return {
      path: realTarget,
      relative: realRelative,
    };
  } catch {
    return { error: `No such source path: ${requested}` };
  }
}

function normalizeSourcePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === ".") return normalized || ".";
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}

function sourcePathDenied(relative: string): boolean {
  if (relative === ".") return false;
  // Operators edit App/config.ts directly and it holds the live session and
  // encryption secrets. Environment and credential files are denied even when
  // they remain Git-tracked.
  if (isDeniedSourcePath(relative)) return true;
  const components = relative.split("/");
  if (
    components.some((component) => IGNORED_DIRECTORIES.has(component.toLowerCase()))
  ) {
    return true;
  }
  const filename = (components.at(-1) ?? "").toLowerCase();
  if (DENIED_FILES.has(filename) || filename.startsWith(".env")) return true;
  return false;
}

function sourcePathAllowed(relative: string, publicPaths: Set<string>): boolean {
  if (relative === ".") return true;
  if (publicPaths.has(relative)) return true;
  const prefix = relative.endsWith("/") ? relative : `${relative}/`;
  for (const candidate of publicPaths) {
    if (candidate.startsWith(prefix)) return true;
  }
  return false;
}

function listSourceTool(root: string | null, publicPaths: Set<string> | null): AgentTool {
  return {
    name: "list_genosyn_source",
    description:
      "List files and directories in the read-only source snapshot for the running Genosyn release. Paths are relative to the repository root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative directory to list. Defaults to the repository root.",
        },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      if (!root || !publicPaths) return unavailable();
      const resolved = await resolveExisting(root, String(input.path ?? "."), publicPaths);
      if ("error" in resolved) return fail(resolved.error);
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(resolved.path, { withFileTypes: true });
      } catch {
        return fail(`${resolved.relative} is not a directory.`);
      }
      const lines = entries
        .filter((entry) => {
          const relative =
            resolved.relative === "." ? entry.name : `${resolved.relative}/${entry.name}`;
          return !sourcePathDenied(relative) && sourcePathAllowed(relative, publicPaths);
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      return ok(lines.join("\n") || "(empty)");
    },
  };
}

function readSourceTool(root: string | null, publicPaths: Set<string> | null): AgentTool {
  return {
    name: "read_genosyn_source",
    description:
      "Read a UTF-8 file from the read-only source snapshot for the running Genosyn release. Use offset and limit for focused source citations.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path." },
        offset: { type: "number", description: "Optional 1-based starting line." },
        limit: { type: "number", description: "Optional maximum number of lines." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (!root || !publicPaths) return unavailable();
      const requested = String(input.path ?? "");
      const resolved = await resolveExisting(root, requested, publicPaths);
      if ("error" in resolved) return fail(resolved.error);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(resolved.path);
      } catch {
        return fail(`No such source file: ${requested}`);
      }
      if (!stat.isFile()) return fail(`${resolved.relative} is not a file.`);
      if (stat.size > MAX_READ_BYTES) {
        return fail(
          `${resolved.relative} is ${stat.size} bytes. Read a focused slice with offset and limit.`,
        );
      }
      let content: string;
      try {
        content = await fsp.readFile(resolved.path, "utf8");
      } catch (error) {
        return fail(
          `Could not read ${resolved.relative}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (content.includes("\0")) return fail(`${resolved.relative} is not a UTF-8 text file.`);
      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : undefined;
      const lines = content.split("\n");
      return ok(lines.slice(offset - 1, limit ? offset - 1 + limit : undefined).join("\n"));
    },
  };
}

function searchSourceTool(root: string | null, publicPaths: Set<string> | null): AgentTool {
  return {
    name: "search_genosyn_source",
    description:
      "Search paths and UTF-8 file contents across the read-only source snapshot for the running Genosyn release. Returns repository path, line number, and matching text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain text to search for." },
        path: {
          type: "string",
          description: "Optional repository-relative directory or file to search.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Match exact letter case. Defaults to false.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (!root || !publicPaths) return unavailable();
      const query = String(input.query ?? "");
      if (!query.trim()) return fail("query is required.");
      if (query.length > 500) return fail("query must be 500 characters or fewer.");
      const resolved = await resolveExisting(root, String(input.path ?? "."), publicPaths);
      if ("error" in resolved) return fail(resolved.error);
      const caseSensitive = input.case_sensitive === true;
      const needle = caseSensitive ? query : query.toLocaleLowerCase();
      const matches: string[] = [];
      let visited = 0;

      const inspect = async (filePath: string) => {
        if (matches.length >= MAX_SEARCH_MATCHES || visited >= MAX_WALK_FILES) return;
        visited += 1;
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return;
        const relative = path.relative(root, filePath).split(path.sep).join("/");
        if (sourcePathDenied(relative) || !publicPaths.has(relative)) return;
        const comparablePath = caseSensitive ? relative : relative.toLocaleLowerCase();
        if (comparablePath.includes(needle)) matches.push(`${relative}: path match`);
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        let content: string;
        try {
          content = await fsp.readFile(filePath, "utf8");
        } catch {
          return;
        }
        if (content.includes("\0")) return;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const comparable = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
          if (!comparable.includes(needle)) continue;
          matches.push(`${relative}:${index + 1}: ${lines[index].trim().slice(0, 500)}`);
          if (matches.length >= MAX_SEARCH_MATCHES) return;
        }
      };

      const walk = async (target: string): Promise<void> => {
        if (matches.length >= MAX_SEARCH_MATCHES || visited >= MAX_WALK_FILES) return;
        let stat: fs.Stats;
        try {
          stat = await fsp.lstat(target);
        } catch {
          return;
        }
        // Never follow snapshot symlinks during a recursive search. Direct
        // reads canonicalize their target in `resolveExisting`; recursive
        // traversal should not duplicate content or discover an external tree.
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) {
          await inspect(target);
          return;
        }
        if (!stat.isDirectory()) return;
        const entries = await fsp.readdir(target, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= MAX_SEARCH_MATCHES || visited >= MAX_WALK_FILES) return;
          const child = path.join(target, entry.name);
          const relative = path.relative(root, child).split(path.sep).join("/");
          if (sourcePathDenied(relative) || !sourcePathAllowed(relative, publicPaths)) continue;
          if (entry.isSymbolicLink()) continue;
          await walk(child);
        }
      };

      await walk(resolved.path);
      const suffix =
        matches.length >= MAX_SEARCH_MATCHES
          ? `\n… limited to ${MAX_SEARCH_MATCHES} matches`
          : visited >= MAX_WALK_FILES
            ? `\n… stopped after ${MAX_WALK_FILES} files`
            : "";
      return ok((matches.join("\n") || "(no matches)") + suffix);
    },
  };
}
