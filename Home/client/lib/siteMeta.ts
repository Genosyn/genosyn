import { PRODUCTS, type ProductDef } from "@/products/data";
import { ROLES, type RoleDef } from "@/roles/data";
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
  "Open-source, self-hosted operating system for autonomous companies: AI Employees hold real roles, run the work on their own schedule, and escalate only the decisions that need a human.";

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
  license: "https://www.apache.org/licenses/LICENSE-2.0",
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

function roleRoute(role: RoleDef): RouteHead {
  const path = `/roles/${role.slug}`;
  return {
    path,
    title: role.seoTitle,
    description: role.description,
    jsonLd: [
      ORGANIZATION,
      WEBSITE,
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Roles", path: "/roles" },
        { name: role.name, path },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: role.seoTitle,
        url: `${SITE_URL}${path}`,
        description: role.description,
        isPartOf: { "@type": "WebSite", name: "Genosyn", url: SITE_URL },
        about: {
          "@type": "SoftwareApplication",
          name: `Genosyn ${role.name}`,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Linux, macOS, Windows (Docker)",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          featureList: role.capabilities.map((c) => c.title).join(", "),
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: role.faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
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
      title: "Genosyn — Build an autonomous company",
      description: SITE_DESCRIPTION,
      jsonLd: [ORGANIZATION, WEBSITE, SOFTWARE_APPLICATION],
    },
    {
      path: "/products",
      title: "Products — the tools an autonomous company runs on · Genosyn",
      // Derived, not hand-listed: the hand-written version had drifted and
      // omitted Paid Marketing while the page itself advertised the full count.
      description: `Every tool an autonomous company runs on, built in: ${PRODUCTS.map((p) => p.name).join(", ")}.`,
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
      path: "/roles",
      title: "AI roles — what each one does all day · Genosyn",
      // Derived rather than hand-listed, for the same reason /products is:
      // a hand-written list drifts the moment a role is added.
      description: `What an AI employee actually does, hour by hour, in eight roles: ${ROLES.map((r) => r.name).join(", ")}.`,
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Roles", path: "/roles" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Genosyn AI roles",
          itemListElement: ROLES.map((r, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: r.name,
            description: r.summary,
            url: `${SITE_URL}/roles/${r.slug}`,
          })),
        },
      ],
    },
    ...ROLES.map(roleRoute),
    {
      path: "/enterprise",
      title: "Genosyn for Enterprise — Autonomous operations, your perimeter",
      description:
        "Run an autonomous company inside your own environment: self-hosted AI employees on your infrastructure, your model keys, your data. Apache 2.0 licensed with no vendor lock-in.",
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Enterprise", path: "/enterprise" },
        ]),
      ],
    },
    {
      path: "/pricing",
      title: "Pricing — Genosyn",
      description:
        "Self-host the free Apache 2.0-licensed community edition, run on Genosyn Cloud plans starting at $0 and priced per AI Employee, or unlock SSO and audit logging with Genosyn Enterprise.",
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Pricing", path: "/pricing" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "Pricing — Genosyn",
          url: `${SITE_URL}/pricing`,
          description:
            "Genosyn pricing: free self-hosted community edition, Genosyn Cloud plans from $0 priced per AI Employee, and Genosyn Enterprise for self-hosted teams.",
          isPartOf: { "@type": "WebSite", name: "Genosyn", url: SITE_URL },
        },
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
    `> ${SITE_DESCRIPTION} Genosyn is Apache 2.0-licensed, ships as a single Docker container, and runs on SQLite (Postgres via config). Install: \`curl -fsSL ${SITE_URL}/install.sh | bash\` — the app starts on localhost:8471.`,
    "",
    "Key concepts: an **AI Employee** is a persistent teammate with a **Soul** (written constitution), **Skills** (markdown playbooks), and **Routines** (cron-scheduled work whose every execution is a readable **Run**). Routines are what make a company autonomous — they start themselves, with no human trigger — while approval gates and **Decisions** send the small number of judgement calls back to a Member. Employees run on Anthropic (Claude), OpenAI (GPT), or any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp). Access to company resources is controlled per employee by **Grants**.",
    "",
    "## Roles",
    "",
    `Each role below is one AI Employee configured for a job — a Soul, a set of Skills, and Routines on a schedule. The pages show what it does hour by hour on an ordinary working day. These are written examples, not the limit: a role is a document you edit. [All roles](${SITE_URL}/roles).`,
    "",
    ...ROLES.map((r) => `- [${r.name}](${SITE_URL}/roles/${r.slug}): ${r.summary}`),
    "",
    "## Products",
    "",
    ...PRODUCTS.map((p) => `- [${p.name}](${SITE_URL}/products/${p.slug}): ${p.summary}`),
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
    `- [Roles](${SITE_URL}/roles): what an AI employee does all day, in eight worked examples`,
    `- [Pricing](${SITE_URL}/pricing): free community edition, Genosyn Cloud plans, and Enterprise licensing`,
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
    "Genosyn is an open-source (Apache 2.0), self-hostable platform for running companies autonomously with AI Employees. The standard installer ships as a single Docker container, with SQLite by default and Postgres available through config. Anthropic, OpenAI API-key, and custom OpenAI-compatible models run through Genosyn's in-process loop. Trusted single-tenant deployments, including the standard Docker default, can use OpenAI subscription access through the official pinned Codex app-server alongside bubblewrap-isolated coding and repository work, or without coding tools where Linux namespaces are unavailable. Model credentials are AES-256-GCM encrypted in the database; managed subscription sessions are materialized only inside a locked temporary directory for a login or Run.",
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

  for (const r of ROLES) {
    lines.push(`## Role: ${r.name} (${SITE_URL}/roles/${r.slug})`, "");
    lines.push(r.intro, "");
    lines.push("A working day:", "");
    for (const m of r.day) {
      const flag = m.kind === "decision" ? " [escalated to a human]" : "";
      lines.push(`- **${m.time} — ${m.title}** (${m.where})${flag}. ${m.body}`);
    }
    lines.push("", "Routines:", "");
    for (const routine of r.routines) {
      lines.push(`- ${routine.name} — ${routine.when}`);
    }
    lines.push("", `Skills: ${r.skills.join(", ")}.`, "");
    lines.push(`Grants required: ${r.grants.join("; ")}.`, "");
    lines.push("FAQ:", "");
    for (const f of r.faqs) {
      lines.push(`- **${f.q}** ${f.a}`);
    }
    lines.push("", `Related terms: ${r.keywords.join(", ")}.`, "");
  }

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
