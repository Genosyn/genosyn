import React from "react";
import createDOMPurify from "dompurify";
import { Image as ImageIcon } from "lucide-react";

import { clsx } from "@/components/ui/clsx";

/**
 * What a customer's email looks like on a ticket. Their new words come first, as
 * plain text; the full email, quoted history and formatting included, is one
 * click away.
 *
 * A customer's HTML is the least trusted thing in the product. A dedicated
 * DOMPurify instance keeps these hooks away from chat markdown, and a remote image
 * is blocked until someone asks for it, since an image in an email reports who
 * opened it and when.
 */
let allowRemoteImages = false;
let sawRemoteImage = false;

const purifier = createDOMPurify(window);
purifier.addHook("afterSanitizeAttributes", (node) => {
  const element = node as Element;
  if (element.tagName === "A") {
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  }
  if (element.tagName === "IMG") {
    const source = element.getAttribute("src") ?? "";
    if (/^(https?:)?\/\//i.test(source.trim())) {
      sawRemoteImage = true;
      if (!allowRemoteImages) element.removeAttribute("src");
    }
  }
});

function sanitize(html: string, images: boolean): { html: string; hadRemoteImages: boolean } {
  allowRemoteImages = images;
  sawRemoteImage = false;
  const clean = purifier.sanitize(html, {
    FORBID_TAGS: ["style", "title", "meta", "link", "form", "input", "button", "base"],
    FORBID_ATTR: ["srcset"],
  });
  return { html: clean, hadRemoteImages: sawRemoteImage };
}

export function EmailBody({
  cleanText,
  bodyText,
  bodyHtml,
}: {
  cleanText: string;
  bodyText: string;
  bodyHtml: string;
}) {
  const [full, setFull] = React.useState(false);
  const [images, setImages] = React.useState(false);
  const short = cleanText || bodyText;
  const hasMore = Boolean(bodyHtml) || bodyText.trim() !== short.trim();
  const rendered = React.useMemo(
    () => (full && bodyHtml ? sanitize(bodyHtml, images) : null),
    [full, bodyHtml, images],
  );

  return (
    <div>
      {!full && (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 dark:text-slate-200">
          {short}
        </p>
      )}
      {full && rendered && (
        <>
          {rendered.hadRemoteImages && !images && (
            <button
              type="button"
              onClick={() => setImages(true)}
              className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ImageIcon size={12} /> Show images
            </button>
          )}
          <div
            className="prose prose-sm max-w-none overflow-x-auto break-words rounded-lg bg-white p-3 text-slate-900 ring-1 ring-inset ring-slate-200 dark:ring-slate-700 [&_a]:text-indigo-600"
            // Sanitized above. White behind it because an email chooses its own colours.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </>
      )}
      {full && !rendered && (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 dark:text-slate-200">
          {bodyText}
        </p>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={() => setFull((value) => !value)}
          className={clsx(
            "touch-target relative mt-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
          )}
        >
          {full ? "Show less" : "Show full email"}
        </button>
      )}
    </div>
  );
}
