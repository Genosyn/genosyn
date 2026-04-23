import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import { dataRoot, ensureDir } from "./paths.js";

/**
 * Shared avatar storage for humans and AI employees. Images land under
 * `data/avatars/<uuid>.<ext>` so they don't move when a company or employee
 * slug is renamed. Both User and AIEmployee rows carry the basename in
 * `avatarKey`; the absolute path is re-derived at read/serve time.
 *
 * Storage is intentionally a flat pool rather than per-entity: avatars are
 * small, orphans are cheap to clean up, and avoiding per-slug directories
 * means renaming a slug doesn't touch the filesystem.
 */

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function avatarsRoot(): string {
  const dir = path.join(dataRoot(), "avatars");
  ensureDir(dir);
  return dir;
}

function safeExt(filename: string): string {
  const e = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(e)) return "";
  return e;
}

/**
 * Multer middleware for a single `file` upload, accepts common image types
 * only, capped at 5 MB. Rejects unknown mime types early in `fileFilter` so
 * a rejected upload never hits disk.
 */
export const avatarUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, avatarsRoot());
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (_req, file, cb) => {
      const ext = safeExt(file.originalname);
      const id = crypto.randomUUID();
      cb(null, `${id}${ext || ""}`);
    },
  }),
  limits: {
    fileSize: AVATAR_MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("Only PNG, JPEG, GIF, or WebP images are allowed"));
      return;
    }
    cb(null, true);
  },
});

export function avatarAbsPath(key: string): string | null {
  // Guard against traversal — re-join through basename to drop any segment
  // that isn't the bare filename.
  const root = avatarsRoot();
  const abs = path.join(root, path.basename(key));
  if (!abs.startsWith(root)) return null;
  return abs;
}

export function mimeFromKey(key: string): string {
  const e = path.extname(key).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * Replace an entity's avatar. Deletes the previous file from disk best-effort
 * (missing or unreadable files are ignored — the new row wins either way).
 */
export function replaceAvatarFile(
  previousKey: string | null,
  nextKey: string,
): void {
  if (previousKey && previousKey !== nextKey) {
    const abs = avatarAbsPath(previousKey);
    if (abs && fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
      } catch {
        // ignore — stale avatar file on disk is fine
      }
    }
  }
}

export function removeAvatarFile(key: string | null): void {
  if (!key) return;
  const abs = avatarAbsPath(key);
  if (!abs) return;
  if (fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch {
      // ignore
    }
  }
}
