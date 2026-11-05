import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { copyCodeFromClick, withCodeBars } from "../lib/chatMarkdown";

/**
 * Render an assistant's reply as HTML. Models emit markdown (bold, lists,
 * links, fenced code) and showing the raw `**` markers alongside the prose
 * reads like a diff, not a message.
 *
 * `breaks: true` keeps single-line newlines as `<br>`, matching the
 * whitespace-pre-wrap feel people are used to from chat. DOMPurify strips
 * anything scripty before we hand it to `dangerouslySetInnerHTML` — the
 * model output is ultimately user-controlled text, so we don't trust it. Each
 * fenced block then gets its bar, with the language and a Copy button; the
 * clicks are delegated, because there is no component here to hang them on.
 */
export function ChatMarkdown({ content }: { content: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(content ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return withCodeBars(DOMPurify.sanitize(raw));
  }, [content]);
  return (
    <div
      className="chat-md break-words"
      onClick={copyCodeFromClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
