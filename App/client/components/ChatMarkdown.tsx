import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Render an assistant's reply as HTML. Models emit markdown (bold, lists,
 * links, fenced code) and showing the raw `**` markers alongside the prose
 * reads like a diff, not a message.
 *
 * `breaks: true` keeps single-line newlines as `<br>`, matching the
 * whitespace-pre-wrap feel people are used to from chat. DOMPurify strips
 * anything scripty before we hand it to `dangerouslySetInnerHTML` — the
 * model output is ultimately user-controlled text, so we don't trust it.
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
  }, [content]);
  return (
    <div
      className="chat-md break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
