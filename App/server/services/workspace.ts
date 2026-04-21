import fs from "node:fs";
import path from "node:path";
import { employeeDir } from "./paths.js";

/**
 * Employee workspace = everything under `data/companies/<co>/employees/<emp>/`.
 *
 * This is what the AI employee's CLI sees as cwd when a routine or chat runs,
 * so it's the natural place to give a human a filesystem view. Soul, Skill,
 * and Routine bodies live in the DB now, so the tree only surfaces artifacts
 * the CLI itself writes into cwd plus anything the operator drops in.
 * Dot-prefixed directories (`.claude`, `.codex`, `.opencode`, `.mcp.json`)
 * stay hidden — those are managed by the Settings / MCP tabs.
 *
 * Security:
 *  - every `rel` path is resolved against the employee root and must stay
 *    inside it (defends against `../` traversal and absolute paths).
 *  - we never follow symlinks out of the root: `realpath` is applied and
 *    re-checked against the root.
 *  - we cap file size at 2 MiB to keep us honest about "text editor", not
 *    "file server".
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type WorkspaceNode =
  | { type: "dir"; name: string; path: string; children: WorkspaceNode[] }
  | { type: "file"; name: string; path: string; size: number };

export type WorkspaceFile =
  | { type: "text"; path: string; size: number; content: string }
  | { type: "binary"; path: string; size: number; reason: string }
  | { type: "missing"; path: string };

function root(companySlug: string, employeeSlug: string): string {
  return path.resolve(employeeDir(companySlug, employeeSlug));
}

/**
 * Resolve a relative path under the employee root and enforce containment.
 * Returns the absolute path on success, null if the path escapes the root.
 * Accepts empty string ("") and "/" as aliases for the root itself.
 */
export function resolveInside(
  companySlug: string,
  employeeSlug: string,
  rel: string,
): string | null {
  const base = root(companySlug, employeeSlug);
  // Strip leading slashes so `path.resolve` doesn't treat `rel` as absolute.
  const cleaned = rel.replace(/^\/+/, "");
  const abs = path.resolve(base, cleaned);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  // If the path exists, also resolve symlinks and re-check — a symlink that
  // points outside the root must not be followed.
  if (fs.existsSync(abs)) {
    try {
      const real = fs.realpathSync(abs);
      const realBase = fs.realpathSync(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
    } catch {
      // realpath can fail on broken symlinks — treat as unresolvable.
      return null;
    }
  }
  return abs;
}

// Dot-prefixed entries (`.claude`, `.git`, `.DS_Store`, provider credential
// dirs, etc.) are hidden from the tree — they're either tool state or
// credentials the Settings tab manages, not user-facing workspace content.
const IGNORED = new Set(["node_modules"]);

export function buildTree(companySlug: string, employeeSlug: string): WorkspaceNode {
  const base = root(companySlug, employeeSlug);
  if (!fs.existsSync(base)) {
    return { type: "dir", name: employeeSlug, path: "", children: [] };
  }
  return walk(base, base);
}

function walk(absDir: string, base: string): WorkspaceNode {
  const name = absDir === base ? "" : path.basename(absDir);
  const rel = path.relative(base, absDir).split(path.sep).join("/");
  const children: WorkspaceNode[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { type: "dir", name, path: rel, children: [] };
  }
  // Stable ordering: dirs first, then files, each alphabetized.
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const ent of entries) {
    if (IGNORED.has(ent.name)) continue;
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(absDir, ent.name);
    const childRel = path.relative(base, abs).split(path.sep).join("/");
    if (ent.isDirectory()) {
      children.push(walk(abs, base));
    } else if (ent.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        // ignore
      }
      children.push({ type: "file", name: ent.name, path: childRel, size });
    }
  }
  return { type: "dir", name, path: rel, children };
}

export function readWorkspaceFile(
  companySlug: string,
  employeeSlug: string,
  rel: string,
): WorkspaceFile | null {
  const abs = resolveInside(companySlug, employeeSlug, rel);
  if (abs === null) return null;
  if (!fs.existsSync(abs)) return { type: "missing", path: rel };
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) {
    return {
      type: "binary",
      path: rel,
      size: stat.size,
      reason: `File is ${stat.size} bytes — too large to edit in the browser.`,
    };
  }
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    return {
      type: "binary",
      path: rel,
      size: stat.size,
      reason: "Binary file — open it with a local editor.",
    };
  }
  return { type: "text", path: rel, size: stat.size, content: buf.toString("utf8") };
}

export function writeWorkspaceFile(
  companySlug: string,
  employeeSlug: string,
  rel: string,
  content: string,
): { ok: true } | { error: string } {
  const abs = resolveInside(companySlug, employeeSlug, rel);
  if (abs === null) return { error: "Path escapes the employee workspace." };
  if (abs === root(companySlug, employeeSlug)) return { error: "Cannot write to root." };
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return { error: "File too large." };
  }
  // Refuse to overwrite the credentials directory.
  const rootBase = root(companySlug, employeeSlug);
  const relNormalized = path.relative(rootBase, abs).split(path.sep).join("/");
  if (/^\.(claude|codex|opencode)(\/|$)/.test(relNormalized)) {
    return { error: "Credentials files are managed by the Settings tab." };
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function looksBinary(buf: Buffer): boolean {
  // Heuristic: if any NUL byte appears in the first 8KB, treat as binary.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
