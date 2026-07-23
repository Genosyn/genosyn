/**
 * Product registry — the single source of truth for the marketing product
 * pages, their SEO metadata, sitemap entries, and the llms.txt files.
 *
 * Deliberately pure data (no JSX, no React imports): vite.config.ts imports
 * this module at build time to prerender routes. Icons are referenced by key
 * and resolved in productIcons.ts; preview mockups live in previews.tsx.
 *
 * Copy rules: only shipped capabilities (ROADMAP milestones marked [x]) are
 * claimed. Vocabulary follows AGENTS.md §3 — Routine, Soul, Skill,
 * AI Employee, Member, Integration, Connection, Grant.
 */

export type ProductFeature = {
  icon: string;
  title: string;
  body: string;
};

export type ProductFaq = {
  q: string;
  a: string;
};

export type ProductDef = {
  slug: string;
  name: string;
  category: string;
  icon: string;
  /** Tailwind classes for tinted icon tiles. */
  accent: string;
  /** Two-tone H1: `tagline` in zinc-950, `taglineAccent` in zinc-500. */
  tagline: string;
  taglineAccent: string;
  /** One-liner for cards and cross-link strips. */
  summary: string;
  /** <title> tag, aim for ≤ 60 chars. */
  seoTitle: string;
  /** Meta description, aim for ~155 chars. */
  description: string;
  /** Hero paragraph. */
  intro: string;
  /** Hero check bullets. */
  checks: string[];
  features: ProductFeature[];
  employees: {
    heading: string;
    body: string;
    bullets: { title: string; body: string }[];
  };
  faqs: ProductFaq[];
  docsPath: string | null;
  keywords: string[];
};

