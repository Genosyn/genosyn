import { SITE_URL, type RouteHead } from "@/lib/siteMeta";

/**
 * Client-side head sync. On first paint the server-prerendered head already
 * matches the route; this keeps <head> truthful after client-side navigation
 * so shared links, bookmarks, and SEO snapshots never carry stale metadata.
 */
export function applyHead(meta: RouteHead): void {
  if (typeof document === "undefined") return;

  document.title = meta.title;
  setNamedMeta("description", meta.description);

  const url = `${SITE_URL}${meta.path === "/" ? "" : meta.path}`;
  setLink("canonical", url);

  setPropertyMeta("og:title", meta.title);
  setPropertyMeta("og:description", meta.description);
  setPropertyMeta("og:url", url);
  setPropertyMeta("og:type", "website");
  setPropertyMeta("og:site_name", "Genosyn");
  setPropertyMeta("og:image", `${SITE_URL}/og.png`);
  setNamedMeta("twitter:card", "summary_large_image");
  setNamedMeta("twitter:title", meta.title);
  setNamedMeta("twitter:description", meta.description);
  setNamedMeta("twitter:image", `${SITE_URL}/og.png`);

  setJsonLd(meta.jsonLd);
}

function setNamedMeta(name: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setPropertyMeta(property: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(
    `meta[property="${property}"]`,
  );
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function setJsonLd(blocks: object[]): void {
  document.head
    .querySelectorAll('script[data-route-jsonld="true"]')
    .forEach((el) => el.remove());
  for (const block of blocks) {
    const el = document.createElement("script");
    el.type = "application/ld+json";
    el.dataset.routeJsonld = "true";
    el.textContent = JSON.stringify(block);
    document.head.appendChild(el);
  }
}
