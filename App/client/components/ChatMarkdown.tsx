import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { addCodeBars } from "../lib/chatMarkdown";

/**
 * Render an assistant's reply as HTML. Models emit markdown (bold, lists,
 * links, fenced code) and showing the raw `**` markers alongside the prose
 * reads like a diff, not a message.
 *
 * `breaks: true` keeps single-line newlines as `<br>`, matching the
 * whitespace-pre-wrap feel people are used to from chat. DOMPurify strips
 * anything scripty before we hand it to `dangerouslySetInnerHTML` — the
 * model output is ultimately user-controlled text, so we don't trust it. Each
 * fenced block then gets its bar, with the language and a Copy button, added to
 * the page after React has put the sanitized HTML there, before it paints.
 */
export function ChatMarkdown({
  content,
  blockImages = false,
}: {
  content: string;
  /**
   * Words outside content may have shaped. A remote image loads by itself when this
   * is read, and its URL can carry whatever the session was talked into putting there.
   */
  blockImages?: boolean;
}) {
  const html = React.useMemo(() => {
    const raw = marked.parse(content ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(raw, blockImages ? { FORBID_TAGS: ["img"] } : undefined);
  }, [content, blockImages]);
  const root = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (root.current) addCodeBars(root.current);
  }, [html]);
  return <div ref={root} className="chat-md break-words" dangerouslySetInnerHTML={{ __html: html }} />;
}
