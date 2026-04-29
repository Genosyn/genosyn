import type { IntegrationTool } from "../../types.js";
import { clampInt, safeJson } from "./util.js";

/**
 * Drive tool definitions + handlers, hosted under the umbrella `google`
 * provider. The umbrella refreshes the access token before dispatching here.
 *
 * Scope assumed: `drive.readonly`. Tools are read-only by design — adding
 * write tools would require requesting `drive.file` (per-file write to files
 * the app created) or `drive` (full read+write), neither of which are part
 * of the umbrella's default scope set.
 *
 * `drive_get_file_content` enforces a 5 MiB streaming cap to keep the MCP
 * response budget sane when the AI accidentally asks for a giant file.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FILE_CONTENT_CAP_BYTES = 5 * 1024 * 1024;

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";
const GOOGLE_EXPORT_DEFAULTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const TEXT_MIME_PATTERNS = [
  /^text\//,
  /^application\/json/,
  /^application\/xml/,
  /^application\/xhtml\+xml/,
  /^application\/javascript/,
  /^application\/typescript/,
  /\+json$/,
  /\+xml$/,
];

export const driveTools: IntegrationTool[] = [
  {
    name: "drive_list_files",
    description:
      "Search the user's Google Drive. Uses Drive's standard query syntax (e.g. \"name contains 'budget' and modifiedTime > '2025-01-01'\"). Returns metadata only — call `drive_get_file_content` for the actual contents.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Drive query expression. Omit to list recent files. Examples: \"mimeType='application/vnd.google-apps.document'\", \"name contains 'invoice'\", \"'<folderId>' in parents\".",
        },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max files to return (default 20).",
        },
        pageToken: {
          type: "string",
          description: "Token from a previous response's `nextPageToken` to fetch the next page.",
        },
        orderBy: {
          type: "string",
          description:
            "Optional sort order (e.g. 'modifiedTime desc', 'name', 'createdTime desc').",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "drive_get_file_metadata",
    description:
      "Fetch the full metadata for one Drive file by id — useful before deciding whether to download the contents.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_get_file_content",
    description:
      "Download the contents of a Drive file. Google-native files (Docs / Sheets / Slides) are exported to a text format automatically. Plain-text files are returned as utf-8 text; binary files are returned as base64. Hard-capped at 5 MiB — larger files come back with `truncated: true`.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        exportMime: {
          type: "string",
          description:
            "Override the export MIME for Google-native files. Defaults: Docs → text/markdown, Sheets → text/csv, Slides → text/plain.",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
];

export async function invokeDriveTool(
  name: string,
  args: unknown,
  accessToken: string,
): Promise<unknown> {
  const a = (args as Record<string, unknown>) ?? {};
  switch (name) {
    case "drive_list_files":
      return driveListFiles(accessToken, a);
    case "drive_get_file_metadata":
      return driveGetFileMetadata(accessToken, a);
    case "drive_get_file_content":
      return driveGetFileContent(accessToken, a);
    default:
      throw new Error(`Unknown Drive tool: ${name}`);
  }
}

async function driveListFiles(
  accessToken: string,
  a: Record<string, unknown>,
): Promise<unknown> {
  const qs = new URLSearchParams();
  qs.set("pageSize", String(clampInt(a.pageSize, 1, 100, 20)));
  qs.set(
    "fields",
    "files(id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),parents,webViewLink),nextPageToken",
  );
  if (typeof a.q === "string" && a.q.trim()) qs.set("q", a.q);
  if (typeof a.pageToken === "string" && a.pageToken) qs.set("pageToken", a.pageToken);
  if (typeof a.orderBy === "string" && a.orderBy) qs.set("orderBy", a.orderBy);
  return driveJsonFetch(accessToken, `/files?${qs.toString()}`);
}

async function driveGetFileMetadata(
  accessToken: string,
  a: Record<string, unknown>,
): Promise<unknown> {
  if (typeof a.fileId !== "string" || !a.fileId)
    throw new Error("fileId is required");
  const qs = new URLSearchParams({
    fields:
      "id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),parents,webViewLink,description,starred,trashed,shared,sharingUser(displayName,emailAddress)",
  });
  return driveJsonFetch(
    accessToken,
    `/files/${encodeURIComponent(a.fileId)}?${qs.toString()}`,
  );
}

async function driveGetFileContent(
  accessToken: string,
  a: Record<string, unknown>,
): Promise<unknown> {
  if (typeof a.fileId !== "string" || !a.fileId)
    throw new Error("fileId is required");
  // Look up the mimeType first so we know whether to export or download.
  const meta = (await driveJsonFetch(
    accessToken,
    `/files/${encodeURIComponent(a.fileId)}?fields=id,name,mimeType,size`,
  )) as { id: string; name: string; mimeType: string; size?: string };

  const isGoogleNative = meta.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
  let url: string;
  let effectiveMime: string;

  if (isGoogleNative) {
    const requested =
      typeof a.exportMime === "string" && a.exportMime
        ? a.exportMime
        : (GOOGLE_EXPORT_DEFAULTS[meta.mimeType] ?? "text/plain");
    if (meta.mimeType === "application/vnd.google-apps.folder") {
      throw new Error(
        "Cannot fetch content for a folder. Use drive_list_files with `'<folderId>' in parents` to enumerate it.",
      );
    }
    url = `${DRIVE_API}/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(requested)}`;
    effectiveMime = requested;
  } else {
    url = `${DRIVE_API}/files/${encodeURIComponent(meta.id)}?alt=media`;
    effectiveMime = meta.mimeType;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const parsed = safeJson(text);
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String(
            (parsed as { error?: { message?: unknown } }).error?.message ??
              (parsed as { error?: unknown }).error,
          )
        : null) ?? `Drive ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  const { data, truncated } = await readBodyWithCap(res, FILE_CONTENT_CAP_BYTES);
  const isText = TEXT_MIME_PATTERNS.some((re) => re.test(effectiveMime));

  return {
    fileId: meta.id,
    name: meta.name,
    sourceMimeType: meta.mimeType,
    contentMimeType: effectiveMime,
    encoding: isText ? "utf8" : "base64",
    content: isText ? new TextDecoder("utf-8").decode(data) : toBase64(data),
    truncated,
    bytes: data.byteLength,
  };
}

async function driveJsonFetch(
  accessToken: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const text = await res.text();
  const parsed = safeJson(text);
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String(
            (parsed as { error?: { message?: unknown } }).error?.message ??
              (parsed as { error?: unknown }).error,
          )
        : null) ?? `Drive ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

async function readBodyWithCap(
  res: Response,
  capBytes: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    return { data: new Uint8Array(0), truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > capBytes) {
      const remaining = capBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total = capBytes;
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
      return { data: concatChunks(chunks, total), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { data: concatChunks(chunks, total), truncated: false };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
