import { PRODUCTS, type ProductDef } from "@/products/data";
import { DOCS_NAV } from "@/docs/nav";
import { GITHUB_URL } from "@/lib/constants";

/**
 * Route-level SEO registry. Single source of truth for every indexable route:
 * the client head manager (lib/head.ts), the build-time prerenderer
 * (../prerender.ts via ssr.tsx), sitemap.xml, and the llms.txt files all
 * derive from `allRoutes()`.
 */

export const SITE_URL = "https://genosyn.com";

export type RouteHead = {
  path: string;
  title: string;
  description: string;
  jsonLd: object[];
};

const SITE_DESCRIPTION =
  "Open-source, self-hostable platform for running companies with AI employees. Souls, Skills, and Routines.";

const ORGANIZATION = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Genosyn",
  url: SITE_URL,
  logo: `${SITE_URL}/favicon.svg`,
  sameAs: [GITHUB_URL],
};

const WEBSITE = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Genosyn",
  url: SITE_URL,
  description: SITE_DESCRIPTION,
};

const SOFTWARE_APPLICATION = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Genosyn",
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Linux, macOS, Windows (Docker)",
  softwareVersion: __APP_VERSION__,
  license: "https://opensource.org/license/mit/",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

function breadcrumbs(items: { name: string; path: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path === "/" ? "" : item.path}`,
    })),
  };
}

function faqPage(product: ProductDef): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: product.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

function productRoute(product: ProductDef): RouteHead {
  const path = `/products/${product.slug}`;
  return {
    path,
    title: product.seoTitle,
    description: product.description,
    jsonLd: [
      ORGANIZATION,
      WEBSITE,
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Products", path: "/products" },
        { name: product.name, path },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: product.seoTitle,
        url: `${SITE_URL}${path}`,
        description: product.description,
        isPartOf: { "@type": "WebSite", name: "Genosyn", url: SITE_URL },
        about: {
          "@type": "SoftwareApplication",
          name: `Genosyn ${product.name}`,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Linux, macOS, Windows (Docker)",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          featureList: product.features.map((f) => f.title).join(", "),
        },
      },
      faqPage(product),
    ],
  };
}

export function allRoutes(): RouteHead[] {
  const routes: RouteHead[] = [
    {
      path: "/",
      title: "Genosyn — Run companies autonomously",
      description: SITE_DESCRIPTION,
      jsonLd: [ORGANIZATION, WEBSITE, SOFTWARE_APPLICATION],
    },
    {
      path: "/products",
      title: "Products — every tool in the box · Genosyn",
      description:
        "Every tool Genosyn ships built in: AI Employees, Workspace chat, Tasks, Bases, Notes, Resources, Pipelines, Explore BI, Revenue, Email, Customers, Finance, and Code.",
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Products", path: "/products" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Genosyn products",
          itemListElement: PRODUCTS.map((p, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: p.name,
            description: p.summary,
            url: `${SITE_URL}/products/${p.slug}`,
          })),
        },
      ],
    },
    ...PRODUCTS.map(productRoute),
    {
      path: "/enterprise",
      title: "Genosyn for Enterprise — Run it in your environment",
      description:
        "Run Genosyn in your own environment: self-hosted AI employees on your infrastructure, your model keys, your data. MIT licensed with no vendor lock-in.",
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Enterprise", path: "/enterprise" },
        ]),
      ],
    },
    ...DOCS_NAV.flatMap((section) =>
      section.pages.map((page) => ({
        path: page.path,
        title: `${page.title} · Genosyn Docs`,
        description: page.blurb ?? SITE_DESCRIPTION,
        jsonLd: [
          ORGANIZATION,
          WEBSITE,
          breadcrumbs([
            { name: "Home", path: "/" },
            { name: "Docs", path: "/docs" },
            ...(page.path === "/docs" ? [] : [{ name: page.title, path: page.path }]),
          ]),
        ],
      })),
    ),
  ];
  return routes;
}

export function findRouteHead(path: string): RouteHead | undefined {
  const normalized = path.replace(/\/+$/, "") || "/";
  return allRoutes().find((r) => r.path === normalized);
}

// ───────────────────────────── llms.txt generators ─────────────────────────────
// https://llmstxt.org — a curated map of the site for AI agents and LLM
// crawlers that don't execute JavaScript.

export function llmsTxt(): string {
  const lines: string[] = [
    "# Genosyn",
    "",
    `> ${SITE_DESCRIPTION} Genosyn is MIT-licensed, ships as a single Docker container, and runs on SQLite (Postgres via config). Install: \`curl -fsSL ${SITE_URL}/install.sh | bash\` — the app starts on localhost:8471.`,
    "",
    "Key concepts: an **AI Employee** is a persistent teammate with a **Soul** (written constitution), **Skills** (markdown playbooks), and **Routines** (cron-scheduled work whose every execution is a readable **Run**). Employees run on Anthropic (Claude), OpenAI (GPT), or any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp). Access to company resources is controlled per employee by **Grants**.",
    "",
    "## Products",
    "",
    ...PRODUCTS.map(
      (p) => `- [${p.name}](${SITE_URL}/products/${p.slug}): ${p.summary}`,
    ),
    "",
    "## Docs",
    "",
    ...DOCS_NAV.flatMap((section) =>
      section.pages.map(
        (page) => `- [${page.title}](${SITE_URL}${page.path}): ${page.blurb ?? ""}`,
      ),
    ),
    "",
    "## Optional",
    "",
    `- [GitHub repository](${GITHUB_URL}): source code, issues, and roadmap`,
    `- [Enterprise](${SITE_URL}/enterprise): running Genosyn in your own environment`,
    `- [llms-full.txt](${SITE_URL}/llms-full.txt): expanded product and platform reference for LLMs`,
    "",
  ];
  return lines.join("\n");
}

