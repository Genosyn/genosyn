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
      {
        path: "/docs",
        title: "Introduction",
        blurb: "What Genosyn is, who it is for, and how to think about it.",
      },
      {
        path: "/docs/install",
        title: "Install",
        blurb: "One command to a running container on localhost:8471.",
      },
      {
        path: "/docs/mobile",
        title: "Install on your phone",
        blurb: "Add Genosyn to your home screen as a PWA — iOS, Android, desktop.",
      },
      {
        path: "/docs/security",
        title: "Account security",
        blurb: "Optional 2FA with authenticator apps, passkeys, and USB security keys.",
      },
    ],
  },
  {
    label: "Core concepts",
    pages: [
      {
        path: "/docs/employees",
        title: "AI Employees",
        blurb: "Persistent personas attached to a company.",
      },
      { path: "/docs/soul", title: "Soul", blurb: "The written constitution of an employee." },
      { path: "/docs/skills", title: "Skills", blurb: "Reusable markdown playbooks." },
      {
        path: "/docs/routines",
        title: "Routines & Runs",
        blurb: "Scheduled, cron-triggered AI work.",
      },
      {
        path: "/docs/tags",
        title: "Tags",
        blurb: "Reusable company labels for organizing resources.",
      },
    ],
  },
  {
    label: "Brains & tools",
    pages: [
      {
        path: "/docs/models",
        title: "AI Models",
        blurb: "Connect Anthropic, OpenAI, or a custom OpenAI-compatible endpoint.",
      },
      {
        path: "/docs/open-source-models",
        title: "Open-source LLMs",
        blurb: "Run Ollama, vLLM, or llama.cpp and point an employee at it.",
      },
      {
        path: "/docs/integrations",
        title: "Integrations",
        blurb: "Connections, Grants, and the MCP surface.",
      },
      {
        path: "/docs/browser",
        title: "Browser",
        blurb: "A persistent headless Chromium per employee — watch live, take over anytime.",
      },
    ],
  },
  {
    label: "Engineering",
    pages: [
      {
        path: "/docs/code",
        title: "Code Repositories",
        blurb: "Add any git repo; let granted AI employees commit and push.",
      },
    ],
  },
  {
    label: "Analytics",
    pages: [
      {
        path: "/docs/explore",
        title: "Explore",
        blurb: "Self-serve BI — Charts and Dashboards over your database integrations.",
      },
    ],
  },
  {
    label: "Marketing",
    pages: [
      {
        path: "/docs/marketing",
        title: "Paid Marketing",
        blurb:
          "Ad-platform Integrations with spending caps, approval-gated budget levers, and a Performance Marketer template.",
      },
    ],
  },
  {
    label: "Operations",
    pages: [
      {
        path: "/docs/workspace-chat",
        title: "Workspace chat",
        blurb:
          "Channels and DMs with AI replies, context resets, and company resource tags.",
      },
      {
        path: "/docs/email",
        title: "Email",
        blurb:
          "Connect Gmail, work your inbox, hand threads to AI employees, and triage new mail with rules.",
      },
      {
        path: "/docs/tasks",
        title: "Tasks",
        blurb:
          "Projects, todos, and subtasks — assigned to humans or AI employees; restrict who reaches each project.",
      },
      {
        path: "/docs/pipelines",
        title: "Pipelines",
        blurb: "Build predictable trigger-to-step automations and inspect every Run.",
      },
      {
        path: "/docs/bases",
        title: "Bases",
        blurb:
          "Airtable-style tables with views, comments, attachments, and columns that link customers, projects, and more.",
      },
      {
        path: "/docs/customers",
        title: "Customers",
        blurb: "Accounts, contacts, annual contract value, statements, and signed contracts.",
      },
      {
        path: "/docs/finance",
        title: "Finance",
        blurb: "Estimates, invoices, bills, ledger, and reports — native double-entry accounting.",
      },
    ],
  },
  {
    label: "Self-hosting",
    pages: [
      {
        path: "/docs/self-hosting",
        title: "Configuration",
        blurb: "config.ts, the data directory, backups.",
      },
      { path: "/docs/cli", title: "CLI reference", blurb: "Every genosyn command, every flag." },
      {
        path: "/docs/kubernetes",
        title: "Kubernetes",
        blurb: "Raw manifests for running Genosyn on a cluster.",
      },
    ],
  },
  {
    label: "Reference",
    pages: [
      {
        path: "/docs/vocabulary",
        title: "Vocabulary",
        blurb: "Words we use, and the words we don't.",
      },
    ],
  },
];

export const DOCS_FLAT: DocsPageMeta[] = DOCS_NAV.flatMap((s) => s.pages);

export function findPageMeta(path: string): DocsPageMeta | undefined {
  return DOCS_FLAT.find((p) => p.path === path);
}
