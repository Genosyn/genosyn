/**
 * Recognising a link to a Repository work session.
 *
 * When an AI Employee starts repository work from a chat turn,
 * `start_repository_work_session` hands it the session's URL and tells it to
 * reply with `[<repository> → AI work](/c/<company>/repositories/<repo>/ai/<session>)`.
 * Following that link used to replace the conversation with the Repository
 * section: the reader lost the thread they were in the middle of in order to
 * look at a diff, and had to find their way back afterwards.
 *
 * Chat now opens the same work beside the conversation instead — the seam the
 * live browser panel already uses — which is only possible if it can tell that
 * one anchor in a transcript full of anchors is a work session. That
 * recognition lives here, away from the components, because it is the part
 * that has to be exactly right.
 */

export type RepositoryWorkTarget = {
  /** Repository slug exactly as it appeared in the link. */
  repositorySlug: string;
  sessionId: string;
};

/** The route a work session lives at. Kept next to the parser that reads it. */
export function repositoryWorkHref(companySlug: string, target: RepositoryWorkTarget): string {
  return `/c/${companySlug}/repositories/${target.repositorySlug}/ai/${target.sessionId}`;
}

/**
 * Path of an href, or null when it is not a same-origin location.
 *
 * A model writes the relative path it was handed, but a human pasting the same
 * link back into chat pastes the whole address bar, so both forms have to
 * work. Anything on another origin is somebody else's website and is left to
 * navigate normally.
 */
function samePagePath(href: string, origin: string | null): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!/^https?:/i.test(trimmed)) return null;
    try {
      const url = new URL(trimmed);
      if (origin && url.origin !== origin) return null;
      return url.pathname;
    } catch {
      return null;
    }
  }
  // Protocol-relative (`//host/path`) is another origin in disguise.
  if (trimmed.startsWith("//")) return null;
  if (!trimmed.startsWith("/")) return null;
  return trimmed.split(/[?#]/, 1)[0];
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not a slug we could look up anyway.
    return segment;
  }
}

/**
 * Read a work-session target out of one path.
 *
 * Deliberately exact about the shape: `/c/<company>/repositories/<repo>/ai/<session>`
 * and nothing else. `…/ai` on its own is the session list, and `…/ai/<id>/anything`
 * is a route that does not exist — both keep the ordinary navigation they have
 * today rather than opening a panel onto a session that isn't there.
 */
export function parseRepositoryWorkPath(
  path: string,
  companySlug: string,
): RepositoryWorkTarget | null {
  const segments = path.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length !== 6) return null;
  const [c, company, repositories, repositorySlug, ai, sessionId] = segments;
  if (c !== "c" || repositories !== "repositories" || ai !== "ai") return null;
  if (company.toLowerCase() !== companySlug.trim().toLowerCase()) return null;
  if (!isSegment(repositorySlug) || !isSegment(sessionId)) return null;
  return { repositorySlug, sessionId };
}

/**
 * A value that is safe to have come out of one path segment.
 *
 * The count check above runs on the *encoded* path, so `%2F` survives it and
 * then decodes into a slash — `…/ai/..%2F..%2Fusers` would otherwise hand back
 * a session id of `../../users`, which callers interpolate straight into an
 * API path. A decoded segment that is not a single segment is not a link we
 * wrote, so it is not one we follow.
 */