export function llmsFullTxt(): string {
  const lines: string[] = [
    "# Genosyn — full reference for LLMs",
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "Genosyn is an open-source (MIT), self-hostable platform for running companies with AI employees. It ships as a single Docker container, stores data in SQLite (Postgres via a config flip), and talks to model APIs in-process — Anthropic (Claude), OpenAI (GPT), or any OpenAI-compatible endpoint such as Ollama, vLLM, or llama.cpp. There are no provider CLIs and model API keys are AES-256-GCM encrypted in the database, never written to disk.",
    "",
    `Install: \`curl -fsSL ${SITE_URL}/install.sh | bash\` starts Genosyn on localhost:8471.`,
    "",
    "## Vocabulary",
    "",
    "- **AI Employee** — a persistent persona attached to a company (never called an agent or bot in product copy).",
    "- **Soul** — the employee's written constitution, one markdown document.",
    "- **Skill** — a reusable markdown playbook.",
    "- **Routine** — scheduled, cron-driven AI work; one execution is a **Run**.",
    "- **AI Model** — a model API connection owned by an employee (Anthropic, OpenAI, or custom endpoint).",
    "- **Member** — a human user in a company.",
    "- **Integration / Connection / Grant** — a connector type / one authenticated account / an AI employee's access to a resource.",
    "- **Tasks** — the task-manager feature (Projects + todos). Scheduled AI work is always a Routine, never a task.",
    "",
  ];

  for (const p of PRODUCTS) {
    lines.push(`## ${p.name} (${SITE_URL}/products/${p.slug})`, "");
    lines.push(p.intro, "");
    lines.push("Capabilities:", "");
    for (const f of p.features) {
      lines.push(`- **${f.title}.** ${f.body}`);
    }
    lines.push("", `With AI employees: ${p.employees.body}`, "");
    for (const b of p.employees.bullets) {
      lines.push(`- **${b.title}.** ${b.body}`);
    }
    lines.push("", "FAQ:", "");
    for (const f of p.faqs) {
      lines.push(`- **${f.q}** ${f.a}`);
    }
    if (p.docsPath) {
      lines.push("", `Docs: ${SITE_URL}${p.docsPath}`);
    }
    lines.push("", `Related terms: ${p.keywords.join(", ")}.`, "");
  }

  lines.push(
    "## Self-hosting",
    "",
    "Genosyn runs as one Docker container managed by the `genosyn` CLI (a bash wrapper around Docker). All runtime settings live in a single config.ts. Data lives under a configurable data directory; the database is the source of truth for Souls, Skills, Routines, Run transcripts, and encrypted model credentials. Backups, restore, and off-box destinations (NAS/SMB/SFTP) are built in. Kubernetes manifests are documented for cluster deployments.",
    "",
    `Full docs: ${SITE_URL}/docs · Source: ${GITHUB_URL}`,
    "",
  );

  return lines.join("\n");
}
