import React from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../../lib/chatMarkdown";
import { clsx } from "../ui/clsx";

/** How long the button says it worked. */
const SAID_MS = 1_500;

/**
 * A message's own actions wait for the pointer, so a thread reads as a thread:
 * put this inside a `group`. On a touch screen there is no hover to wait for, and
 * a keyboard brings them up by reaching them.
 */
export const REVEAL_ON_HOVER =
  "transition [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100";

/**
 * Copy a whole message as it was written, markdown and all, so it pastes into a
 * doc or an email as what it is. It says so where it was pressed; there is no
 * other sign that anything happened.
 */
export function CopyTextButton({ text, className }: { text: string; className?: string }) {
  const [said, setSaid] = React.useState<"copied" | "failed" | null>(null);
  React.useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [said]);
  return (
    <button
      type="button"
      onClick={() => void copyText(text).then((copied) => setSaid(copied ? "copied" : "failed"))}
      className={clsx(
        "touch-target relative inline-flex items-center gap-1 rounded-md px-1 text-xs text-slate-400 transition hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:text-slate-500 dark:hover:text-slate-200",
        className,
      )}
    >
      {said === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span aria-live="polite">
        {said === "copied" ? "Copied" : said === "failed" ? "Could not copy" : "Copy"}
      </span>
    </button>
  );
}
