import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

const NAV_EVENT = "genosyn:navigate";

export function usePathname(): string {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
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
  return path;
}

export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    return;
  }
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}

// Only intercept paths the React app actually owns. Everything else (file
// downloads like /install.sh and /genosyn, hash anchors, http(s) URLs) falls
// through to the browser's default link behavior.
function isInternalRoute(href: string): boolean {
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  if (href === "/") return true;
  if (href.startsWith("/docs")) return true;
  if (href.startsWith("/enterprise")) return true;
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

export function Link({
  href,
  className,
  children,
  onClick,
  ...rest
}: LinkProps) {
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
