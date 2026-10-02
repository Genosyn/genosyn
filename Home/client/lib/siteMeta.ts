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

// The old description opened on "operating system for autonomous companies",
// which is a positioning cliché and, worse, says nothing a reader can check.
// This one leads with the thing that is actually true and unusual: the work
// happens while nobody is there, and it is Apache-2.0 software you run
// yourself.
const SITE_DESCRIPTION =
  "Open-source, self-hosted software for running a company with AI Employees. They hold real roles, work on their own schedule through the night, and stop for a Member only when a job genuinely needs a person.";

// The vision page is the one route that describes direction rather than
// shipped behavior, so its description says "vision" in its first word and
// never reads like a feature claim.
const VISION_DESCRIPTION =
  "Genosyn's vision: you are not the manager of AI, you are the board. A company that runs itself toward a Goal you set, keeps its own treasury, hires people for physical work, and writes to you once a month.";

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
      title: "Genosyn — open-source AI Employees that work while you sleep",
      description: SITE_DESCRIPTION,
      jsonLd: [ORGANIZATION, WEBSITE, SOFTWARE_APPLICATION],
    },
    {
      path: "/vision",
      title: "Vision — you are not the manager, you are the board · Genosyn",
      description: VISION_DESCRIPTION,
      jsonLd: [
        ORGANIZATION,
        WEBSITE,
        breadcrumbs([
          { name: "Home", path: "/" },
          { name: "Vision", path: "/vision" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "The Genosyn vision",
          url: `${SITE_URL}/vision`,
          description: VISION_DESCRIPTION,
          isPartOf: { "@type": "WebSite", name: "Genosyn", url: SITE_URL },
          about: { "@type": "Organization", name: "Genosyn", url: SITE_URL },
        },
      ],
    },
    {
      path: "/products",
      title: "Products — the fourteen tools the work happens in · Genosyn",
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
      title: "8 AI roles, written hour by hour · Genosyn",
      // Derived rather than hand-listed, for the same reason /products is:
      // a hand-written list drifts the moment a role is added.
      description: `What an AI Employee actually does, hour by hour, in eight roles: ${ROLES.map((r) => r.name).join(", ")}.`,
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
    "## Vision",
    "",
    `- [Vision](${SITE_URL}/vision): where Genosyn is going, as opposed to what ships today — companies that run themselves toward a Goal their board sets, with an AI executive team, their own treasury, people hired for physical work, and a monthly letter to the board. The page marks which parts ship today.`,
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
    `- [GitHub repository](${GITHUB_URL}): source code and issues`,
    `- [Roles](${SITE_URL}/roles): what an AI Employee does all day, in eight worked examples`,
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
    "Genosyn is an open-source (Apache 2.0), self-hostable platform for running companies autonomously with AI Employees. The standard installer ships as a single Docker container, with SQLite by default and Postgres available through config. Anthropic, OpenAI API-key, and custom OpenAI-compatible models use the bundled OpenCode runtime. Trusted single-tenant deployments use host coding by default, including standard Docker, with bubblewrap isolation optional. OpenAI subscription access keeps using the official pinned Codex app-server. Model credentials are AES-256-GCM encrypted in the database; managed subscription sessions are materialized only inside a locked temporary directory for a login or Run.",
    "",
    `Install: \`curl -fsSL ${SITE_URL}/install.sh | bash\` starts Genosyn on localhost:8471.`,
    "",
    "## Vocabulary",
    "",
    "- **AI Employee** — a persistent teammate attached to a company (never called an agent or bot in product copy).",
    "- **Soul** — the employee's written constitution, one markdown document.",
    "- **Skill** — a reusable markdown playbook.",
    "- **Routine** — scheduled, cron-driven AI work; one execution is a **Run**.",
    "- **AI Model** — a model API connection owned by an employee (Anthropic, OpenAI, or custom endpoint).",
    "- **Member** — a human user in a company.",
    "- **Integration / Connection / Grant** — a connector type / one authenticated account / an AI Employee's access to a resource.",
    "- **Tasks** — the task-manager feature (Projects + todos). Scheduled AI work is always a Routine, never a task.",
    "",
  ];

  for (const r of ROLES) {
    lines.push(`## Role: ${r.name} (${SITE_URL}/roles/${r.slug})`, "");
    lines.push(r.intro, "");
    lines.push("A working day:", "");
    for (const m of r.day) {
      const flag = m.kind === "decision" ? " [stopped and asked a human]" : "";
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
    lines.push("", `With AI Employees: ${p.employees.body}`, "");
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
    `## Vision (${SITE_URL}/vision)`,
    "",
    "This section describes direction, not shipped behavior. Genosyn's vision is a company that runs itself, completely, toward a Goal its board sets: the people involved are not managers supervising AI step by step, they are the board. Given one Goal, Genosyn hires an AI CEO; the CEO hires an AI executive team; the team hires AI Employees and books people for physical work, paying them from a checking account the directors grant the AI CFO access to. The reserves sit in a bitcoin vault whose keys only the directors hold: the company can add to it, and only the board can take anything out. Once a month the AI CEO writes the board a letter — what happened, what went wrong, where the money went — and only rarely asks a question, when it is one only an owner can answer.",
    "",
    "The board keeps four things: the Goal, the vault, the monthly letter, and a switch that stands the whole company down. Everything else (strategy, prices, hiring, payments from checking, even its own Policies) the company decides on its own. Goals and Standdowns ship today; the AI executive team, the monthly board letter, the treasury, and work orders for people are on the road.",
    "",
  );

  lines.push(
    "## Self-hosting",
    "",
    "Genosyn runs as one Docker container managed by the `genosyn` CLI (a bash wrapper around Docker). Every install gets the whole product, single sign-on and the audit log included, under Apache 2.0. All runtime settings live in a single config.ts. Data lives under a configurable data directory; the database is the source of truth for Souls, Skills, Routines, Run transcripts, and encrypted model credentials. Backups, restore, and off-box destinations (NAS/SMB/SFTP) are built in. Kubernetes manifests are documented for cluster deployments.",
    "",
    `Full docs: ${SITE_URL}/docs · Source: ${GITHUB_URL}`,
    "",
  );

  return lines.join("\n");
}
