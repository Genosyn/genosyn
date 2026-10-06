import { useEffect, useLayoutEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

const NAV_EVENT = "genosyn:navigate";

// During build-time prerendering there is no window; the prerender entry
// sets the path it wants rendered before calling renderToString.
let ssrPath = "/";

export function setSsrPath(path: string): void {
  ssrPath = path;
}

// The route navigate() just pushed and the #section of it to show. That
// section is only in the DOM once the route has rendered, so usePathname
// scrolls after the commit. Back and forward never set this, which leaves
// their scroll position to the browser's own restoration.
let pendingScroll: { path: string; hash: string } | null = null;

// A layout effect scrolls before the browser paints, so the new page never
// flashes at the wrong position. The prerender has no DOM to scroll and React
// warns about layout effects there, so it gets a plain effect that never runs.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function usePathname(): string {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? ssrPath : window.location.pathname,
  );
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAV_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAV_EVENT, sync as EventListener);
    };
  }, []);
  // Each subscriber's effect runs once the whole new route is in the DOM;
  // whichever runs first takes the scroll. A new page opens on its section the
  // way a page load would, rather than gliding down from the top.
  useIsomorphicLayoutEffect(() => {
    const pending = pendingScroll;
    if (!pending || pending.path !== path) return;
    pendingScroll = null;
    scrollToHash(pending.hash, "instant");
  }, [path]);
  return path;
}

/**
 * Goes to an in-app href. Another route is pushed and opens on its #section,
 * or at the top when it names none. A link to the page already showing moves
 * within it and replaces the URL, so the route is not pushed a second time.
 */
export function navigate(href: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(href, window.location.href);
  if (url.pathname === window.location.pathname) {
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, "", href);
    }
    // "auto" follows the page's CSS scroll-behavior, as an in-page anchor does.
    scrollToHash(url.hash, "auto");
    return;
  }
  pendingScroll = { path: url.pathname, hash: url.hash };
  window.history.pushState({}, "", href);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Brings the element a URL hash names into view, or jumps to the top when it
 * names none. scrollIntoView honors the same scroll-padding and scroll-margin
 * as a native anchor, so the target clears the sticky header.
 */
function scrollToHash(hash: string, behavior: ScrollBehavior): void {
  const target = hashTarget(hash);
  if (target) {
    target.scrollIntoView({ block: "start", behavior });
  } else {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

function hashTarget(hash: string): HTMLElement | null {
  if (hash.length <= 1) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null; // a malformed %-escape names no element
  }
}

// Only intercept paths the React app actually owns. Everything else (file
// downloads like /install.sh and /genosyn, bare #anchors, http(s) URLs) falls
// through to the browser's default link behavior. An owned path may carry a
// #section, as in /vision#road; navigate() scrolls to it.
export function isInternalRoute(href: string): boolean {
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  const path = href.replace(/[?#].*$/, "");
  if (path === "/") return true;
  if (path.startsWith("/docs")) return true;
  if (path.startsWith("/products")) return true;
  if (path.startsWith("/roles")) return true;
  if (path.startsWith("/blog")) return true;
  if (path === "/vision") return true;
  return false;
}

type LinkProps = {
  href: string;
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  "aria-label"?: string;
  "aria-current"?: "page" | undefined;
};

export function Link({ href, className, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (!isInternalRoute(href)) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
