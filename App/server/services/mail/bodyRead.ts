/** A reversible, bounded view for AI reads. Stored mail is never rewritten. */
export type MailBodyReadOptions = {
  includeQuoted?: boolean;
  bodyOffset?: number;
  maxBodyChars?: number;
  /** Internal provenance flag; never a caller's claim about mailbox coverage. */
  sourceComplete?: boolean;
};

export const MAIL_BODY_DEFAULT_CHARS = 4_000;
export const MAIL_BODY_MAX_CHARS = 20_000;

/** Quote removal is deliberately reported as a heuristic, never as full coverage. */
export function readMailBody(body: string, options: MailBodyReadOptions = {}) {
  const includeQuoted = options.includeQuoted ?? false;
  let readable = body;
  if (!includeQuoted) {
    // Conventional reply/forward separators contain the entire older message.
    // Do not guess from a lone "From:" in ordinary prose.
    const boundary =
      /(?:^|\r?\n)[ \t]*(?:On [^\r\n]{1,500}wrote:[ \t]*(?:\r?\n|$)|-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-{2,}|Begin forwarded message:|From:[^\r\n]+\r?\n(?:Sent|Date):[^\r\n]+\r?\nTo:)/im.exec(
        body,
      );
    if (boundary) readable = body.slice(0, boundary.index).trimEnd();
    // Inline replies outside quote-prefixed lines remain visible.
    readable = readable.replace(/^[ \t]*>[^\r\n]*(?:\r?\n|$)/gm, "");
  }
  const offset = Math.max(0, Math.floor(options.bodyOffset ?? 0));
  const limit = Math.max(
    1,
    Math.min(MAIL_BODY_MAX_CHARS, Math.floor(options.maxBodyChars ?? MAIL_BODY_DEFAULT_CHARS)),
  );
  const bodyText = readable.slice(offset, offset + limit);
  const nextOffset = offset + bodyText.length < readable.length ? offset + bodyText.length : null;
  const quotedHistoryOmitted = readable !== body;
  const sourceComplete = options.sourceComplete ?? true;
  return {
    bodyCoverage: {
      sourceChars: body.length,
      readableChars: readable.length,
      returnedChars: bodyText.length,
      offset,
      nextOffset,
      hasMore: nextOffset !== null,
      includeQuoted,
      quotedHistoryOmitted,
      sourceComplete,
      complete: sourceComplete && !quotedHistoryOmitted && offset === 0 && nextOffset === null,
      ...(!sourceComplete || quotedHistoryOmitted
        ? {
            note: [
              ...(!sourceComplete
                ? [
                    "Only a provider snippet or previously truncated body is available; this is not full message coverage.",
                  ]
                : []),
              ...(quotedHistoryOmitted
                ? [
                    "Quoted history was omitted heuristically. Use includeQuoted: true and bodyOffset to inspect the original text.",
                  ]
                : []),
            ].join(" "),
          }
        : {}),
    },
    bodyText,
  };
}
