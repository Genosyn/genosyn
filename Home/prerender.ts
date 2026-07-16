import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Build-time prerendering. After `vite build` writes the client bundle, this
 * plugin renders every registered route (see client/lib/siteMeta.ts) to
 * static HTML under dist/client/<route>/index.html — with route-specific
 * <title>, meta description, canonical, Open Graph tags, and JSON-LD — and
 * emits sitemap.xml, robots.txt, llms.txt, and llms-full.txt.
 *
 * Both production servers understand the layout: server.ts serves
 * <route>/index.html when it exists, and Cloudflare's asset host (see
 * wrangler.jsonc) resolves nested index.html files natively. Crawlers that
 * don't execute JavaScript — most LLM agents — get the full page content.
 */

type RouteHead = {
  path: string;
  title: string;
  description: string;
  jsonLd: object[];
};

type SsrModule = {
  render: (path: string) => string;
  allRoutes: () => RouteHead[];
  llmsTxt: () => string;
  llmsFullTxt: () => string;
  SITE_URL: string;
};

export function prerenderPlugin(define: Record<string, string>): Plugin {
  return {
    name: "genosyn:prerender",
    apply: "build",
    closeBundle: {
      sequential: true,
      order: "post",
      async handler() {
        await prerender(define);
      },
    },
  };
}

async function prerender(define: Record<string, string>): Promise<void> {
  const home = __dirname;
  const outDir = path.resolve(home, "dist/client");
  const templatePath = path.join(outDir, "index.html");
  const template = fs.readFileSync(templatePath, "utf8");

  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");

  const vite = await createServer({
    configFile: false,
    root: path.resolve(home, "client"),
    logLevel: "warn",
    plugins: [react()],
    resolve: { alias: { "@": path.resolve(home, "client") } },
    define,
    server: { middlewareMode: true },
    appType: "custom",
  });

  try {
    const mod = (await vite.ssrLoadModule("/ssr.tsx")) as SsrModule;
    const routes = mod.allRoutes();

    // Unknown-URL fallback: the untouched shell (empty #root, so the client
    // renders from scratch) with a noindex hint. server.ts sends it with a
    // 404 status; wrangler.jsonc's not_found_handling picks it up on the
    // Cloudflare asset host. Written before the "/" route overwrites
    // index.html with full homepage markup.
    fs.writeFileSync(
      path.join(outDir, "404.html"),
      template
        .replace(/<title>[\s\S]*?<\/title>/, "<title>Page not found · Genosyn</title>")
        .replace("<!--route-head-->", '<meta name="robots" content="noindex" />'),
    );

    for (const route of routes) {
      const html = renderRoute(template, route, mod.render(route.path), mod.SITE_URL);
      const file =
        route.path === "/"
          ? templatePath
          : path.join(outDir, route.path.replace(/^\//, ""), "index.html");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
    }

    fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemapXml(routes, mod.SITE_URL));
    fs.writeFileSync(path.join(outDir, "robots.txt"), robotsTxt(mod.SITE_URL));
    fs.writeFileSync(path.join(outDir, "llms.txt"), mod.llmsTxt());
    fs.writeFileSync(path.join(outDir, "llms-full.txt"), mod.llmsFullTxt());

    // eslint-disable-next-line no-console
    console.log(
      `[prerender] wrote ${routes.length} routes + sitemap.xml, robots.txt, llms.txt, llms-full.txt`,
    );
  } finally {
    await vite.close();
  }
}

function renderRoute(
  template: string,
  route: RouteHead,
  appHtml: string,
  siteUrl: string,
): string {
  const url = `${siteUrl}${route.path === "/" ? "" : route.path}`;
  const title = escapeHtml(route.title);
  const description = escapeHtml(route.description);

  const headTags = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Genosyn" />`,
    `<meta property="og:image" content="${siteUrl}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${siteUrl}/og.png" />`,
    ...route.jsonLd.map(
      (block) =>
        `<script type="application/ld+json" data-route-jsonld="true">${JSON.stringify(block).replace(/</g, "\\u003c")}</script>`,
    ),
  ].join("\n    ");

  return template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
    .replace(
      /<meta\s+name="description"[\s\S]*?\/>/,
      `<meta name="description" content="${description}" />`,
    )
    .replace("<!--route-head-->", headTags)
    .replace("<!--app-html-->", appHtml);
}

function sitemapXml(routes: RouteHead[], siteUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = routes
    .map((r) => {
      const loc = `${siteUrl}${r.path === "/" ? "/" : r.path}`;
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsTxt(siteUrl: string): string {
  // AI crawlers are explicitly welcome — the whole site is public marketing
  // and docs, and /llms.txt exists specifically for them.
  const aiCrawlers = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "anthropic-ai",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "meta-externalagent",
  ];
  const lines = ["User-agent: *", "Allow: /", ""];
  for (const bot of aiCrawlers) {
    lines.push(`User-agent: ${bot}`, "Allow: /", "");
  }
  lines.push(
    `# Curated map of this site for LLMs: ${siteUrl}/llms.txt`,
    `Sitemap: ${siteUrl}/sitemap.xml`,
    "",
  );
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
