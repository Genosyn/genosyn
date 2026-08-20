import fs from "node:fs";
import path from "node:path";

import { config } from "../../../config.js";
import { dataRoot, ensureDir, meetingRecordingsCompanyDir } from "../paths.js";

/**
 * Meeting recordings on disk.
 *
 * `Meeting.recordingPath` stores a path **relative to `config.dataDir`**, never
 * an absolute one. Two reasons, and both have bitten this repo's neighbours:
 * an absolute path breaks the moment a self-hoster moves their data directory
 * or restores a backup onto a different host, and a stored absolute path is a
 * traversal primitive the moment anything downstream trusts it.
 *
 * {@link resolveRecordingPath} is therefore the only way to turn one back into
 * something you can open, and it refuses anything that escapes the root.
 */

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

/** MIME types the transcription step can actually be handed. */
export const SUPPORTED_RECORDING_MIMES = Object.keys(AUDIO_EXTENSIONS);

export function isSupportedRecordingMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_EXTENSIONS, mime.toLowerCase());
}

export function extensionForMime(mime: string): string {
  return AUDIO_EXTENSIONS[mime.toLowerCase()] ?? ".bin";
}

/**
 * Filename sniffing for uploads that arrive with a useless MIME type.
 *
 * Browsers routinely send `application/octet-stream` for an `.m4a`, and the
 * `resources.ts` sniffer recognises no audio extension at all — which is how a
 * binary ends up UTF-8 decoded into a text column. Meetings must not repeat
 * that, so an unrecognised extension is an error rather than a guess.
 */
export function mimeForFilename(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  for (const [mime, candidate] of Object.entries(AUDIO_EXTENSIONS)) {
    if (candidate === ext) return mime;
  }
  return null;
}

/** Store bytes for a meeting and return the dataDir-relative path. */
export function writeRecording(args: {
  companyId: string;
  meetingId: string;
  bytes: Buffer;
  mime: string;
  /** Unique publication candidate. Empty retains the legacy canonical name. */
  candidateId?: string;
}): string {
  const dir = meetingRecordingsCompanyDir(args.companyId);
  ensureDir(dir);
  const candidate = (args.candidateId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const filename = `${args.meetingId}${candidate ? `.${candidate}` : ""}${extensionForMime(args.mime)}`;
  const absolute = path.join(dir, filename);
  fs.writeFileSync(absolute, args.bytes, { mode: 0o600 });
  return path.relative(path.resolve(config.dataDir), absolute);
}

/**
 * Absolute path for a stored recording, or null when the value is unusable.
 *
 * Containment is checked after resolution, so `../` segments and symlink-ish
 * trickery in a stored value cannot reach outside the data directory even if
 * something upstream let a bad path be written.
 */
export function resolveRecordingPath(relative: string): string | null {
  if (!relative) return null;
  const root = path.resolve(dataRoot());
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

export function readRecording(relative: string): Buffer | null {
  const absolute = resolveRecordingPath(relative);
  if (!absolute || !fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute);
}

export function deleteRecording(relative: string): void {
  const absolute = resolveRecordingPath(relative);
  if (!absolute) return;
  fs.rmSync(absolute, { force: true });
}
