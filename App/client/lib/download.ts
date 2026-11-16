import { api } from "./api";

/**
 * Fetch a file and hand it to the browser to save, under the name the server
 * gives it or `fallbackName`.
 *
 * Pointing the window at the file's URL saves it too, but a refusal then
 * replaces the page with the server's error text. Here a refusal throws an
 * `ApiError` for the page to show where the person is looking, and the caller
 * knows when the file has arrived: a PDF the server renders in a browser of
 * its own takes a moment, which the control that asked for it should show.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const { blob, headers } = await api.getFile(url);
  saveFile(blob, attachmentFilename(headers.get("content-disposition")) ?? fallbackName);
}

/** Hand the browser a finished file to save. */
function saveFile(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked once the browser has started saving it.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/**
 * The file name a `Content-Disposition` header gives, or null. The UTF-8
 * `filename*` form wins over the plain one, as RFC 6266 has it.
 */
export function attachmentFilename(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      const name = decodeURIComponent(extended[1].trim());
      if (name) return name;
    } catch {
      // A malformed escape: the plain name, if there is one, still serves.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const name = (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim();
  return name || null;
}