export const PRODUCTS: ProductDef[] = [
  // ─────────────────────────────── AI Employees ──────────────────────────────
  {
    slug: "ai-employees",
    name: "AI Employees",
    category: "The core",
    icon: "users",
    accent: "bg-violet-50 text-violet-700 ring-violet-200",
    tagline: "Hire teammates that never log off.",
    taglineAccent: "A Soul, a set of Skills, Routines on a schedule.",
    summary:
      "Persistent AI teammates with a written constitution, markdown playbooks, and cron-scheduled work — every execution captured as a readable Run.",
    seoTitle: "AI Employees — Soul, Skills & Routines · Genosyn",
    description:
      "Hire AI employees with a written Soul, reusable Skills, and cron-scheduled Routines. Runs on Claude, GPT, or any local model. Open source and self-hosted.",
    intro:
      "An AI Employee is not a chatbot persona. It is a persistent teammate attached to your company — with a Soul that says who it is, Skills that say what it knows, Routines that say when it works, and its own sandboxed working directory. Every execution is captured as a Run you can read line by line.",
    checks: [
      "11 role templates or start blank",
      "Claude, GPT, or any local model",
      "Keys encrypted, never on disk",
      "Every Run fully transcribed",
    ],
    features: [
      {
        icon: "bookHeart",
        title: "A Soul, not a prompt",
        body: "One markdown constitution per employee — identity, voice, decision rules, refusals — edited in-app with live preview. Change how they think by editing a document, like a job description.",
      },
      {
        icon: "sparkles",
        title: "Skills as playbooks",
        body: "Named markdown playbooks — trigger, inputs, steps, definition of done — surfaced into the model's context on every run. Browse and reuse them across your team from the company-wide library.",
      },
      {
        icon: "calendarClock",
        title: "Routines on cron",
        body: "Pair a markdown brief with a 5-field cron expression and a plain-English preview. Per-routine timeouts, enable/disable toggles, an optional approval gate, and one-click Run now.",
      },
      {
        icon: "brainCircuit",
        title: "Bring any brain",
        body: "Register Anthropic, OpenAI, or any OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp, LM Studio. Keep several models per employee and pin a Routine to a cheap local one while chat stays on the frontier brain.",
      },
      {
        icon: "scrollText",
        title: "Runs you can audit",
        body: "Every execution streams its full agent transcript live over WebSocket and keeps it afterwards. Retry failures in one click; usage and cost roll up per employee and per Routine.",
      },
      {
        icon: "shieldCheck",
        title: "Approvals and Grants",
        body: "Access to Connections, repos, notes, Bases, and mailboxes is granted per employee. Sensitive actions — gated Routines, browser form submits, payments over a cap — wait for a human checkmark.",
      },
    ],
    employees: {
      heading: "How the pieces fit",
      body: "Genosyn talks to the model API in-process and runs the tool-use loop itself — no provider CLIs, no config files on disk. Each turn carries the Soul and every Skill; what the employee can reach is decided by explicit Grants.",
      bullets: [
        {
          title: "Real tools, sandboxed",
          body: "Built-in coding tools (bash, file edits, grep) run inside the employee's own working directory; opt-in browser tools drive a headless Chromium with a host allow-list and human take-over for captchas.",
        },
        {
          title: "Memory that persists",
          body: "Employees save durable Memory that is auto-injected into future runs, keep an append-only Journal, and hand work to each other along the org chart with AI-to-AI Handoffs.",
        },
        {
          title: "Long runs that survive",
          body: "Context-window budgeting compacts old tool results with a visible marker instead of failing the run — an hourly digest on a 8k-window local model just keeps working.",
        },
      ],
    },
    faqs: [
      {
        q: "What exactly is an AI Employee — is it just a chatbot persona?",
        a: "No. It is a persistent persona attached to your company with a Soul (constitution), Skills (playbooks), Routines (cron-scheduled work), its own AI Models, a sandboxed working directory on disk, and explicit Grants to company resources. Every scheduled or manual execution is recorded as a Run with a full transcript.",
      },
      {
        q: "Which models can an employee run on?",
        a: "Three provider kinds: Anthropic (Claude), OpenAI (GPT), or Custom — any OpenAI-compatible endpoint such as Ollama, vLLM, llama.cpp, LM Studio, or a gateway. An employee can hold several models with exactly one active, and individual Routines can pin a specific model.",
      },
      {
        q: "Where do the API keys live?",
        a: "Encrypted with AES-256-GCM on the AIModel row in your own database — never on disk and never shared company-wide. Each employee owns its credentials, so removing an employee deletes every encrypted credential row.",
      },
      {
        q: "Can an AI Employee take an action I haven't approved?",
        a: "Not if you gate it. Flip approval-required on a Routine and the run blocks on a human checkmark; browser form submits can require approval per employee; Lightning payments over a per-connection cap queue for approval automatically. An Approvals inbox surfaces everything waiting.",
      },
      {
        q: "Do I need to install a provider CLI or wrapper per model?",
        a: "No. Genosyn calls the model API in-process and runs the tool-use loop itself — no CLI installs, no subscription sign-in, no per-provider config files. Every provider kind gets the same built-in toolset.",
      },
    ],
    docsPath: "/docs/employees",
    keywords: [
      "AI employees",
      "hire AI employees",
      "autonomous AI agents for business",
      "self-hosted AI agents",
      "open source AI employee platform",
      "AI agent with cron scheduling",
      "Claude API agent platform",
      "OpenAI-compatible agent runner",
      "scheduled AI routines",
      "human in the loop AI approvals",
    ],
  },

  // ──────────────────────────────── Workspace ────────────────────────────────
  {
    slug: "workspace",
    name: "Workspace",
    category: "Essentials",
    icon: "messageSquare",
    accent: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    tagline: "Team chat where AI shows up to work.",
    taglineAccent: "Channels, DMs, and files — humans and AI employees together.",
    summary:
      "Slack-style channels and DMs where AI employees are real members — @mention one and it joins, replies, and reports back from its Routines.",
    seoTitle: "Workspace — Team chat with AI employees · Genosyn",
    description:
      "Self-hosted team chat where AI employees are first-class members. Channels, DMs, reactions, file uploads, realtime presence — @mention an employee and it replies.",
    intro:
      "Workspace is the chat your company actually runs on — public and private channels, 1:1 DMs, reactions, and file uploads, self-hosted next to everything else. The difference from bolting Slack onto your stack: AI employees are members, not webhook bots. @mention one and it joins the channel and answers like a teammate.",
    checks: [
      "Channels, DMs, threads-ready replies",
      "Realtime over one WebSocket hub",
      "25 MB file uploads, stored on disk",
      "AI employees read shared files",
    ],
    features: [
      {
        icon: "hash",
        title: "Channels and DMs",
        body: "Public and private channels with topics and archive; 1:1 DMs between any two members — human or AI — with idempotent pairing, so the same pair always lands in the same conversation.",
      },
      {
        icon: "atSign",
        title: "@mention an employee",
        body: "Mention an AI employee by slug and it is auto-invited to the channel and replies in place, with the channel's recent history as context. In a DM it answers every message — no tag needed.",
      },
      {
        icon: "zap",
        title: "Actually realtime",
        body: "Messages, edits, deletes, reactions, presence, and typing indicators — including an “is typing…” pill while an AI employee thinks — fan out live over an in-process WebSocket hub.",
      },
      {
        icon: "paperclip",
        title: "Files AI can read",
        body: "Upload up to 25 MB per file; images render inline. Text-like attachments — txt, md, csv, json, html, PDF — are extracted and inlined into the employee's prompt, so “summarize this” just works.",
      },
      {
        icon: "megaphone",
        title: "Proactive reports",
        body: "Routines can post into channels and DM humans through built-in tools — standups, status updates, and handoffs land where the team already looks, on schedule.",
      },
      {
        icon: "listChecks",
        title: "Nothing slips",
        body: "Unread badges, read markers, and a sidebar sorted by activity. Mentions land in the bell feed and fan out over Web Push to your phone via the PWA.",
      },
    ],
    employees: {
      heading: "Peers in the chat, not integrations",
      body: "AI employees appear in the member directory and channel lists like anyone else. Chat is part of every employee's built-in tool surface — no Grant setup needed — with guardrails that keep it civilized.",
      bullets: [
        {
          title: "Reply like a teammate",
          body: "A mentioned employee reads the channel's last 20 messages plus any attached files, then answers in-channel while a typing pill shows it is working.",
        },
        {
          title: "Drive the chat themselves",
          body: "Built-in tools let employees list, create, rename, and archive channels, and send messages to channels, humans, or other AI employees — so Routines file their own reports.",
        },
        {
          title: "Guardrails built in",
          body: "A self-mention loop guard means an employee never replies to itself, and mentions only reach employees that are actually channel members.",
        },
      ],
    },
    faqs: [
      {
        q: "Do we still need Slack?",
        a: "Workspace ships inside Genosyn: public and private channels, DMs, reactions, file uploads, unread badges, and realtime WebSocket updates — self-hosted with the rest of your company, no extra chat service or per-seat bill.",
      },
      {
        q: "How do AI employees participate in chat?",
        a: "@mention an AI employee by its slug and it joins the channel and replies like a teammate; DM one and it answers every message without needing a tag. Employees can also post proactively — Routines can call the built-in send_workspace_message tool to file standups or status updates into a channel.",
      },
      {
        q: "Can an AI employee read the files I drop into a channel?",
        a: "Yes — text-like attachments (txt, md, csv, json, yaml, html, and PDFs) are extracted and inlined into the employee's prompt, capped at 30,000 characters per file. Images and other binaries are announced by name.",
      },
      {
        q: "What are the file upload limits?",
        a: "25 MB per file. Bytes live on disk under your data directory, so large files never bloat the database — one reason the whole platform runs happily on SQLite.",
      },
      {
        q: "Does it support threads?",
        a: "Replies carry a parent message, and AI employees can already reply threaded through the messaging tool. A dedicated split-panel thread UI is on the roadmap; today replies render inline.",
      },
    ],
    docsPath: null,
    keywords: [
      "self-hosted Slack alternative",
      "team chat with AI agents",
      "open source team chat",
      "chat with AI coworkers",
      "AI teammates in channels",
      "human-AI collaboration workspace",
      "realtime workspace chat open source",
    ],
  },

  // ────────────────────────────────── Tasks ──────────────────────────────────
  {
    slug: "tasks",
    name: "Tasks",
    category: "Essentials",
    icon: "listTodo",
    accent: "bg-rose-50 text-rose-700 ring-rose-200",
    tagline: "One board for people and AI.",
    taglineAccent: "Projects, todos, and a review queue that keeps humans in charge.",
    summary:
      "A Linear-style task manager where any todo can be assigned to a human or an AI employee — with an in-review flow that closes the trust gap.",
    seoTitle: "Tasks — Projects and kanban for humans + AI · Genosyn",
    description:
      "Self-hosted task manager where humans and AI employees share one board. Projects with ENG-42 IDs, kanban, subtasks, recurring todos, and human review queues.",
    intro:
      "Tasks is Genosyn's built-in task manager — Projects that mint short IDs like ENG-42, todos with six statuses and five priorities, a drag-and-drop board, and subtasks with progress chips. Humans and AI employees work the same board under the same access rules, so the AI's work is visible, reviewable, and never off in a silo.",
    checks: [
      "Kanban board and list views",
      "Assign todos to humans or AI",
      "in_review flow with a reviewer queue",
      "Recurring todos, daily to yearly",
    ],
    features: [
      {
        icon: "layoutGrid",
        title: "Projects with short IDs",
        body: "Group work into Projects with a 1–6 character key that mints IDs like ENG-42. Six statuses from backlog to done, five priorities, due dates, and a board or list view of everything.",
      },
      {
        icon: "userCheck",
        title: "Review before done",
        body: "Set a reviewer on any todo. Work moves to in_review instead of done, the reviewer gets a notification — including web push — and a cross-project Review queue collects everything waiting on you.",
      },
      {
        icon: "gitFork",
        title: "Subtasks that decompose",
        body: "Break a todo into subtasks — real todos with their own status, assignee, and discussion. The parent shows a progress bar and a 2/5 chip, and an AI employee can do the decomposing for you.",
      },
      {
        icon: "repeat",
        title: "Recurring todos",
        body: "Daily, weekdays, weekly, biweekly, monthly, or yearly — completing one occurrence schedules the next automatically. The human-checklist complement to AI Routines.",
      },
      {
        icon: "lock",
        title: "Project access control",
        body: "Projects are open by default; restrict one to a named list of people and AI employees at view-only or can-edit. The rule binds the UI and the AI tool surface identically — no side doors.",
      },
      {
        icon: "messagesSquare",
        title: "Discussions with AI in them",
        body: "Every todo has a comment thread. Mention an AI employee and it reads the todo plus the whole thread, then replies inline with what it found or fixed.",
      },
    ],
    employees: {
      heading: "AI employees work the board",
      body: "Through built-in tools, employees list and create Projects and todos under exactly the access rules humans get — a project an employee was not added to simply does not appear in its results.",
      bullets: [
        {
          title: "They own their follow-through",
          body: "A todo created by an AI employee assigns itself by default, so work it commits to in chat becomes tracked, visible work on the board.",
        },
        {
          title: "Plans become checklists",
          body: "“Plan the launch” turns into a parent todo with subtasks — statuses, assignees, due dates — that you can watch move across the board.",
        },
        {
          title: "Humans sign off",
          body: "Employees mark finished work in_review with a human reviewer instead of done. It waits in your Review queue until you approve it.",
        },
      ],
    },
    faqs: [
      {
        q: "Can AI employees actually create and manage tasks, or just read them?",
        a: "They fully manage them: listing and creating Projects, and creating and updating todos — status, priority, assignee, reviewer, due date, and subtask nesting — through built-in tools, governed by the same project access rules as humans.",
      },
      {
        q: "How do I stay in control of what an AI employee marks as finished?",
        a: "Use the review flow. The employee moves its work to in_review with you as reviewer instead of done. You get a notification (including web push on your phone), and the todo sits in your cross-project Review queue until you sign it off.",
      },
      {
        q: "Can I keep an AI employee out of a sensitive project?",
        a: "Yes. Switch the project from open to restricted and add people and AI employees explicitly at view-only or can-edit. The restriction covers the UI and the AI tool surface alike, and safety rails stop you locking yourself out — the last human editor can never be removed.",
      },
      {
        q: "Does Tasks handle recurring work?",
        a: "Recurring todos, yes — six cadences from daily to yearly, where completing one schedules the next occurrence. For scheduled recurring AI work, Genosyn has a separate concept called Routines; Tasks is the human-style checklist surface.",
      },
      {
        q: "Why is it called Tasks and not something else?",
        a: "In Genosyn's vocabulary, Tasks means exactly this feature — Projects and todos. Scheduled recurring AI work is always called a Routine, so the two never blur together.",
      },
    ],
    docsPath: "/docs/tasks",
    keywords: [
      "AI task manager",
      "assign tasks to AI employees",
      "open source Linear alternative",
      "self-hosted task manager",
      "kanban board with AI",
      "human in the loop task review",
      "AI project management",
    ],
  },

  // ────────────────────────────────── Bases ──────────────────────────────────
  {
    slug: "bases",
    name: "Bases",
    category: "Knowledge",
    icon: "table2",
    accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    tagline: "Your operational database, on your server.",
    taglineAccent: "Airtable-style tables that AI employees read and write.",
    summary:
      "Multi-table workspaces with typed fields, saved views, comments, and attachments — and 21 built-in tools for granted AI employees.",
    seoTitle: "Bases — Airtable-style tables for AI teams · Genosyn",
    description:
      "Self-hosted Airtable alternative for AI teams: multi-table Bases with 11 field types, saved views, comments, and attachments AI employees query and update.",
    intro:
      "Bases are Genosyn's structured-data layer: multi-table workspaces with typed fields, saved views, record comments, and file attachments — the CRM, hiring pipeline, or content calendar your company would otherwise keep in a bolted-on Airtable. Grant an AI employee a Base and it works the same tables you do, with every write audited.",
    checks: [
      "11 field types, incl. linked records",
      "Saved views: filters, sorts, hidden fields",
      "5 templates, from CRM to ATS",
      "Every AI write audit-logged",
    ],
    features: [
      {
        icon: "columns3",
        title: "Typed fields, linked tables",
        body: "Eleven field types — text, number, checkbox, dates, email, URL, selects, and link fields that reference rows in sibling tables. Renaming a field never migrates data; values key on field IDs.",
      },
      {
        icon: "filter",
        title: "Views that stick",
        body: "Save views per table combining type-aware filters (is before, has any of, is empty…), multi-key sorts, and hidden fields — so the pipeline view and the finance view stop fighting.",
      },
      {
        icon: "panelRight",
        title: "Records as forms",
        body: "Open any row in a side drawer: field values as a form, a comment thread, and file attachments. Comments attribute each message to a human Member or an AI employee — one shared stream.",
      },
      {
        icon: "layoutTemplate",
        title: "Start from a template",
        body: "Five built-in templates — Blank, CRM, Applicant Tracker, Content Calendar, Project Tracker — seeded with linked tables and starter rows, ready to edit.",
      },
      {
        icon: "bot",
        title: "A Base Assistant",
        body: "A slide-over chat routes your prompt through an AI employee loaded with the Base's schema and suggests changes — applying them stays your call, keeping the blast radius small.",
      },
      {
        icon: "keyRound",
        title: "Grants, not guesswork",
        body: "Access is per-employee, per-Base. One Grant opens read/write on every table; revoking it removes the tools from the employee's next spawn. AI uploads cap at 5 MB so a runaway call can't fill the disk.",
      },
    ],
    employees: {
      heading: "21 tools for granted employees",
      body: "A granted AI employee gets the full Bases surface as built-in tools — schema, rows, comments, and attachments — with pagination, audit trails, and caps designed for autonomous use.",
      bullets: [
        {
          title: "Schema and data alike",
          body: "Employees create tables, add fields of all 11 types, and read or write rows — paginated up to 500 at a time — the same surface humans get in the grid editor.",
        },
        {
          title: "They can start from zero",
          body: "An employee can create a brand-new Base on request and is auto-granted on it, so “set up a tracker for this” is a one-message job.",
        },
        {
          title: "Deliverables attach",
          body: "Exports from the Resources library and other tool output can be filed onto a Base record as an attachment — reports land next to the rows they describe.",
        },
      ],
    },
    faqs: [
      {
        q: "How do I control which AI employees can touch a Base?",
        a: "Access is per-employee, per-Base via a Grant, managed from the Base's access panel. One Grant gives read/write on every table in that Base, and revoking it means the employee's next spawn doesn't see the Base tools at all.",
      },
      {
        q: "Can an AI employee change the schema, or only the data?",
        a: "Both. Granted employees have tools to create tables, add, update, and delete fields of all eleven types, and read and write rows — the same surface humans get. Every write is validated and recorded in the audit log.",
      },
      {
        q: "What field types are supported?",
        a: "Eleven: text, long text, number, checkbox, date, datetime, email, URL, single select, multi-select, and link fields that reference records in another table of the same Base. Renaming a field never migrates data because cell values are keyed by field ID.",
      },
      {
        q: "How is this different from Explore or the Airtable integration?",
        a: "Bases are structured workspaces your company owns natively inside Genosyn. Explore is BI over external database Connections, and the separate Airtable Integration connects employees to an external Airtable account. Bases keep the data on your own instance.",
      },
      {
        q: "Do I have to start from a blank table?",
        a: "No — five templates ship built in: Blank, CRM (Contacts, Companies, Deals with cross-table links), Applicant Tracker, Content Calendar, and Project Tracker, each seeded with fields and starter rows.",
      },
    ],
    docsPath: null,
    keywords: [
      "open source Airtable alternative",
      "self-hosted Airtable alternative",
      "AI agent database tools",
      "no-code database for AI agents",
      "multi-table workspace open source",
      "applicant tracker template",
      "content calendar template",
    ],
  },

  // ────────────────────────────────── Notes ──────────────────────────────────
  {
    slug: "notes",
    name: "Notes",
    category: "Knowledge",
    icon: "stickyNote",
    accent: "bg-amber-50 text-amber-700 ring-amber-200",
    tagline: "A wiki your AI employees can edit.",
    taglineAccent: "Notion-style pages with Grants that cascade down the tree.",
    summary:
      "Notion-style markdown pages in nested notebooks — read, written, and searched by humans and AI employees under cascading Grants.",
    seoTitle: "Notes — A wiki humans and AI write together · Genosyn",
    description:
      "Self-hosted Notion-style knowledge base where AI employees are first-class authors: block editor, nested pages, search, per-employee Grants, and full audit.",
    intro:
      "Notes is the company knowledge base: Notion-style markdown pages nested inside Notebooks, with a block editor, sidebar tree, search, and trash. SOPs, briefs, runbooks, research — written by humans and AI employees in the same pages, with every AI edit attributed and audited.",
    checks: [
      "Block editor with slash commands",
      "Unlimited page nesting per notebook",
      "Grants cascade like Notion sharing",
      "Every AI edit audited + journaled",
    ],
    features: [
      {
        icon: "type",
        title: "A real block editor",
        body: "Headings, lists, to-dos, quotes, dividers, a slash-command menu, and a formatting popover — with markdown round-tripping so AI-written prose renders untouched.",
      },
      {
        icon: "folderTree",
        title: "Notebooks and nesting",
        body: "Top-level Notebooks hold unlimited Notion-style sub-page trees. Reorder and reparent in the sidebar with cycle protection; moving a page drags its whole sub-tree along.",
      },
      {
        icon: "search",
        title: "Search everything",
        body: "Search-as-you-type across titles and bodies, up to 50 hits ordered by most recently edited. AI employees get the same search through their tools, scoped to what they were granted.",
      },
      {
        icon: "share2",
        title: "Cascading Grants",
        body: "Share a page or a whole Notebook with an AI employee at read or write. The Grant cascades to every descendant and resolves live — revoking takes effect immediately.",
      },
      {
        icon: "history",
        title: "Attribution on every page",
        body: "Created-by and last-edited-by show whether a Member or an AI employee touched the page. Every AI write also lands in the audit log and the employee's Journal.",
      },
      {
        icon: "trash2",
        title: "Trash-safe by design",
        body: "Soft-delete to Trash and restore anytime. The AI tooling coaches employees to archive rather than hard-delete, and permanent deletes re-parent children so nothing is orphaned.",
      },
    ],
    employees: {
      heading: "First-class authors, on a leash you set",
      body: "AI employees read and write Notes through built-in tools — list, search, get, create, update, delete — governed by per-employee Grants that only apply to the AI surface. Humans always see everything.",
      bullets: [
        {
          title: "Search before create",
          body: "The tool descriptions steer employees to search for an existing page before writing a new one, so the wiki doesn't fill with duplicates.",
        },
        {
          title: "Write access is deliberate",
          body: "Grants come in read and write levels per page or per Notebook. A parent grant covers every descendant, resolved at access time, so reorganizing never leaks pages.",
        },
        {
          title: "Everything reviewable",
          body: "Every AI create, update, and delete records an audit event and a Journal entry on the employee's diary — you can always reconstruct what changed and why.",
        },
      ],
    },
    faqs: [
      {
        q: "Can AI employees edit our notes, or just read them?",
        a: "Both, if you let them. Each AI employee gets a Grant per Note or per Notebook at read or write level. Write allows creating sub-pages, editing, archiving, and deleting; read allows list, search, and get only. Every AI write is audited and journaled.",
      },
      {
        q: "How does sharing work across nested pages?",
        a: "Like Notion: a Grant on a parent page authorizes every descendant, and a Grant on a Notebook authorizes every page inside it. The cascade resolves at access-check time rather than being copied onto children, so reparenting or revoking takes effect immediately.",
      },
      {
        q: "What happens if an AI employee deletes a page by mistake?",
        a: "The tooling steers employees toward archiving — archived pages sit in a Trash view any human can restore from. Permanent deletes re-parent children one level up so nothing is orphaned, and the action is audited and journaled.",
      },
      {
        q: "How is Notes different from Memory, Journal, and Resources?",
        a: "Notes are co-authored markdown pages — the shared knowledge surface. Memory holds durable facts auto-injected into an employee's prompt; the Journal is a per-employee diary; Resources are external material the team didn't write, ingested for study.",
      },
      {
        q: "How big can pages get?",
        a: "Page bodies hold up to 200,000 characters of markdown with titles up to 200 characters, plus emoji icons on pages and notebooks. Every company starts with a General notebook.",
      },
    ],
    docsPath: null,
    keywords: [
      "open source Notion alternative",
      "self-hosted knowledge base",
      "AI-writable wiki",
      "company wiki for AI agents",
      "Notion-style block editor open source",
      "nested markdown pages",
      "SOP documentation AI",
    ],
  },

  // ──────────────────────────────── Resources ────────────────────────────────
  {
    slug: "resources",
    name: "Resources",
    category: "Knowledge",
    icon: "library",
    accent: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
    tagline: "Ingest once. Every employee studies it.",
    taglineAccent: "URLs, PDFs, ebooks, and transcripts your AI can search and cite.",
    summary:
      "Drop in a URL, PDF, EPUB, or transcript once — every granted AI employee can search it, cite it, export it, and attach it to outgoing email.",
    seoTitle: "Resources — A reference library your AI reads · Genosyn",
    description:
      "Give AI employees a shared reference library: ingest URLs, PDFs, EPUBs, and transcripts to searchable text. Grant-controlled access, PDF export, Gmail attachments.",
    intro:
      "Resources is the knowledge-ingestion surface: external material your team didn't write — articles, ebooks, PDFs, transcripts — ingested once, extracted to searchable plain text, and served to AI employees on demand. It replaces the copy-paste-into-the-prompt ritual and the shared-drive folder no AI can actually read.",
    checks: [
      "URL, PDF, EPUB, text, and markdown",
      "Full-text search over extracted bodies",
      "read < edit < delete Grant levels",
      "Attach to outgoing Gmail by slug",
    ],
    features: [
      {
        icon: "globe",
        title: "Paste a URL, get clean text",
        body: "The server fetches the page and extracts readable text — scripts, nav, and footers stripped — with no browser or scraping stack required. Failed fetches keep the row with the error so a human can fix it.",
      },
      {
        icon: "fileText",
        title: "Real document formats",
        body: "PDFs extract via pdf-parse, EPUBs unzip chapter by chapter, and TXT, Markdown, and HTML upload directly — 25 MB per file, with up to 1 MiB of extracted text each.",
      },
      {
        icon: "search",
        title: "One search across it all",
        body: "Full-text search over titles, summaries, tags, and extracted bodies — search-as-you-type for humans, the same query surface as a tool for AI employees.",
      },
      {
        icon: "bookOpen",
        title: "Readable in place",
        body: "Type-aware detail pages: editable markdown for text, the native viewer for PDFs, an in-app EPUB reader with table of contents and progress, and an open-original card for URLs.",
      },
      {
        icon: "fileOutput",
        title: "Exports that look right",
        body: "Export any Resource as PDF, HTML, Markdown, or plain text. PDFs render through Chromium, so headings, tables, and code blocks come out styled — ready for a chat reply or a Base record.",
      },
      {
        icon: "mailPlus",
        title: "Attach to real email",
        body: "Gmail send and draft tools accept attachments by Resource slug — the server checks the Grant and resolves the bytes, so no base64 ever crosses the model's context window.",
      },
    ],
    employees: {
      heading: "Study before answering",
      body: "AI employees reach the library through built-in tools gated by three Grant levels — read, edit, delete. The tool descriptions coach them to check whether the team already ingested a primer before improvising.",
      bullets: [
        {
          title: "They curate it too",
          body: "An employee can file a URL or a pasted transcript itself with create_resource — it gets full control of rows it authored, while teammates start at read.",
        },
        {
          title: "Levels, not switches",
          body: "read covers list, search, and get; edit adds re-titling, tagging, and body updates; delete allows permanent removal. Humans promote employees between levels from the share modal.",
        },
        {
          title: "New material is instantly usable",
          body: "Every new Resource is automatically granted read to all AI employees, so the primer you drop in at 9:00 informs the Routine that runs at 9:05.",
        },
      ],
    },
    faqs: [
      {
        q: "How is a Resource different from a Note or a Memory?",
        a: "A Resource is content the team did not write — an article, ebook, or transcript ingested once and queried on demand. A Note is a page the team authors together, and a Memory is a durable fact auto-injected into an AI employee's prompt.",
      },
      {
        q: "What formats can I ingest?",
        a: "Web pages by URL (fetched and extracted to plain text), PDF, EPUB, TXT, Markdown, and HTML uploads up to 25 MB per file, and pasted raw text. Video files are accepted but transcripts aren't extracted yet — upload the transcript as text in the meantime.",
      },
      {
        q: "Can AI employees add their own Resources?",
        a: "Yes. The create_resource tool lets an employee index a URL or file a pasted transcript or research summary. The authoring employee automatically gets full control of its own row; teammates start at read-only. File uploads stay human-only.",
      },
      {
        q: "Can an AI employee email a Resource to someone?",
        a: "Yes. The Gmail send and draft tools accept attachments by Resource slug and format — the server checks the employee's Grant, resolves the bytes, and attaches the original file or the text rendered as PDF, HTML, Markdown, or plain text.",
      },
      {
        q: "Does it use embeddings or RAG?",
        a: "v1 retrieval is deliberately simple: case-insensitive substring matching over titles, summaries, tags, and the full extracted text. Embeddings and vector search are planned once real query patterns are known.",
      },
    ],
    docsPath: null,
    keywords: [
      "knowledge ingestion for AI agents",
      "give AI access to documents",
      "PDF ingestion AI",
      "AI document search",
      "company knowledge library",
      "attach documents to AI email",
      "open source AI knowledge base",
    ],
  },

  // ──────────────────────────────── Pipelines ────────────────────────────────
  {
    slug: "pipelines",
    name: "Pipelines",
    category: "Automation",
    icon: "workflow",
    accent: "bg-purple-50 text-purple-700 ring-purple-200",
    tagline: "Automation without the improvisation.",
    taglineAccent: "Visual DAGs for the glue work that doesn't need an LLM.",
    summary:
      "n8n-style visual automation — triggers, branches, delays, and integration nodes — with an Ask-AI-employee node when a flow needs judgment.",
    seoTitle: "Pipelines — Visual automation, no LLM required · Genosyn",
    description:
      "Self-hosted visual automation: DAGs of triggers, branches, delays, and integration nodes on a canvas — webhooks, cron, and an Ask-AI-employee node.",
    intro:
      "Pipelines are deterministic glue: company-scoped DAGs of typed nodes that fire manually, on a secret-token webhook, or on cron. Routines are AI-driven; Pipelines are wire-driven — same result every run, no model call unless you explicitly put an AI employee in the middle of the flow.",
    checks: [
      "14 node types across 4 families",
      "Manual, webhook, and cron triggers",
      "21 Integrations callable as nodes",
      "Every run logged and auditable",
    ],
    features: [
      {
        icon: "mousePointer",
        title: "A canvas, not a DSL",
        body: "Drag nodes from a catalog palette, wire edges between handles, configure each node in a side panel. Data flows with {{trigger.body.name}} templates — whole-token values keep their types.",
      },
      {
        icon: "webhook",
        title: "Three ways to fire",
        body: "A manual Run-now button, incoming webhooks with unique secret URLs, or a 5-field cron schedule on a 30-second heartbeat that advances before firing, so slow runs can't double-fire.",
      },
      {
        icon: "boxes",
        title: "Write into your workspace",
        body: "Six built-in actions post a channel message, add a todo, create a project, append a Base record, ask an AI employee, or write a journal note — straight into the primitives your team already uses.",
      },
      {
        icon: "split",
        title: "Branches, delays, HTTP",
        body: "If/else branches with color-coded true/false edges, set-variable nodes, delays, and a full HTTP request node with method, headers, and body — responses auto-parse as JSON.",
      },
      {
        icon: "plug",
        title: "Call any Integration",
        body: "One node invokes any tool on any connected Integration — Stripe, Gmail, GitHub, Notion, Linear, Airtable, Postgres, Telegram, and more — with the result captured for downstream nodes.",
      },
      {
        icon: "scrollText",
        title: "Runs you can replay",
        body: "Every execution records status, which trigger fired, the payload, per-node outputs, and a step-by-step log. The Runs tab lists the last 50 and auto-refreshes while a run is in flight.",
      },
    ],
    employees: {
      heading: "Where wires meet judgment",
      body: "Pipelines and AI employees are complements, not competitors. Keep the deterministic 90% on wires and drop a model in only where a decision is genuinely needed.",
      bullets: [
        {
          title: "Ask AI employee, mid-flow",
          body: "One node sends a message to an employee and captures its reply for downstream nodes — a webhook arrives, the employee summarizes or decides, the pipeline carries on deterministically.",
        },
        {
          title: "Routines can pull the trigger",
          body: "An employee running a Routine can POST to a pipeline's webhook URL, so AI-driven work can kick off wire-driven work.",
        },
        {
          title: "Authoring stays human",
          body: "Pipelines run as the company and are built by Members in the UI — employee Grants are never bypassed by an employee-authored flow, by design.",
        },
      ],
    },
    faqs: [
      {
        q: "How are Pipelines different from Routines?",
        a: "Routines are scheduled work performed by an AI employee — a model is always in the loop. Pipelines are deterministic DAGs of typed nodes: same result every run, no LLM involved unless you explicitly add an Ask-AI-employee node. Routines are AI-driven; Pipelines are wire-driven.",
      },
      {
        q: "What can trigger a pipeline?",
        a: "Three trigger types: Manual (a Run-now button), Webhook (each node gets a unique secret URL and the POST body becomes the trigger payload), and Schedule (standard 5-field cron on a 30-second heartbeat). A pipeline can carry multiple triggers, and each run records which one fired.",
      },
      {
        q: "Can a pipeline talk to my other tools?",
        a: "Yes. The Call-integration node invokes any tool on any connected Integration — 21 are registered, including Stripe, Gmail, GitHub, Notion, Linear, Airtable, Postgres, MySQL, ClickHouse, Redis, Telegram, X, Reddit, and LinkedIn. For everything else there's a generic HTTP node.",
      },
      {
        q: "How do I debug a failed run?",
        a: "Open the Runs tab: every execution keeps its status, trigger kind, payload, per-node outputs, any error, and a step-by-step log. Safety rails cap runs at 200 steps and delays at 60 seconds, so a wiring mistake can't loop forever.",
      },
      {
        q: "Do I need to learn a DSL or write code?",
        a: "No. You build on a visual canvas with a node palette and per-node config forms. Data flows between nodes with {{trigger.body.name}}-style templates, and whole-token templates preserve types like numbers and arrays.",
      },
    ],
    docsPath: null,
    keywords: [
      "self-hosted workflow automation",
      "open source n8n alternative",
      "open source Zapier alternative",
      "visual DAG editor",
      "webhook automation self-hosted",
      "cron triggered automation",
      "AI employee automation platform",
    ],
  },

  // ───────────────────────────────── Explore ─────────────────────────────────
  {
    slug: "explore",
    name: "Explore",
    category: "Analytics",
    icon: "barChart3",
    accent: "bg-sky-50 text-sky-700 ring-sky-200",
    tagline: "Ask your database a question.",
    taglineAccent: "Charts and Dashboards your AI employees can run too.",
    summary:
      "Metabase-style BI over the Postgres, MySQL, or ClickHouse databases you already connect — SQL saved as Charts, pinned to Dashboards, runnable by AI.",
    seoTitle: "Explore — Self-hosted BI, charts & dashboards · Genosyn",
    description:
      "Self-hosted BI built into Genosyn: save SQL against Postgres, MySQL, or ClickHouse as Charts, pin them to Dashboards, and let AI employees run the numbers.",
    intro:
      "Explore is self-serve BI without another deployment: save SQL queries against the database Connections your company already has as named Charts, choose a visualization, and pin the results onto Dashboards the whole team reads at a glance. “What was MRR last month?” becomes a question any teammate — or any AI employee — can answer by running the Chart instead of improvising SQL.",
    checks: [
      "Postgres, MySQL, ClickHouse",
      "Six viz types, rendered as SVG",
      "12-column dashboard grid",
      "Same 30s / 5,000-row cap for AI",
    ],
    features: [
      {
        icon: "database",
        title: "Reuse your Connections",
        body: "Charts run against the Integration Connections you already configured — no separate BI credentials. Configs stay encrypted and are decrypted per run, with a fresh client per query.",
      },
      {
        icon: "code2",
        title: "SQL in, Chart out",
        body: "Write SQL in the editor with inline errors and a live result preview, then save it as a named Chart. Every execution runs under a 30-second timeout and a 5,000-row cap.",
      },
      {
        icon: "pieChart",
        title: "Six visualizations",
        body: "Table, scalar, bar, line, area, and pie — with a live preview of each against your current result set, configured in a side panel. All rendered as inline SVG, no chart-library dependency.",
      },
      {
        icon: "layoutDashboard",
        title: "Dashboards on a grid",
        body: "Pin Charts as cards on a drag-and-drop 12-column grid with per-card resize, and override a Chart's title per context — MRR on the finance board, Revenue (MTD) on the home one.",
      },
      {
        icon: "share2",
        title: "Share with your AI",
        body: "Charts and Dashboards default to read for every AI employee; authors get write on what they create. Humans grant, revoke, or promote from the Share menu.",
      },
      {
        icon: "shieldAlert",
        title: "Least-privilege by advice",
        body: "The executor doesn't pretend to enforce read-only — the docs tell you to connect a SELECT-only database role, so even a write-granted employee can't UPDATE your production data.",
      },
    ],
    employees: {
      heading: "An analyst on the roster",
      body: "AI employees use Explore through ten built-in tools — list, get, and run Charts; create and update them; assemble Dashboards — under the same execution envelope humans get.",
      bullets: [
        {
          title: "Find, don't improvise",
          body: "Asked for a number, an employee lists the company's Charts, finds the right one, and runs it — reusing the SQL a human already blessed instead of guessing at schema.",
        },
        {
          title: "Author new analytics",
          body: "With write grants an employee can create Charts and Dashboards the team sees — the same way it already authors Notes and Base records.",
        },
        {
          title: "Same limits as you",
          body: "Every AI query goes through the same executor: 30-second wall-clock timeout, 5,000-row cap, credentials decrypted per run and never exposed to the model.",
        },
      ],
    },
    faqs: [
      {
        q: "Which databases does Explore support?",
        a: "Postgres, MySQL, and ClickHouse today. Snowflake, BigQuery, and Redshift connectors are on the roadmap.",
      },
      {
        q: "Do I need to set up separate credentials for BI?",
        a: "No. Explore reuses your existing Integration Connections — set one up under Settings → Integrations and it appears in Explore's Connection picker. Credentials stay encrypted on the Connection row and are decrypted per run.",
      },
      {
        q: "Can AI employees run and build charts?",
        a: "Yes. Every employee defaults to read access on every Chart and Dashboard — list, get, run — and gets write on ones it authors. Humans grant or revoke per Chart or Dashboard from the Share menu.",
      },
      {
        q: "What are the query limits?",
        a: "Every execution — ad-hoc from the editor, a saved Chart, or an AI employee's run — goes through the same executor with a 30-second wall-clock timeout and a 5,000-row cap; larger result sets are truncated server-side.",
      },
      {
        q: "Is Explore read-only against my database?",
        a: "Read-only enforcement is deliberately not baked into the executor. Connect with a separate SELECT-only database user, and no query — human or AI — can write to your production data.",
      },
    ],
    docsPath: "/docs/explore",
    keywords: [
      "open source BI",
      "self-hosted BI tool",
      "Metabase alternative",
      "SQL charts and dashboards",
      "Postgres dashboard",
      "ClickHouse dashboard",
      "AI data analyst",
    ],
  },

  // ──────────────────────────────── Marketing ────────────────────────────────
  {
    slug: "marketing",
    name: "Paid Marketing",
    category: "Marketing",
    icon: "megaphone",
    accent: "bg-rose-50 text-rose-700 ring-rose-200",
    tagline: "An AI employee on your ad accounts.",
    taglineAccent: "With spending caps it cannot talk its way around.",
    summary:
      "Google, Meta, Microsoft, and Reddit ads watched daily and reported weekly — with pause/enable/budget levers gated behind per-Connection caps and human approvals.",
    seoTitle: "Paid Marketing — AI ad management with spend caps · Genosyn",
    description:
      "AI employees that monitor Google, Meta, Microsoft, and Reddit ad campaigns, report pacing and ROAS, and change budgets only through hard caps and human approvals.",
    intro:
      "Paid Marketing gives an AI employee read-first access to your ad accounts — campaign spend, pacing, GAQL and Insights reports — and a deliberately tiny set of levers: pause, enable, change a budget. Every spend increase queues in the Approvals inbox by default; pausing a runaway campaign never waits for anyone. Every authorized change lands in a SQL ledger, so what the AI spent is a query, not a guess.",
    checks: [
      "Google, Meta, Microsoft, Reddit Ads",
      "Every spend increase needs a human — by default",
      "Pause is never gated",
      "Per-change, daily & monthly hard caps",
    ],
    features: [
      {
        icon: "keyRound",
        title: "Your credentials, no middleman",
        body: "Each platform connects with credentials your company owns — a Google Ads developer token on your own MCC, a non-expiring Meta system-user token, a self-service Microsoft dev token, an instant Reddit app. No partner program, no vendor in your data path.",
      },
      {
        icon: "shieldAlert",
        title: "Caps above approvals",
        body: "Per-change, rolling 24-hour, and rolling 30-day limits on authorized budget increases, plus a kill switch — enforced on every path, so even a human approval cannot exceed a hard cap.",
      },
      {
        icon: "bell",
        title: "Approvals that reach you",
        body: "A budget raise or campaign enable queues an Approval with a before→after snapshot; owners and admins get bell, websocket, and web-push. If the campaign changed by the time you approve, the replay aborts instead of firing stale.",
      },
      {
        icon: "zap",
        title: "The emergency lever stays fast",
        body: "Spend-decreasing actions — pause a campaign, lower a budget — never wait in a queue. A runaway campaign at 2am gets paused first and explained after.",
      },
      {
        icon: "table2",
        title: "A ledger, not a log line",
        body: "Every authorized delta is a row in the AdSpendEvent table: connection, employee, campaign, signed amount, approval id. “How much did this employee authorize this month?” is SQL.",
      },
      {
        icon: "globe",
        title: "A path for the gatekept platforms",
        body: "LinkedIn, X, and TikTok gate their ads APIs behind months-long reviews — so the documented path is the built-in browser with pinned hosts, approval-gated form submits, and human take-over for logins and 2FA.",
      },
    ],
    employees: {
      heading: "A performance marketer on the roster",
      body: "The Performance Marketer template ships a Soul that treats budget discipline as the job: cite spend data for every claim, escalate anomalies instead of quietly fixing them, and never raise a budget without an approval.",
      bullets: [
        {
          title: "Daily pacing check",
          body: "A Routine reads every granted ad account each morning, judges pacing over a 7-day window (platforms legally overdeliver on single days), flags zero-delivery campaigns, and treats “couldn’t read the account” as itself an alert.",
        },
        {
          title: "ROAS against real revenue",
          body: "The weekly report joins ad spend to GA4 conversions by UTM campaign — and where you run Finance in Genosyn, to actual invoiced revenue, not the platform’s self-graded attribution.",
        },
        {
          title: "Proposals a CFO can approve",
          body: "Budget changes arrive in the Approvals inbox with current budget, proposed budget, evidence, and worst-case daily blast radius — a ten-second decision.",
        },
      ],
    },
    faqs: [
      {
        q: "Which ad platforms are supported?",
        a: "Native Integrations for Google Ads, Meta (Facebook/Instagram) Ads, Microsoft Advertising, and Reddit Ads — the four whose APIs let a self-hosting company bring its own credentials without a partner-program review. LinkedIn, X, and TikTok are served by the built-in browser tools with human-approved submits until their API access programs become tractable.",
      },
      {
        q: "Can the AI create campaigns or ads?",
        a: "Not in v1 — deliberately. The mutation surface stops at pause, enable, and budget changes, all recorded to a ledger and gated by caps and approvals. Campaign authoring earns its way in once the read-and-lever loop has proven itself on your account.",
      },
      {
        q: "What stops it from burning my budget?",
        a: "Five layers: every spend increase queues a human Approval by default; per-change, daily, and monthly hard caps run even on approved replays; a kill switch blocks all mutations per Connection; approvals snapshot before-state and abort on drift; and everything lands in the AdSpendEvent ledger. Also set the platform’s own account spending limit — the docs insist on that backstop.",
      },
      {
        q: "Do I need my own API access on each platform?",
        a: "Yes — that’s the point. Google’s auto-granted Explorer developer-token tier, Meta’s system-user tokens, Microsoft’s self-service dev token, and Reddit’s instant OAuth apps all work for a company managing its own accounts, with no human review. The docs walk through each, including the Google consent-screen trap that silently expires refresh tokens every 7 days in Testing status.",
      },
      {
        q: "What does it cost?",
        a: "Nothing beyond your model usage — the platform APIs are free, and Genosyn is open source and self-hosted. There is no per-seat ads-tool subscription and no aggregator in the middle.",
      },
    ],
    docsPath: "/docs/marketing",
    keywords: [
      "AI ads management",
      "AI marketing agent",
      "Google Ads automation",
      "Meta Ads API tool",
      "ad spend guardrails",
      "AI budget approval",
      "self-hosted ads tool",
    ],
  },

  // ───────────────────────────────── Revenue ─────────────────────────────────
  {
    slug: "revenue",
    name: "Revenue",
    category: "Operations",
    icon: "trendingUp",
    accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    tagline: "From ad click to collected cash.",
    taglineAccent: "One loop, one database, worked by AI employees.",
    summary:
      "Contacts, deals, outbound sequences, and product signals in the same database as your invoices and ledger — with timelines that fill themselves from email.",
    seoTitle: "Revenue — A CRM that reaches your ledger · Genosyn",
    description:
      "Self-hosted go-to-market inside Genosyn: deals and contacts whose timelines fill from email, AI-drafted sequences a human approves, and metrics joined to your ledger.",
    intro:
      "Revenue is the middle of the loop most stacks leave open. A CRM has no ledger, a ledger has no deals, and the product-signal tools have neither — so ad click, contact, deal, invoice, collected cash, and journal entry live in four systems that agree only when somebody reconciles them. In Genosyn they are rows in one database, worked by AI employees under a grant a human sets.",
    checks: [
      "Deals, contacts, and one timeline",
      "The timeline fills itself from email",
      "Drafts wait for a human Send",
      "read < write < send AI grants",
    ],
    features: [
      {
        icon: "layoutGrid",
        title: "Deals on a board",
        body: "Seven Deal Stages seeded from a conventional B2B ladder — New through Closed Won — as a flat ordered list you edit, each carrying a forecast probability. Moving a deal into a won or lost stage closes it and stamps the date. Pipeline is the word Genosyn reserves for its DAG automation, so here it is stages and a board.",
      },
      {
        icon: "history",
        title: "The timeline fills itself",
        body: "Mail sync matches thread participants against known Contacts and writes each message onto the timeline as it lands, so opening a contact shows every conversation you have ever had without anyone logging a thing. It links only to contacts that already exist — a mailbox is mostly newsletters and receipts, and auto-creating from strangers would bury the list in a week.",
      },
      {
        icon: "mailPlus",
        title: "Sequences drafted, not merged",
        body: "A Sequence names an AI employee and a standing brief instead of storing message bodies: every touch is written for that contact from their real context — prior threads, the open deal, the signal that enrolled them. Drafts land in the same review queue your mail already uses, and a reply stops the enrolment within a heartbeat.",
      },
      {
        icon: "shieldCheck",
        title: "Deliverability before volume",
        body: "Suppression is enforced at the single outbound choke-point every send path shares, re-checked at send rather than at draft time. RFC 8058 List-Unsubscribe with one-click POST, a public unsubscribe endpoint, weekday send windows, and a per-sequence daily cap are on from the first message.",
      },
      {
        icon: "zap",
        title: "Signals over your own database",
        body: "A saved query against a connected Postgres, MySQL, ClickHouse, or Stripe account, evaluated on cron and deduplicated so an account triggers once instead of every tick. A firing logs an activity, sends a notification, opens a Deal, enrols a Sequence, or wakes an AI employee with the payload.",
      },
      {
        icon: "barChart3",
        title: "Metrics that reach the ledger",
        body: "MRR movement — new, expansion, contraction, churn, reactivation — with ARR, NRR and GRR cohorts, win rate, sales-cycle length, stage conversion, pipeline coverage, CAC by channel, LTV:CAC and payback. The arithmetic is pure and property-tested, and collected cash comes from recorded invoice payments rather than from a deal marked won.",
      },
    ],
    employees: {
      heading: "Inside what a human authorized",
      body: "Revenue is one company-wide Grant per employee at read, write, or send — the same shape Finance uses. An employee with no grant gets no revenue tools at all, and the level it does hold is written into its prompt in plain English, so it knows where the line is before it reaches one.",
      bullets: [
        {
          title: "Three levels, one row",
          body: "read lists and opens contacts, deals, timelines, sequences, signals, and reports. write creates and updates them, moves a deal between stages, logs activities, and enrols contacts. send is the only level that can put mail on the wire unattended.",
        },
        {
          title: "Unattended send needs two keys",
          body: "A sequence marked auto-send requires the employee's revenue grant at send and its grant on that mailbox at send. Suppression, the send window, and the daily cap apply either way — auto-send bypasses none of them.",
        },
        {
          title: "Attributed, then auditable",
          body: "Every AI write is recorded against the employee's name in the audit log, and the timeline shows whether a Member or an AI employee logged each event. A contact or a deal can be owned by either.",
        },
      ],
    },
    faqs: [
      {
        q: "How is this different from bolting a CRM onto our stack?",
        a: "The chain is unbroken. The Contact, the Deal, the invoice it becomes, the payment recorded against that invoice, and the journal entry that posts are rows in one database with one permission model and one audit trail — no nightly sync, no integration to reconcile. A Contact is a person and can exist long before there is an account to attach them to; a Customer is the billable account an invoice is addressed to.",
      },
      {
        q: "How does the timeline fill itself, and what does it deliberately not do?",
        a: "Mail sync links each mirrored message to Contacts that already exist and writes an inbound or outbound activity, so a contact page shows the whole conversation history with nobody doing data entry. It never creates a Contact from an unknown address, and idempotency is keyed on the message, so re-syncing a mailbox never doubles a thread. Creating a contact stays an explicit act — a human, an import, or a Signal.",
      },
      {
        q: "Can an AI employee send outbound email without me?",
        a: "Not by default. Every drafted touch lands in the Drafts review queue and a human presses Send. Unattended sending requires the sequence to be marked auto-send and the employee to hold send on both its revenue grant and that mailbox — and suppression, send windows, and daily caps still apply, with no path around them.",
      },
      {
        q: "What exactly is a Signal?",
        a: "A saved query over a connected product database or Stripe, plus a rule for what to do with the rows it returns, evaluated on a standard 5-field cron. It runs through the same executor and the same 30-second, 5,000-row envelope as an Explore chart, and a unique dedupe key means one row fires once rather than on every tick. Actions are: log an activity, notify, open a Deal, enrol a Sequence, or hand it to an AI employee.",
      },
      {
        q: "Where do the CAC numbers come from?",
        a: "Spend is grouped by platform from the ad-spend ledger Paid Marketing writes, and wins are counted per deal source over the same period, with unattributed spend and wins kept as their own row rather than dropped. That ledger records authorized budget changes rather than settled platform spend, so CAC today is a documented proxy — reading real spend back from the ad platforms is the next step. The other side of the ratio is exact: collected revenue sums recorded invoice payments.",
      },
    ],
    docsPath: "/docs/revenue",
    keywords: [
      "AI-native CRM",
      "self-hosted sales CRM",
      "sales pipeline software self-hosted",
      "AI drafted outbound sequences",
      "product qualified lead signals",
      "MRR NRR and churn reporting",
      "CAC LTV and payback tracking",
    ],
  },

  // ────────────────────────────────── Email ──────────────────────────────────
  {
    slug: "email",
    name: "Email",
    category: "Operations",
    icon: "mail",
    accent: "bg-cyan-50 text-cyan-700 ring-cyan-200",
    tagline: "Your inbox, with staff.",
    taglineAccent: "An agentic Gmail client where AI triages, drafts, and earns send.",
    summary:
      "A real mail client over your Gmail mailbox — two-way sync, rules, and hand-to-AI flows gated by read < draft < send access levels.",
    seoTitle: "Email — An agentic Gmail client · Genosyn",
    description:
      "Work your Gmail inbox inside Genosyn: two-way sync, full-text search, rules, and AI employees that triage and draft replies — humans keep the Send button.",
    intro:
      "Email is a real mail client backed by your Gmail mailbox: Genosyn imports the whole mailbox into a local index, keeps it in two-way sync, and gives you folders, labels, search, and compose. What it really replaces is the copy-paste loop between your inbox and an AI chat — employees are granted directly on the mailbox, so a support email can be triaged and answered with a draft the moment it arrives.",
    checks: [
      "Two-way Gmail sync, ~1 min fresh",
      "No Pub/Sub or extra infra",
      "read < draft < send AI levels",
      "Every AI action audited",
    ],
    features: [
      {
        icon: "refreshCw",
        title: "Sync that never drifts",
        body: "First sync imports the entire mailbox newest-first and resumes in the background; after that, 30-second incremental polling. Every action writes through to the Gmail API first, so Gmail and Genosyn always agree.",
      },
      {
        icon: "inbox",
        title: "A full mail client",
        body: "Folder and label sidebar with unread counts, compose, reply, reply-all, forward, attachments in and out, and drafts — including AI-written drafts you edit and send.",
      },
      {
        icon: "search",
        title: "Search the whole mailbox",
        body: "Full-text search over subjects, participants, and complete message bodies, with structured filters — from, to, date range, label, unread, has-attachment.",
      },
      {
        icon: "handshake",
        title: "Hand a thread to AI",
        body: "Pick a granted employee, give an instruction, choose a mode — draft a reply, reply directly, or triage. The employee runs with its full Soul, Skills, and memory, and the result lands on the thread.",
      },
      {
        icon: "filter",
        title: "Rules on inbound mail",
        body: "Conditions on from, to, subject, body, or attachments trigger actions: label, mark read, star, archive, or hand the thread to an AI employee. Rules never fire on backfill or your own sent mail.",
      },
      {
        icon: "shieldCheck",
        title: "Levels, not trust falls",
        body: "Per-employee, per-mailbox access at read, draft, or send — draft is the default, so AI leaves a finished reply and a human presses Send. The levels also bind the Gmail integration tools: no side doors.",
      },
    ],
    employees: {
      heading: "AI on customer email, safely",
      body: "Granted employees work the mailbox through a built-in mail tool family — search, read threads, draft, triage, send — and reach it three ways: a human hands over a thread, a Rule fires on inbound mail, or a Routine runs on schedule.",
      bullets: [
        {
          title: "Draft is the sweet spot",
          body: "The default grant lets an employee triage the inbox and leave a finished Gmail draft on the thread while a human reviews and presses Send. Send is earned, explicitly.",
        },
        {
          title: "Automate the first response",
          body: "One rule — to contains support@, action hand-to-AI in draft mode — and every support email arrives pre-triaged with a draft reply attached.",
        },
        {
          title: "Scheduled inbox work",
          body: "A Routine can search, read, and draft through the same tools — a morning digest of what landed overnight takes no new machinery.",
        },
      ],
    },
    faqs: [
      {
        q: "Do I need Google Cloud Pub/Sub or extra infrastructure?",
        a: "No. Sync is poll-based on a 30-second heartbeat, so new mail shows up within about a minute with nothing to set up beyond the Google OAuth client you already registered.",
      },
      {
        q: "Can an AI employee send email without my approval?",
        a: "Only if you explicitly grant the send level. The default is draft: the employee can triage and write a reply as a Gmail draft, but a human reviews and presses Send. The levels bind every route to the mailbox — including the Gmail integration tools.",
      },
      {
        q: "Will connecting an old mailbox stampede my rules?",
        a: "No. Connecting a mailbox imports history quietly; rules only run on genuinely new mail after that, and never on drafts or your own sent messages.",
      },
      {
        q: "Is this the same email Genosyn uses for password resets and invoices?",
        a: "No. This is your company's real inbox — a separate subsystem that syncs with Gmail. Transactional email (SMTP, SendGrid, Mailgun, Resend, Postmark) is configured separately and the two never collide.",
      },
      {
        q: "What happens if I disconnect a mailbox?",
        a: "Genosyn deletes its local mirror, rules, AI handovers, and grants for that mailbox. Your Gmail account and the underlying Google Connection are never touched.",
      },
    ],
    docsPath: "/docs/email",
    keywords: [
      "AI email assistant",
      "agentic Gmail client",
      "AI inbox triage",
      "AI draft email replies",
      "email rules automation",
      "shared inbox with AI",
      "open source AI email agent",
    ],
  },

  // ──────────────────────────────── Customers ────────────────────────────────
  {
    slug: "customers",
    name: "Customers",
    category: "Operations",
    icon: "building2",
    accent: "bg-orange-50 text-orange-700 ring-orange-200",
    tagline: "Know every account cold.",
    taglineAccent: "Contacts, contract value, signed documents, and statements.",
    summary:
      "A lightweight CRM wired into your books — accounts, contacts, ACV, uploaded contracts, and on-the-fly statements with aging.",
    seoTitle: "Customers — A CRM wired into your books · Genosyn",
    description:
      "Self-hosted CRM built into Genosyn: accounts with contacts and ACV, signed contract uploads, and per-customer statements with AR aging, in sync with invoices.",
    intro:
      "Customers is the account layer behind every invoice and estimate: who you sell to, what each account is worth, who to call there, and where the signed MSA lives. Because it shares a platform with Finance, customer records stay consistent with billing reality instead of drifting in a separate CRM.",
    checks: [
      "Accounts, contacts, and ACV",
      "Contract uploads to 25 MB",
      "Statements with 5-bucket aging",
      "PDF and print-ready output",
    ],
    features: [
      {
        icon: "building2",
        title: "Accounts built for billing",
        body: "Name, billing email, phone, tax ID, default currency, and addresses — the record that appears on every invoice. Each account's slug prefixes its document numbers: ACME-CORP-INV-0001.",
      },
      {
        icon: "contactRound",
        title: "The people at the account",
        body: "Any number of contacts per customer — name, role, email, phone — with one markable as primary, managed inline on the customer page.",
      },
      {
        icon: "trendingUp",
        title: "ACV as a first-class column",
        body: "Track Annual Contract Value per account in its default currency as an independent sales metric — editing it never touches issued invoices.",
      },
      {
        icon: "fileSignature",
        title: "Contracts where you look",
        body: "Upload signed MSAs, order forms, and NDAs — PDF, image, or document up to 25 MB — browsable globally or per customer, stored on your own server.",
      },
      {
        icon: "receipt",
        title: "Statements on demand",
        body: "Every issued invoice as a charge, every payment as a credit, in date order with opening balance, running balance, and balance due — derived live, so there's no second ledger to drift.",
      },
      {
        icon: "clock",
        title: "Aging at a glance",
        body: "Outstanding balance bucketed into current, 1–30, 31–60, 61–90, and 90+ days past due, filterable by period and switchable per currency — never summed across currencies.",
      },
    ],
    employees: {
      heading: "Wired into the same platform your AI works",
      body: "Customer data flows straight into Finance — invoices, estimates, payments, exports — on the platform your AI employees already operate, with one permission model and one audit trail.",
      bullets: [
        {
          title: "Overviews with an action queue",
          body: "Each account page shows headline numbers — ACV, outstanding balance, lifetime billed — plus a queue of overdue invoices and estimates awaiting response, deep-linked into Finance.",
        },
        {
          title: "PDFs from the same pipeline",
          body: "Statements render server-side through headless Chromium — the same rendering path invoices use and the same artifact machinery AI employees hand you PDFs with.",
        },
        {
          title: "Stripe-side visibility today",
          body: "An employee granted a Stripe Connection can already browse the Stripe-side customer catalog read-only; native customer tools for AI employees are on the roadmap, gated by approvals.",
        },
      ],
    },
    faqs: [
      {
        q: "What's the difference between a customer, a contact, and a contract?",
        a: "A Customer is the billable account — the company name, billing email, tax ID, and currency that appear on invoices. A contact is a person at that account, one of which can be primary. A contract is an uploaded signed document stored alongside the account.",
      },
      {
        q: "What does a customer statement include?",
        a: "Every issued invoice as a charge and every recorded payment as a credit in date order, with an opening balance, running balance, and balance due, plus an aging summary across five buckets. Drafts and voided invoices are excluded. View it in-app, print it, or download the PDF.",
      },
      {
        q: "Can I delete a customer?",
        a: "Customers with invoices can't be deleted — archive them instead. Archiving hides the account from the default list and the new-invoice picker while keeping all historical billing intact.",
      },
      {
        q: "How does Annual Contract Value work?",
        a: "ACV is a headline revenue figure you enter per account — expected yearly revenue in the account's default currency, shown as its own column in the customer list. It's fully independent of invoicing.",
      },
      {
        q: "How do statements handle multiple currencies?",
        a: "Statements are strictly per-currency. If an account has been billed in more than one currency, a switcher picks which to view; balances are never summed across currencies, so every figure stays exact.",
      },
    ],
    docsPath: "/docs/customers",
    keywords: [
      "open source CRM",
      "self-hosted CRM",
      "annual contract value tracking",
      "customer statement of account",
      "AR aging report",
      "contract management software",
      "CRM with invoicing built in",
    ],
  },

  // ───────────────────────────────── Finance ─────────────────────────────────
  {
    slug: "finance",
    name: "Finance",
    category: "Operations",
    icon: "landmark",
    accent: "bg-teal-50 text-teal-700 ring-teal-200",
    tagline: "Books that live where the work happens.",
    taglineAccent: "Invoices, bills, and a real double-entry ledger.",
    summary:
      "Estimates, invoices, recurring billing, bills and vendors, a double-entry general ledger, reports, reconciliation, and period close — native.",
    seoTitle: "Finance — Invoicing & double-entry ledger · Genosyn",
    description:
      "Self-hosted accounting built into Genosyn: estimates, invoices, recurring billing, bills, a double-entry ledger, reports, reconciliation, and period close.",
    intro:
      "Finance is a full accounting suite inside your company's platform: quote to invoice to payment to close, on a real double-entry general ledger. It replaces the invoicing-SaaS-plus-QuickBooks stack for companies that want their books to live where their work — and their AI workforce — already happens.",
    checks: [
      "Real double-entry ledger",
      "Gapless, customer-prefixed numbering",
      "P&L, balance sheet, cash flow",
      "Money as integer minor units",
    ],
    features: [
      {
        icon: "fileText",
        title: "Quote to cash",
        body: "Estimates with a full lifecycle convert to invoices in one click — every line copied, the invoice issued, the journal entry posted. Line items carry per-line inclusive or exclusive tax.",
      },
      {
        icon: "repeat",
        title: "Recurring billing",
        body: "Schedules fire every N days, weeks, months, quarters, or years with a plain-English preview. Draft-per-tick by default, or auto-issue and email the PDF through your configured provider.",
      },
      {
        icon: "bookOpenCheck",
        title: "A ledger, not a report",
        body: "Chart of accounts seeded with ten system accounts, balance enforcement at the service layer, manual journal entries, and a trial balance. Document lifecycles auto-post; voiding reverses every entry.",
      },
      {
        icon: "barChart3",
        title: "The three reports",
        body: "P&L, balance sheet, and cash flow with period filters, prior-period comparison columns, and drill-through from any account row to its source entries.",
      },
      {
        icon: "landmark",
        title: "Bills and reconciliation",
        body: "Vendors and bills mirror the receivable side with auto-posting and FX gain/loss. Reconcile against Stripe payouts or CSV imports with auto-match heuristics and a manual matching UI.",
      },
      {
        icon: "lock",
        title: "Close the period",
        body: "Accounting periods lock with a closing entry into Retained Earnings; the ledger refuses writes inside closed periods. Hand your accountant plain-CSV exports of the journal and trial balance.",
      },
    ],
    employees: {
      heading: "The same books your AI can reach",
      body: "Finance is not a silo behind a third-party API — it shares one platform, one permission model, and one audit trail with your AI employees.",
      bullets: [
        {
          title: "API-first surface",
          body: "The entire Finance surface is reachable through the company REST API with scoped API keys — scriptable from CI, external tools, or agent code.",
        },
        {
          title: "Browser-driven today",
          body: "Browser-enabled AI employees can drive the Finance UI directly through the built-in browser tools, with approval-gated form submits.",
        },
        {
          title: "Native tools, gated, next",
          body: "A dedicated finance tool surface for employees is on the roadmap — read-only tools first, money-moving actions behind the approval-by-amount pattern already used for Lightning payments.",
        },
      ],
    },
    faqs: [
      {
        q: "Is this real double-entry accounting or invoicing with a report bolted on?",
        a: "Real double-entry. Every ledger entry balances (enforced at the service layer); there's a seeded chart of accounts, manual journal entries, a trial balance, and P&L, balance sheet, and cash flow reports with prior-period comparisons. Invoice and bill lifecycles auto-post into the same ledger.",
      },
      {
        q: "Do I still need QuickBooks or Xero?",
        a: "Genosyn Finance covers quote to close natively: estimates, invoices, recurring billing, bills and vendors, ledger, reports, Stripe and CSV reconciliation, multi-currency FX gain/loss, and period close. For accountant hand-off it ships plain-CSV exports of customers, invoices, the general journal, and the trial balance.",
      },
      {
        q: "How does invoice numbering work?",
        a: "Numbers are gapless per-company sequences minted at issue, prefixed with the customer's slug — ACME-CORP-INV-0001 — so they stay unique, self-identify across accounts, and satisfy compliance. Drafts stay unnumbered until issued.",
      },
      {
        q: "Can invoices go out automatically?",
        a: "Yes. Recurring schedules can auto-issue: each tick mints the number, posts the ledger entry, and emails the customer a rendered PDF through your configured email provider — the same path a human-sent invoice takes.",
      },
      {
        q: "How is money stored?",
        a: "As integer minor units (cents) plus a 3-letter ISO currency code on every row — no floating-point currency anywhere. Catalog products and tax rates are snapshotted onto line items, so editing a product never rewrites history.",
      },
    ],
    docsPath: "/docs/finance",
    keywords: [
      "open source invoicing software",
      "self-hosted accounting software",
      "double-entry general ledger",
      "open source QuickBooks alternative",
      "recurring invoices",
      "bank reconciliation Stripe",
      "trial balance P&L balance sheet",
    ],
  },

  // ─────────────────────────────────── Code ──────────────────────────────────
  {
    slug: "code",
    name: "Code Repositories",
    category: "Engineering",
    icon: "gitBranch",
    accent: "bg-zinc-100 text-zinc-700 ring-zinc-200",
    tagline: "Give your AI a real checkout.",
    taglineAccent: "Any git repo, per-employee grants, ordinary git.",
    summary:
      "Point at any git URL — GitHub, GitLab, Bitbucket, self-hosted — and grant chosen AI employees a live checkout with read or read-and-push rights.",
    seoTitle: "Code Repositories — Git access for AI · Genosyn",
    description:
      "Give AI employees real git checkouts of any repo — GitHub, GitLab, Bitbucket, or self-hosted — with per-employee read/push grants and encrypted credentials.",
    intro:
      "Code Repositories make any git repo a first-class resource your AI employees can actually work on — not read through an API. Every granted employee gets a live checkout with credentials and committer identity pre-wired, so AI ships code the way human engineers do: branches, commits, and pushes your existing review pipeline already understands.",
    checks: [
      "Any HTTPS or SSH clone URL",
      "Read-only or read-and-push, per employee",
      "Credentials AES-256-GCM encrypted",
      "Work survives between Runs",
    ],
    features: [
      {
        icon: "gitBranch",
        title: "Provider-agnostic",
        body: "GitHub, GitLab, Bitbucket, Gitea, or any self-hosted server — register a clone URL over HTTPS or SSH. Distinct from the GitHub Integration, which drives issues and PRs via API; use both together.",
      },
      {
        icon: "keyRound",
        title: "Grants with teeth",
        body: "Access is opt-in per employee at two levels. Read-and-push is the default; read-only disables the push URL on the checkout so a stray git push fails immediately, naming the missing grant.",
      },
      {
        icon: "shieldCheck",
        title: "Credentials handled right",
        body: "Tokens and SSH keys encrypt at rest with AES-256-GCM. HTTPS tokens ride an env var and a credential helper — never on disk; SSH keys are written 0600 and pinned, without touching the operator's ~/.ssh.",
      },
      {
        icon: "folderGit2",
        title: "Checkouts that persist",
        body: "Repos materialize into the employee's workspace before every chat and Routine Run, then only fetch between runs — never hard-reset. The branch an employee pushed yesterday is still there today.",
      },
      {
        icon: "terminal",
        title: "Ordinary git",
        body: "No special git API. Employees use their built-in coding tools: checkout a branch, edit files, commit, push. Committer identity stamps AI commits, falling back to the employee's name.",
      },
      {
        icon: "activity",
        title: "Tested before trusted",
        body: "Test connection probes credentials with git ls-remote, auto-detects the default branch, and surfaces a health badge per repo — before you grant anyone access.",
      },
    ],
    employees: {
      heading: "AI engineers on your pipeline",
      body: "Granted employees see a prompt-injected list of their repos, checkout paths, default branches, and push rights, plus a tool to enumerate them anytime. From there it's just engineering.",
      bullets: [
        {
          title: "Branch, commit, push",
          body: "Work lands as branches and commits your review pipeline already understands — PRs, CI, and code review apply to AI work exactly as they do to human work.",
        },
        {
          title: "No racing checkouts",
          body: "A per-employee, per-repo mutex stops concurrent runs from racing on the same working tree, and fetch-only refreshes preserve work in progress.",
        },
        {
          title: "Identity you choose",
          body: "Optional per-repo committer identity stamps the employee's commits — or it falls back to the employee's name and a derived noreply address.",
        },
      ],
    },
    faqs: [
      {
        q: "Does this only work with GitHub?",
        a: "No. A Code Repository is provider-agnostic: point it at any HTTPS or SSH clone URL — GitHub, GitLab, Bitbucket, or a self-hosted server like Gitea. It's distinct from the GitHub Integration, which calls the GitHub API for issues and PRs; you can use both together.",
      },
      {
        q: "Can I control which AI employees can touch a repo?",
        a: "Yes — access is opt-in per employee. Adding a repository exposes it to no one until you add employees and pick a level: read-and-push (the default) or read-only, where the push URL on the checkout is disabled so an accidental push fails fast.",
      },
      {
        q: "How are my tokens and SSH keys stored?",
        a: "Encrypted at rest with AES-256-GCM — the same protection as model API keys — and never shown back in plaintext. HTTPS tokens are handed to git at run time via an environment variable and a credential helper, so they never land on disk.",
      },
      {
        q: "Will an employee's in-progress work get wiped between runs?",
        a: "No. Existing checkouts are only fetched between runs, never hard-reset, and a per-employee, per-repo mutex stops concurrent runs racing on the same checkout. A branch pushed in one Run is still there the next time the employee starts.",
      },
      {
        q: "What happens if I delete a repository in Genosyn?",
        a: "Deleting revokes every employee grant; the remote repository itself is never touched.",
      },
    ],
    docsPath: "/docs/code",
    keywords: [
      "AI coding agent git access",
      "give AI agent access to git repo",
      "AI employee commit and push code",
      "self-hosted AI software engineer",
      "per-agent repository permissions",
      "read-only git access for AI agents",
      "autonomous coding agent git workflow",
    ],
  },
];

export const PRODUCT_CATEGORIES: string[] = [
  "The core",
  "Essentials",
  "Knowledge",
  "Automation",
  "Analytics",
  "Operations",
  "Engineering",
];

export function findProduct(slug: string): ProductDef | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}
