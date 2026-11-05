/**
 * What the chat adds to a reply's rendered markdown: a bar over each fenced code
 * block, naming its language and offering to copy it.
 *
 * Built with DOM calls on what DOMPurify already let through, and never by editing
 * its HTML: a string edit cannot tell a tag from the same text inside an attribute,
 * and its quotes would close that attribute and turn the rest into live markup.
 */

/** Blocks that already have their bar. A reply's own HTML cannot forge a place here. */
const barred = new WeakSet<Element>();

/** How long a Copy button says it worked. */
const SAID_MS = 1_500;

export function addCodeBars(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const code = pre.firstElementChild;
    if (barred.has(pre) || code?.tagName !== "CODE") continue;
    barred.add(pre);
    const doc = pre.ownerDocument;
    const block = doc.createElement("div");
    block.className = "chat-md-code";
    const bar = doc.createElement("div");
    bar.className = "chat-md-code-bar";
    const language = doc.createElement("span");
    const name = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1];
    if (name) {
      language.className = "chat-md-code-language";
      language.textContent = name;
    }
    bar.append(language, copyButton(doc, pre));
    pre.replaceWith(block);
    block.append(bar, pre);
  }
}

function copyButton(doc: Document, pre: HTMLElement): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "chat-md-code-copy touch-target";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  button.addEventListener("click", () => {
    // What is on screen, and only that: a span hidden inside the block stays behind.
    void copyText(pre.innerText).then((copied) => {
      const said = copied ? "Copied" : "Could not copy";
      button.textContent = said;
      button.setAttribute("aria-label", said);
      window.setTimeout(() => {
        button.textContent = "Copy";
        button.setAttribute("aria-label", "Copy code");
      }, SAID_MS);
    });
  });
  return button;
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
