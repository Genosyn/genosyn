export type DocsPageMeta = {
  path: string;
  title: string;
  blurb?: string;
};

export type DocsSection = {
  label: string;
  pages: DocsPageMeta[];
};

export const DOCS_NAV: DocsSection[] = [
  {
    label: "Get started",
    pages: [
      { path: "/docs", title: "Introduction", blurb: "What Genosyn is, who it is for, and how to think about it." },
      { path: "/docs/install", title: "Install", blurb: "One command to a running container on localhost:8471." },
    ],
  },
  {
    label: "Core concepts",
    pages: [
      { path: "/docs/employees", title: "AI Employees", blurb: "Persistent personas attached to a company." },
      { path: "/docs/soul", title: "Soul", blurb: "The written constitution of an employee." },
      { path: "/docs/skills", title: "Skills", blurb: "Reusable markdown playbooks." },
      { path: "/docs/routines", title: "Routines & Runs", blurb: "Scheduled, cron-triggered AI work." },
    ],
  },
  {
    label: "Brains & tools",
    pages: [
      { path: "/docs/models", title: "AI Models", blurb: "Pick a CLI: Claude Code, Codex, opencode, Goose, OpenClaw." },
      { path: "/docs/open-source-models", title: "Open-source LLMs", blurb: "Run Ollama, vLLM, or llama.cpp and point an employee at it." },
      { path: "/docs/integrations", title: "Integrations", blurb: "Connections, Grants, and the MCP surface." },
    ],
  },
  {
    label: "Analytics",
    pages: [
      { path: "/docs/explore", title: "Explore", blurb: "Self-serve BI — Charts and Dashboards over your database integrations." },
    ],
  },
  {
    label: "Operations",
    pages: [
      { path: "/docs/customers", title: "Customers", blurb: "Accounts, contacts, annual contract value, and signed contracts." },
      { path: "/docs/finance", title: "Finance", blurb: "Estimates, invoices, bills, ledger, and reports — native double-entry accounting." },
    ],
  },
  {
    label: "Self-hosting",
    pages: [
      { path: "/docs/self-hosting", title: "Configuration", blurb: "config.ts, the data directory, backups." },
      { path: "/docs/cli", title: "CLI reference", blurb: "Every genosyn command, every flag." },
      { path: "/docs/kubernetes", title: "Kubernetes", blurb: "Raw manifests for running Genosyn on a cluster." },
    ],
  },
  {
    label: "Reference",
    pages: [
      { path: "/docs/vocabulary", title: "Vocabulary", blurb: "Words we use, and the words we don't." },
    ],
  },
];

export const DOCS_FLAT: DocsPageMeta[] = DOCS_NAV.flatMap((s) => s.pages);

export function findPageMeta(path: string): DocsPageMeta | undefined {
  return DOCS_FLAT.find((p) => p.path === path);
}
