import { renderToString } from "react-dom/server";
import { App } from "@/App";
import { setSsrPath } from "@/lib/router";

/**
 * Build-time prerender entry, loaded by ../prerender.ts through Vite's SSR
 * module runner after `vite build`. Renders each route to static HTML so
 * crawlers (search engines and LLM agents alike) get real content without
 * executing JavaScript; the client hydrates the same markup (see main.tsx).
 */

export { allRoutes, llmsTxt, llmsFullTxt, SITE_URL } from "@/lib/siteMeta";

export function render(path: string): string {
  setSsrPath(path);
  return renderToString(<App />);
}
