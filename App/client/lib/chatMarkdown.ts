import type React from "react";

/**
 * What the chat adds to a reply's rendered markdown: a bar over each fenced code
 * block, naming its language and offering to copy it.
 *
 * Runs on HTML DOMPurify has already sanitized, so a `<pre>` here is a real one
 * (one written in the text is escaped by then), and it adds only this file's own
 * markup, with a language it has held to a word.
 */

const FENCED_BLOCK = /<pre><code(?: class="language-([\w+#.-]+)")?>([\s\S]*?)<\/code><\/pre>/g;

export function withCodeBars(html: string): string {
  return html.replace(FENCED_BLOCK, (_block, language: string | undefined, code: string) => {
    const label = language ? `<span class="chat-md-code-language">${language}</span>` : "<span></span>";
    const className = language ? ` class="language-${language}"` : "";
    return (
      `<div class="chat-md-code"><div class="chat-md-code-bar">${label}` +
      `<button type="button" class="chat-md-code-copy touch-target" data-copy-code aria-label="Copy code">Copy</button>` +
      `</div><pre><code${className}>${code}</code></pre></div>`
    );
  });
}

/** How long a Copy button says it worked. */
const COPIED_MS = 1_500;

/** Copy the code block whose Copy button was clicked; every other click passes by. */
export function copyCodeFromClick(event: React.MouseEvent<HTMLElement>): void {
  const button = (event.target as Element | null)?.closest?.("[data-copy-code]");
  if (!(button instanceof HTMLElement)) return;
  event.preventDefault();
  const code = button.closest(".chat-md-code")?.querySelector("pre")?.textContent ?? "";
  const say = (words: string) => {
    button.textContent = words;
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, COPIED_MS);
  };
  void copyText(code).then((copied) => say(copied ? "Copied" : "Could not copy"));
}

/** Put text on the clipboard; false when the browser would not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
