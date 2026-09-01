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
        path: "/docs/getting-started",
        title: "Onboard your first AI Employee",
        blurb: "The five-step first-run guide, from what an AI Employee is to a first request.",
      },
      {
        path: "/docs/help",
        title: "Genosyn Help",
        blurb: "Ask any AI Employee about the product and its shipped source code.",
      },
      {
        path: "/docs/mobile",
        title: "Install on your phone",
        blurb: "Add Genosyn to your home screen as a PWA — iOS, Android, desktop.",
      },
      {
        path: "/docs/security",
        title: "Account security",
        blurb:
          "Email verification and resend, plus optional 2FA with authenticator apps, passkeys, and USB security keys.",
      },
      {
        path: "/docs/plans-billing",
        title: "Plans & billing",
        blurb:
          "Community, Enterprise, and Genosyn Cloud — the Free / Growth / Scale Plans, limits, and Stripe setup.",
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
        blurb:
          "Connect API keys, a custom endpoint, or a trusted single-tenant OpenAI subscription.",
      },
      {
        path: "/docs/tool-discovery",
        title: "How tools reach the model",
        blurb: "Why an employee is shown a working set of tools and finds the rest on demand.",
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
        title: "Web & Browser",
        blurb:
          "Search, read and download from the web — plus a persistent headless Chromium per employee.",
      },
      {
        path: "/docs/member-browsers",
        title: "Member browsers",
        blurb:
          "Connect a Chrome on your own computer — a dedicated profile you sign into, driven by the same tools.",
      },
    ],
  },
  {
    label: "Engineering",
    pages: [
      {
        path: "/docs/repositories",
        title: "Repositories",
        blurb:
          "Version-controlled workspaces — code, strategy, policies. Edit in the browser, or hand one to an AI Employee.",
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
          "Campaigns, Creative, Experiments, autonomous Routines, and guarded ad-platform delivery.",
      },
    ],
  },
  {
    label: "Revenue",
    pages: [
      {
        path: "/docs/revenue",
        title: "Revenue",
        blurb: "Contacts, deals, the board, and a timeline that fills itself from your mailbox.",
      },
      {
        path: "/docs/revenue-operations",
        title: "Revenue operations",
        blurb:
          "Follow-ups, prospect accounts, custom fields, partnerships, documents, and reversible migrations.",
      },
      {
        path: "/docs/revenue-data-quality",
        title: "Revenue data quality",
        blurb:
          "Audited merges, bulk cleanup, historical truth, enrichment review, document capture, and exports.",
      },
      {
        path: "/docs/sequences",
        title: "Sequences",
        blurb:
          "Multi-step outbound drafted per contact by an AI Employee, with review, send windows, and caps.",
      },
      {
        path: "/docs/signals",
        title: "Signals",
        blurb:
          "Product-usage triggers — a saved query over your own database, deduplicated and acted on.",
      },
      {
        path: "/docs/deliverability",
        title: "Deliverability",
        blurb:
          "Suppression list, unsubscribe and one-click, bounces, send caps — how not to burn your domain.",
      },
    ],
  },
  {
    label: "Operations",
    pages: [
      {
        path: "/docs/workspace-chat",
        title: "Workspace chat",
        blurb: "Channels and DMs with AI replies, context resets, and company resource tags.",
      },
      {
        path: "/docs/chat-surfaces",
        title: "External chat surfaces",
        blurb:
          "Reach an AI Employee from Slack, Microsoft Teams, WhatsApp, or Telegram — and link your account so it answers as you.",
      },
      {
        path: "/docs/tldrs",
        title: "TLDRs",
        blurb:
          "Periodic AI-written recaps, with standing questions answered beside them and one-click actions on each answer.",
      },
      {
        path: "/docs/vault",
        title: "Vault",
        blurb:
          "Encrypted logins with authenticator codes and software passkeys, plus API keys and secure notes.",
      },
      {
        path: "/docs/vault-sources",
        title: "Vault sources",
        blurb:
          "Mirror a Bitwarden or Vaultwarden vault into the Vault — read-only, with secrets fetched live.",
      },
      {
        path: "/docs/email",
        title: "Email",
        blurb:
          "Connect Gmail, get every new email triaged with one-click action buttons, review AI-written drafts, and automate the inbox with rules.",
      },
      {
        path: "/docs/meetings",
        title: "Meetings",
        blurb:
          "Mirror a Google calendar, turn recordings and transcripts into customer timeline entries, and let an AI Employee file the follow-ups.",
      },
      {
        path: "/docs/tasks",
        title: "Tasks",
        blurb:
          "Projects, todos, and subtasks — assigned to humans or AI Employees; restrict who reaches each project.",
      },
      {
        path: "/docs/decisions",
        title: "Decision stack",
        blurb:
          "Questions your AI Employees stopped to ask, with the options they will act on — answered from Home.",
      },
      {
        path: "/docs/goals",
        title: "Goals",
        blurb:
          "Measurable objectives, cascaded company → employee — in every AI prompt, checked against every Run.",
      },
      {
        path: "/docs/verification",
        title: "What proves a Run worked",
        blurb:
          "Status, Checks, and the outcome verdict — plus the effect ledger the server writes and the model cannot narrate.",
      },
      {
        path: "/docs/improvement",
        title: "The improvement loop",
        blurb:
          "Lessons from graded-bad Runs feed the next brief; Revision proposals stage durable fixes a human applies.",
      },
      {
        path: "/docs/autonomy",
        title: "Earned autonomy",
        blurb:
          "Waivers an AI Employee earns with a clean record — proposed via Approvals, revoked automatically on any bad Run.",
      },
      {
        path: "/docs/standdowns",
        title: "Standdowns",
        blurb:
          "A revocable stop on all AI work at company, employee, or Routine scope — placed by a human, or tripped by the failure breaker.",
      },
      {
        path: "/docs/policies",
        title: "Company policies",
        blurb:
          "Standing rails that bind every AI Employee — written policies, monthly ad-spend Budgets, and held calls from tainted turns.",
      },
      {
        path: "/docs/reactivity",
        title: "Reactivity",
        blurb:
          "Event-fired Routines, self-scheduled Wakeups, Workstreams carrying state across Runs, and Initiatives a human accepts.",
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
        path: "/docs/pdf-forms",
        title: "PDF forms",
        blurb:
          "Fill interactive PDF forms, and complete printed or scanned ones by drawing answers onto the original.",
      },
      {
        path: "/docs/word-documents",
        title: "Word documents",
        blurb:
          "Read, answer and edit .docx files keeping the original formatting, or write a new one from scratch.",
      },
      {
        path: "/docs/signatures",
        title: "Document signing",
        blurb:
          "Prepare, send, sign, and archive PDFs with recipient evidence and AI Employee delegation.",
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
        path: "/docs/saas-hosting",
        title: "Shared SaaS mode",
        blurb: "Multi-tenant production requirements, isolation, and replica coordination.",
      },
      {
        path: "/docs/self-hosting",
        title: "Configuration",
        blurb: "config.ts, the runtime settings in Admin, the data directory, backups.",
      },
      { path: "/docs/cli", title: "CLI reference", blurb: "Every genosyn command, every flag." },
      {
        path: "/docs/kubernetes",
        title: "Kubernetes",
        blurb: "Raw manifests for running Genosyn on a cluster.",
      },
      {
        path: "/docs/enterprise-license",
        title: "Enterprise licenses",
        blurb:
          "Unlock SSO and the Audit log on a self-hosted install with an offline-verified license key.",
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
