import React from "react";
import { downloadFile } from "../../lib/download";
import { useDialog } from "../ui/Dialog";

/**
 * Download PDF, wherever Finance offers one. The server renders each PDF in a
 * browser of its own, which takes a moment, so the returned promise settles
 * only once the file has been handed over: the control that asked for it shows
 * it is working until then. A refusal — no browser on the server to render
 * with, say — opens the error modal and leaves the page as it was, so the
 * promise never rejects. `fallbackName` names the file only when the server's
 * answer doesn't.
 */
export function usePdfDownload(): (url: string, fallbackName: string) => Promise<void> {
  const dialog = useDialog();
  return React.useCallback(
    async (url, fallbackName) => {
      try {
        await downloadFile(url, fallbackName);
      } catch (err) {
        void dialog.error(err, { title: "Couldn’t download the PDF" });
      }
    },
    [dialog],
  );
}

/** {@link usePdfDownload} for an invoice or estimate, from a list's row menu or its own page. */
export function useDocumentPdfDownload(
  companyId: string,
  kind: "invoice" | "estimate",
): (doc: { slug: string; number: string }) => Promise<void> {
  const download = usePdfDownload();
  return React.useCallback(
    (doc) =>
      download(
        `/api/companies/${companyId}/${kind}s/${doc.slug}/pdf`,
        // A draft has no number yet; the server names its PDF the same way.
        `${doc.number || "draft"}.pdf`,
      ),
    [download, companyId, kind],
  );
}