function isSegment(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  // Control characters cannot appear in a slug or an id we minted. Checked by
  // code point rather than by regex, which ESLint bans for exactly the reason
  // that a literal control character in a pattern is unreadable.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Read a work-session target out of an anchor's href.
 *
 * `origin` is the page's own origin; pass it so an absolute link to another
 * host can never be mistaken for one of ours. Omitting it accepts any http(s)
 * host, which is only ever what a test wants.
 */
export function parseRepositoryWorkHref(
  href: string | null | undefined,
  companySlug: string,
  origin?: string | null,
): RepositoryWorkTarget | null {
  if (!href) return null;
  const path = samePagePath(href, origin ?? null);
  if (path === null) return null;
  return parseRepositoryWorkPath(path, companySlug);
}

/**
 * Every work-session link in one message, oldest first.
 *
 * Scans the raw markdown rather than the rendered HTML: the panel decides
 * whether to open itself the moment a reply lands, and a reply is text long
 * before it is a DOM node. Bare URLs count too — a Member pasting a session
 * link into the thread means the same thing the employee's markdown does.
 */
export function collectRepositoryWorkTargets(
  text: string,
  companySlug: string,
  origin?: string | null,
): RepositoryWorkTarget[] {
  return collectTranscriptWorkTargets([text], companySlug, origin);
}

/**
 * Every work session a whole transcript links to, oldest first and each one
 * once. A session is linked again in every follow-up that mentions it, and the
 * panel decides what is new by session, not by message.
 */
export function collectTranscriptWorkTargets(
  contents: readonly string[],
  companySlug: string,
  origin?: string | null,
): RepositoryWorkTarget[] {
  const found: RepositoryWorkTarget[] = [];
  const seen = new Set<string>();
  for (const text of contents) {
    if (!text) continue;
    appendWorkTargets(text, companySlug, origin ?? null, found, seen);
  }
  return found;
}

function appendWorkTargets(
  text: string,
  companySlug: string,
  origin: string | null,
  found: RepositoryWorkTarget[],
  seen: Set<string>,
): void {
  // Whole runs, longest form first, so a URL we are going to reject is
  // consumed as one unit. Scanning for `/c/` alone let the scanner walk into
  // `https://elsewhere.example/anything/c/…` and come back out with a bare
  // path, which then read as same-origin — the origin check has to see the
  // whole address to be able to refuse it. The second alternative exists to
  // swallow `mailto:`/`data:`/`javascript:` runs whole for the same reason.
  // The scheme quantifier is bounded deliberately. Unbounded, an unbroken run
  // of scheme-legal characters with no colon in it — a long token in someone's
  // message — makes the engine consume the whole run and back out of it one
  // character at a time, from every offset in it. That is quadratic: 80 000
  // characters took twenty seconds. No real scheme is longer than this.
  const pattern =
    /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"')\]]+|[a-z][a-z0-9+.-]{0,31}:[^\s<>"')\]]+|\/[^\s<>"')\]]*/gi;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const run = match[0];
    // A bare path only counts where a link is actually written: at the start,
    // after whitespace, or inside a markdown link's parentheses. Anywhere else
    // it is a fragment of something bigger — a query parameter, an attribute,
    // an argument — and reading a link out of that is how a path smuggled
    // inside somebody else's URL gets treated as one of ours.
    if (run.startsWith("/")) {
      const before = match.index === 0 ? "" : text[match.index - 1];
      if (before && !/[\s(]/.test(before)) continue;
    }
    // Trailing sentence punctuation is not part of the link.
    const candidate = run.replace(/[.,;:!?]+$/, "");
    const target = parseRepositoryWorkHref(candidate, companySlug, origin);
    if (!target) continue;
    const key = `${target.repositorySlug}/${target.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(target);
  }
}

/** What a click handler needs to know, without depending on the DOM. */
export type LinkClickIntent = {
  /** 0 is the primary button. */
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  /** The anchor's `target` attribute, when it has one. */
  anchorTarget?: string | null;
};

/**
 * Whether a click on a work-session link should open the panel instead of
 * navigating.
 *
 * Only a plain left click. ⌘/Ctrl-click, shift-click, and middle-click are how
 * people deliberately ask for a new tab or window, and a panel that swallowed
 * them would be taking away a browser affordance rather than adding a product
 * one. An anchor aimed at another target already says where it wants to open.
 */
export function shouldOpenWorkLinkInPanel(intent: LinkClickIntent): boolean {
  if (intent.defaultPrevented) return false;
  if ((intent.button ?? 0) !== 0) return false;
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) return false;
  const target = (intent.anchorTarget ?? "").trim().toLowerCase();
  if (target && target !== "_self") return false;
  return true;
}
