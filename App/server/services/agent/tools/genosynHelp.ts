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

type HelpSource = {
  root: string | null;
  tools: AgentTool[];
  prompt: string;
};

export function createGenosynHelpSource(sourceRoot = resolveGenosynSourceRoot()): HelpSource {
  const root = sourceRoot ? fs.realpathSync(path.resolve(sourceRoot)) : null;
  const availability = root
    ? "The complete source snapshot for this running Genosyn release is available through the three read-only source tools below."
    : "This installation does not contain its Genosyn source snapshot. Explain that limitation plainly and answer from the product context below without inventing implementation details.";

  return {
    root,
    tools: [listSourceTool(root), searchSourceTool(root), readSourceTool(root)],
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
  const normalized = relativePath.split(path.sep).join("/").toLocaleLowerCase();
  if (DENIED_SOURCE_PATHS.has(normalized)) return true;
  const basename = path.posix.basename(normalized);
  return DENIED_SOURCE_BASENAMES.has(basename) || basename.startsWith(".env.");
}

async function resolveExisting(
  root: string,
  requested: string,
): Promise<{ path: string; relative: string } | { error: string }> {
  const relative = requested.trim() || ".";
  if (path.isAbsolute(relative)) {
    return { error: "Use a path relative to the Genosyn repository root." };
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: `Path escapes the Genosyn source snapshot: ${requested}` };
  }
  try {
    const [realRoot, realTarget] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      return { error: `Path resolves outside the Genosyn source snapshot: ${requested}` };
    }
    const resolvedRelative = path.relative(realRoot, realTarget) || ".";
    if (isDeniedSourcePath(resolvedRelative)) {
      return { error: "That source path is unavailable from Help." };
    }
    return {
      path: realTarget,
      relative: resolvedRelative,
    };
  } catch {
    return { error: `No such source path: ${requested}` };
  }
}

function listSourceTool(root: string | null): AgentTool {
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
      if (!root) return unavailable();
      const resolved = await resolveExisting(root, String(input.path ?? "."));
      if ("error" in resolved) return fail(resolved.error);
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(resolved.path, { withFileTypes: true });
      } catch {
        return fail(`${resolved.relative} is not a directory.`);
      }
      const lines = entries
        .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
        .filter(
          (entry) =>
            !isDeniedSourcePath(
              resolved.relative === "." ? entry.name : path.join(resolved.relative, entry.name),
            ),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      return ok(lines.join("\n") || "(empty)");
    },
  };
}

function readSourceTool(root: string | null): AgentTool {
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
      if (!root) return unavailable();
      const requested = String(input.path ?? "");
      const resolved = await resolveExisting(root, requested);
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

function searchSourceTool(root: string | null): AgentTool {
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
      if (!root) return unavailable();
      const query = String(input.query ?? "");
      if (!query.trim()) return fail("query is required.");
      if (query.length > 500) return fail("query must be 500 characters or fewer.");
      const resolved = await resolveExisting(root, String(input.path ?? "."));
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
        const relative = path.relative(root, filePath);
        if (isDeniedSourcePath(relative)) return;
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
          if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
          const child = path.join(target, entry.name);
          if (isDeniedSourcePath(path.relative(root, child))) continue;
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
