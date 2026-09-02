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
  /** Two-tone H1: `tagline` in slate-950, `taglineAccent` in slate-500. */
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
    accent: "bg-zinc-100 text-zinc-900 ring-zinc-300",
    tagline: "Your AI Employees start work at 06:00 without you.",
    taglineAccent: "Each one runs on a schedule you picked, not one you wrote.",
    summary:
      "Teammates that carry a markdown Soul and work Routines on a schedule you pick, with every Run transcribed and costed.",
    seoTitle: "AI Employees: a Soul, Skills, and a schedule · Genosyn",
    description:
      "An AI Employee holds a markdown Soul, named Skills, and Routines on a schedule you pick from a control. It runs on Claude, GPT, or Ollama, and every Run keeps its transcript.",
    intro:
      "An AI Employee carries a Soul you edit like a job description and Skills written as markdown playbooks. Its Routines fire on a schedule you pick — every weekday at six, and nobody presses anything — with the next few run times shown before you save. Every Run streams its transcript live and keeps it afterwards, down to the last tool call and what the tokens cost.",
    checks: [
      "14 role templates or start blank",
      "Works unattended, on schedule",
      "Claude, GPT, or a custom endpoint",
      "Every Run fully transcribed",
    ],
    features: [
      {
        icon: "bookHeart",
        title: "One markdown Soul per employee, with live preview",
        body: "The Soul is one markdown constitution per employee: identity, voice, decision rules, refusals. Edit it in-app with live preview and you change how the employee thinks, the way you would rewrite a job description.",
      },
      {
        icon: "sparkles",
        title: "Skills load into context on every Run",
        body: "Named markdown playbooks carry a trigger, inputs, steps, and a definition of done. Every Run surfaces the relevant ones into the model's context, and your team browses and reuses them from the company-wide library.",
      },
      {
        icon: "calendarClock",
        title: "Pick a schedule, see when it will actually run",
        body: "A Routine pairs a markdown brief with a schedule you build from a control — hourly, weekdays, the 15th of the month — and it shows you the next few fire times before you save. Cron is still what gets stored, and still there to hand-write when you need it. Per-routine timeouts, enable/disable toggles, an optional approval gate, and one-click Run now.",
      },
      {
        icon: "brainCircuit",
        title: "Point an employee at Ollama, vLLM, or Claude",
        body: "Register Anthropic, OpenAI, or any OpenAI-compatible endpoint, including Ollama, vLLM, llama.cpp and LM Studio. Keep several models per employee, then pin a Routine to a cheap local one while chat stays on the frontier brain.",
      },
      {
        icon: "scrollText",
        title: "Every Run keeps its transcript and its cost",
        body: "Every Run streams its full transcript live over WebSocket and keeps it afterwards. Failures retry in one click. Usage and cost roll up per employee and per Routine.",
      },
      {
        icon: "shieldCheck",
        title: "Gated Routines and payments wait for a human checkmark",
        body: "Grants are per employee across Connections, Repositories, notes, Bases and mailboxes. Sensitive actions wait for a human checkmark, whether that is a gated Routine, a browser form submit, or a payment over your cap.",
      },
    ],
    employees: {
      heading: "Genosyn runs the model loop in process",
      body: "Genosyn owns the model loop and tool registry. API-key and custom models run in-process; eligible OpenAI subscription models use the official Codex app-server on a trusted single-tenant install. Docker runs isolated coding with bubblewrap by default, subscription Runs included, and falls back to coding-free Runs where Linux namespaces are unavailable. Each turn carries the Soul and relevant Skills, while explicit Grants decide what the employee can reach.",
      bullets: [
        {
          title: "Tools match the deployment",
          body: "Coding tools are on by default, and only ever behind bubblewrap's Linux namespaces — a host that cannot isolate a shell gets none. Separately acknowledged trusted host mode adds path-confined file helpers instead. Opt-in browser tools drive a headless Chromium with a host allow-list and human take-over for captchas.",
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
        a: "No. It is a persistent teammate attached to your company with a Soul (constitution), Skills (playbooks), Routines (cron-scheduled work), its own AI Models, a sandboxed working directory on disk, and explicit Grants to company resources. Every scheduled or manual piece of work is recorded as a Run with a full transcript.",
      },
      {
        q: "Which models can an employee run on?",
        a: "Anthropic (Claude), OpenAI (GPT), or Custom — any OpenAI-compatible endpoint such as Ollama, vLLM, llama.cpp, LM Studio, or a gateway. Trusted single-tenant deployments can also connect OpenAI through a ChatGPT subscription; the Docker default runs it with bubblewrap-isolated coding, or without coding tools where Linux namespaces are unavailable. An employee can hold several models with exactly one active, and individual Routines can pin a specific model.",
      },
      {
        q: "Where do model credentials live?",
        a: "API keys, custom-endpoint credentials, and OpenAI subscription credentials are encrypted with AES-256-GCM on the AIModel row in your database. The supported subscription path materializes managed session state only inside a locked temporary directory for a login or Run, then removes it.",
      },
      {
        q: "Can an AI Employee take an action I haven't approved?",
        a: "Not if you gate it. Flip approval-required on a Routine and the run blocks on a human checkmark; browser form submits can require approval per employee; guarded MCP tools and spend-increasing ad-platform changes queue for approval automatically. An Approvals inbox surfaces everything waiting.",
      },
      {
        q: "Do I need to install a provider CLI or wrapper per model?",
        a: "No generic provider CLI is required. API-key and custom models run through Genosyn's in-process loop. The eligible OpenAI subscription path is the narrow exception: Genosyn manages the official pinned Codex app-server and its temporary session boundary for you.",
      },
    ],
    docsPath: "/docs/employees",
    keywords: [
      "AI Employees",
      "hire AI Employees",
      "autonomous AI agents for business",
      "self-hosted AI agents",
      "open source AI Employee platform",
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
    tagline: "An @mention pulls an AI Employee into #month-end.",
    taglineAccent: "It reads the last 20 messages, then answers in place.",
    summary:
      "Channels, DMs, and 25 MB file uploads where AI Employees are members you can @mention.",
    seoTitle: "Workspace: channels, DMs, and AI Employees · Genosyn",
    description:
      "Self-hosted channels and DMs where AI Employees are members. @mention one and it reads the last 20 messages, then replies in place. 25 MB uploads.",
    intro:
      "Workspace is public and private channels, 1:1 DMs, reactions, and 25 MB file uploads, self-hosted beside everything else your company runs. AI Employees sit in the member directory with everyone else. Type @finance in #month-end and the employee joins, reads the last 20 messages, and answers in the channel while a typing pill shows it working.",
    checks: [
      "Channels, DMs, threads-ready replies",
      "Realtime over one WebSocket hub",
      "25 MB file uploads, stored on disk",
      "AI Employees read shared files",
    ],
    features: [
      {
        icon: "hash",
        title: "Public channels, private channels, and one DM per pair",
        body: "Public and private channels carry topics and an archive, while DMs stay 1:1 between any two members, human or AI, with idempotent pairing that always lands the same pair in the same conversation.",
      },
      {
        icon: "atSign",
        title: "An @mention adds the employee to the channel",
        body: "Mention an AI Employee by slug and it is auto-invited to the channel, then replies in place with the channel's recent history as context. In a DM it answers every message, no tag needed.",
      },
      {
        icon: "zap",
        title: "One WebSocket hub carries edits, reactions, and typing",
        body: "Messages, edits, deletes, reactions, presence and typing indicators all fan out live over an in-process WebSocket hub. That includes the “is typing…” pill you see while an AI Employee thinks.",
      },
      {
        icon: "paperclip",
        title: "30,000 characters of a dropped PDF reach the employee",
        body: "Upload up to 25 MB per file, and images render inline. Extraction covers txt, md, csv, json, html and PDF, inlining the text into the employee's context so “summarize this” just works.",
      },
      {
        icon: "megaphone",
        title: "A Routine posts the standup into #general at 09:00",
        body: "Built-in tools let a Routine post into a channel or DM a human, so standups, status updates and handoffs land where the team already looks, on schedule.",
      },
      {
        icon: "listChecks",
        title: "Mentions reach your phone over Web Push",
        body: "Unread badges, read markers, and a sidebar sorted by activity. Mentions land in the bell feed. From there Web Push carries them to your phone through the PWA.",
      },
    ],
    employees: {
      heading: "Employees hold the chat tools without a Grant",
      body: "AI Employees appear in the member directory and channel lists like anyone else. Chat is part of every employee's built-in tool surface — no Grant setup needed — with guardrails that keep it civilized.",
      bullets: [
        {
          title: "Reply like a teammate",
          body: "A mentioned employee reads the channel's last 20 messages plus any attached files, then answers in-channel while a typing pill shows it is working.",
        },
        {
          title: "Drive the chat themselves",
          body: "Built-in tools let employees list, create, rename, and archive channels, and send messages to channels, humans, or other AI Employees — so Routines file their own reports.",
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
        q: "How do AI Employees participate in chat?",
        a: "@mention an AI Employee by its slug and it joins the channel and replies like a teammate; DM one and it answers every message without needing a tag. Employees can also post proactively — Routines can call the built-in send_workspace_message tool to file standups or status updates into a channel.",
      },
      {
        q: "Can an AI Employee read the files I drop into a channel?",
        a: "Yes — text-like attachments (txt, md, csv, json, yaml, html, and PDFs) are extracted and inlined into the employee's prompt, capped at 30,000 characters per file. Images and other binaries are announced by name.",
      },
      {
        q: "What are the file upload limits?",
        a: "25 MB per file. Bytes live on disk under your data directory, so large files never bloat the database — one reason the whole platform runs happily on SQLite.",
      },
      {
        q: "Does it support threads?",
        a: "Replies carry a parent message, and AI Employees can already reply threaded through the messaging tool. A dedicated split-panel thread UI is on the roadmap; today replies render inline.",
      },
    ],
    docsPath: "/docs/workspace-chat",
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
    tagline: "ENG-42 belongs to a human or an AI Employee.",
    taglineAccent: "Finished AI work stops at in_review until a human signs it off.",
    summary:
      "A task manager where any todo goes to a human or an AI Employee, and AI work stops at in_review until you sign it off.",
    seoTitle: "Tasks: one board for humans and AI Employees · Genosyn",
    description:
      "Self-hosted Projects mint IDs like ENG-42 on one board humans and AI Employees share. AI work stops at in_review until a named reviewer signs it off.",
    intro:
      "Tasks is the task manager built into Genosyn. A Project takes a key of up to six characters and mints todos like ENG-42, which move through six statuses across a board you drag. Humans and AI Employees work that same board under the same access rules, so an employee that finishes something marks it in_review and it waits in your queue.",
    checks: [
      "Kanban board and list views",
      "Assign todos to humans or AI",
      "in_review flow with a reviewer queue",
      "Recurring todos, daily to yearly",
    ],
    features: [
      {
        icon: "layoutGrid",
        title: "A project key mints todos like ENG-42",
        body: "Group work into Projects, where a 1–6 character key mints IDs like ENG-42. Six statuses run backlog to done, with five priorities, due dates, and a board or list view of everything.",
      },
      {
        icon: "userCheck",
        title: "Name a reviewer and work stops at in_review",
        body: "A todo with a named reviewer moves to in_review instead of done. The reviewer gets a notification, web push included, and a cross-project Review queue collects everything waiting on you.",
      },
      {
        icon: "gitFork",
        title: "A parent todo shows a 2/5 progress chip",
        body: "Break a todo into subtasks that are real todos, each with its own status, assignee, and discussion. The parent shows a progress bar and a 2/5 chip. An AI Employee can do the breaking down for you.",
      },
      {
        icon: "repeat",
        title: "Completing one occurrence schedules the next, daily to yearly",
        body: "Complete one occurrence and the next schedules itself: daily, weekdays, weekly, biweekly, monthly or yearly. It is the human checklist that sits beside AI Routines.",
      },
      {
        icon: "lock",
        title: "An unlisted employee never sees a restricted Project",
        body: "Projects are open by default. Restrict one and only the people and AI Employees you name get in, at view-only or can-edit. That rule binds the UI and the AI tool surface identically, with no side doors.",
      },
      {
        icon: "messagesSquare",
        title: "Mention an AI Employee inside a todo's comment thread",
        body: "Every todo carries a comment thread. Mention an AI Employee there and it reads the todo and the whole thread before replying inline with what it found or fixed.",
      },
    ],
    employees: {
      heading: "An employee only sees Projects it was added to",
      body: "Through built-in tools, employees list and create Projects and todos under exactly the access rules humans get — a project an employee was not added to simply does not appear in its results.",
      bullets: [
        {
          title: "They own their follow-through",
          body: "A todo created by an AI Employee assigns itself by default, so work it commits to in chat becomes tracked, visible work on the board.",
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
        q: "Can AI Employees actually create and manage tasks, or just read them?",
        a: "They fully manage them: listing and creating Projects, and creating and updating todos — status, priority, assignee, reviewer, due date, and subtask nesting — through built-in tools, governed by the same project access rules as humans.",
      },
      {
        q: "How do I stay in control of what an AI Employee marks as finished?",
        a: "Use the review flow. The employee moves its work to in_review with you as reviewer instead of done. You get a notification (including web push on your phone), and the todo sits in your cross-project Review queue until you sign it off.",
      },
      {
        q: "Can I keep an AI Employee out of a sensitive project?",
        a: "Yes. Switch the project from open to restricted and add people and AI Employees explicitly at view-only or can-edit. The restriction covers the UI and the AI tool surface alike, and safety rails stop you locking yourself out — the last human editor can never be removed.",
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
      "assign tasks to AI Employees",
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
    tagline: "Airtable-style tables sit on your own server.",
    taglineAccent: "One Grant gives an AI Employee 21 tools, and every write it makes is audited.",
    summary:
      "Multi-table workspaces with 11 field types, saved views, comments, and attachments, plus 21 built-in tools for a granted AI Employee.",
    seoTitle: "Bases: Airtable-style tables with 21 AI tools · Genosyn",
    description:
      "Self-hosted multi-table Bases with 11 field types, saved views, comments, and attachments. One Grant gives an AI Employee 21 tools, and every write is audited.",
    intro:
      "A Base holds tables with typed fields, saved views, record comments, and file attachments. It is where the CRM or the applicant tracker lives, on your server rather than in a bolted-on Airtable. Grant an AI Employee the Base and it gets 21 tools over the same rows you edit, with every write in the audit log.",
    checks: [
      "11 field types, incl. linked records",
      "Saved views: filters, sorts, hidden fields",
      "5 templates, from CRM to ATS",
      "Every AI write audit-logged",
    ],
    features: [
      {
        icon: "columns3",
        title: "Eleven field types, including links to sibling tables",
        body: "Eleven field types: text, number, checkbox, dates, email, URL, selects, and link fields that reference rows in sibling tables. Renaming a field never migrates data, because values key on field IDs.",
      },
      {
        icon: "filter",
        title: "Save one view for finance and another for sales",
        body: "Each table keeps saved views that combine type-aware filters (is before, has any of, is empty…), multi-key sorts, and hidden fields, so the sales view and the finance view stop fighting.",
      },
      {
        icon: "panelRight",
        title: "Any row opens as a form with one comment thread",
        body: "Open any row in a side drawer and you get its field values as a form, a comment thread, and file attachments. Each comment is attributed to a human Member or an AI Employee in one shared stream.",
      },
      {
        icon: "layoutTemplate",
        title: "Five templates, from CRM to Applicant Tracker",
        body: "Five templates ship built in. Blank, CRM, Applicant Tracker, Content Calendar and Project Tracker each arrive seeded with linked tables and starter rows, ready to edit.",
      },
      {
        icon: "bot",
        title: "The Base Assistant knows the schema and suggests changes",
        body: "A slide-over chat hands your question to an AI Employee loaded with the Base's schema, and it comes back with suggested changes. Applying them stays your call, which keeps the blast radius small.",
      },
      {
        icon: "keyRound",
        title: "One Grant covers every table in that Base",
        body: "Access is per employee, per Base. One Grant opens read/write on every table in it, and revoking removes those tools from the employee's next spawn. AI uploads cap at 5 MB, so a runaway call cannot fill the disk.",
      },
    ],
    employees: {
      heading: "A granted employee gets 21 tools and 500-row pages",
      body: "A granted AI Employee gets the full Bases surface as built-in tools — schema, rows, comments, and attachments — with pagination, audit trails, and caps designed for autonomous use.",
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
        q: "How do I control which AI Employees can touch a Base?",
        a: "Access is per-employee, per-Base via a Grant, managed from the Base's access panel. One Grant gives read/write on every table in that Base, and revoking it means the employee's next spawn doesn't see the Base tools at all.",
      },
      {
        q: "Can an AI Employee change the schema, or only the data?",
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
    docsPath: "/docs/bases",
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
    tagline: "An AI Employee revised the runbook at 03:00.",
    taglineAccent:
      "Pages nest inside notebooks, and one Grant on a Notebook covers every page under it.",
    summary:
      "Markdown pages in nested notebooks, with read or write Grants that cascade from a notebook down to every sub-page.",
    seoTitle: "Notes: markdown pages your AI Employees edit · Genosyn",
    description:
      "A self-hosted wiki where AI Employees are authors. Nested markdown notebooks, a slash-command block editor, search, and Grants that cascade to sub-pages.",
    intro:
      "Notes holds the company wiki: markdown pages nested inside notebooks, with a block editor, a sidebar tree, search, and a Trash you can restore from. One page body takes 200,000 characters. The SOP a Member wrote on Tuesday and the runbook an AI Employee revised at 03:00 sit in the same tree, and each page says who touched it last.",
    checks: [
      "Block editor with slash commands",
      "Unlimited page nesting per notebook",
      "Grants cascade like Notion sharing",
      "Every AI edit audited + journaled",
    ],
    features: [
      {
        icon: "type",
        title: "Notion-style blocks that save as markdown",
        body: "Headings, lists, to-dos, quotes, dividers. A slash-command menu and a formatting popover put them in. It all round-trips as markdown, so AI-written prose renders untouched.",
      },
      {
        icon: "folderTree",
        title: "Move a page and its whole sub-tree follows",
        body: "Top-level Notebooks hold unlimited Notion-style sub-page trees. Reorder and reparent from the sidebar, with cycle protection, and moving a page drags its whole sub-tree along.",
      },
      {
        icon: "search",
        title: "Search returns 50 hits, newest edit first",
        body: "Search as you type, across titles and bodies. Up to 50 hits come back with the most recently edited first, and AI Employees run the same search through their tools, scoped to what they were granted.",
      },
      {
        icon: "share2",
        title: "One Grant on a Notebook covers every page",
        body: "Share a page or a whole Notebook with an AI Employee at read or write, and the Grant cascades to every descendant, resolving live so a revoke takes effect immediately.",
      },
      {
        icon: "history",
        title: "Every AI write hits the audit log and the Journal",
        body: "Created-by and last-edited-by say whether a Member or an AI Employee touched the page. Every AI write lands in the audit log and in that employee's Journal too.",
      },
      {
        icon: "trash2",
        title: "Deleted pages wait in Trash until someone restores them",
        body: "Pages soft-delete to Trash and restore any time. The AI tooling coaches employees toward archiving rather than hard deletes, and a permanent delete re-parents the children so nothing is orphaned.",
      },
    ],
    employees: {
      heading: "Six built-in tools reach Notes under one Grant",
      body: "AI Employees read and write Notes through built-in tools — list, search, get, create, update, delete — governed by per-employee Grants that only apply to the AI surface. Humans always see everything.",
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
        q: "Can AI Employees edit our notes, or just read them?",
        a: "Both, if you let them. Each AI Employee gets a Grant per Note or per Notebook at read or write level. Write allows creating sub-pages, editing, archiving, and deleting; read allows list, search, and get only. Every AI write is audited and journaled.",
      },
      {
        q: "How does sharing work across nested pages?",
        a: "Like Notion: a Grant on a parent page authorizes every descendant, and a Grant on a Notebook authorizes every page inside it. The cascade resolves at access-check time rather than being copied onto children, so reparenting or revoking takes effect immediately.",
      },
      {
        q: "What happens if an AI Employee deletes a page by mistake?",
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
    tagline: "A PDF filed at 09:00 reaches the 09:05 Routine.",
    taglineAccent:
      "URLs, PDFs, EPUBs, and transcripts come in as plain text any granted AI Employee can search.",
    summary:
      "One ingested URL, PDF, or EPUB that every granted AI Employee can search, export, and attach to a Gmail draft.",
    seoTitle: "Resources: the library your AI Employees read · Genosyn",
    description:
      "Ingest URLs, PDFs, EPUBs, and transcripts once, up to 25 MB each. Granted AI Employees search the extracted text, export it, or attach it to a Gmail draft.",
    intro:
      "Resources takes the material your team did not write and makes it machine-readable: paste a URL and the server strips the nav and the scripts, or upload a PDF up to 25 MB and pdf-parse pulls the text out. Search then runs over titles, summaries, tags, and the full extracted body. No embeddings yet.",
    checks: [
      "URL, PDF, EPUB, text, and markdown",
      "Full-text search over extracted bodies",
      "read < edit < delete Grant levels",
      "Attach to outgoing Gmail by slug",
    ],
    features: [
      {
        icon: "globe",
        title: "One paste turns a web page into text",
        body: "The server fetches the page and extracts readable text, stripping scripts, nav, and footers, with no browser or scraping stack required. A failed fetch keeps the row and its error so a human can fix it.",
      },
      {
        icon: "fileText",
        title: "PDFs, EPUBs, and Markdown up to 25 MB",
        body: "PDFs extract via pdf-parse, EPUBs unzip chapter by chapter, and TXT, Markdown, and HTML upload directly, up to 25 MB per file and 1 MiB of extracted text each.",
      },
      {
        icon: "search",
        title: "One query searches titles, tags, and full bodies",
        body: "Search runs over titles, summaries, tags, and extracted bodies. Humans type and watch the results narrow. AI Employees query that same surface through a tool.",
      },
      {
        icon: "bookOpen",
        title: "EPUBs open in a reader that remembers your progress",
        body: "Detail pages know the type they hold. Text is editable markdown, PDFs use the native viewer, EPUBs get an in-app reader with table of contents and saved progress, and a URL gets an open-original card.",
      },
      {
        icon: "fileOutput",
        title: "Chromium renders the PDF, so tables survive",
        body: "Export any Resource as PDF, HTML, Markdown, or plain text, with PDFs rendered through Chromium so headings, tables, and code blocks come out styled for a chat reply or a Base record.",
      },
      {
        icon: "mailPlus",
        title: "Gmail attaches a Resource by its slug",
        body: "Gmail send and draft tools accept attachments by Resource slug. The server checks the Grant and resolves the bytes, so no base64 ever crosses the model's context window.",
      },
    ],
    employees: {
      heading: "Three Grant levels start at read for everyone",
      body: "AI Employees reach the library through built-in tools gated by three Grant levels — read, edit, delete. The tool descriptions coach them to check whether the team already ingested a primer before improvising.",
      bullets: [
        {
          title: "They curate it too",
          body: "An employee can file a URL, a pasted transcript, or a file it already holds with create_resource — the PDF a customer emailed, or a Word contract it converted first. It gets full control of rows it authored, while teammates start at read.",
        },
        {
          title: "Levels, not switches",
          body: "read covers list, search, and get; edit adds re-titling, tagging, and body updates; delete allows permanent removal. Humans promote employees between levels from the share modal.",
        },
        {
          title: "New material is instantly usable",
          body: "Every new Resource is automatically granted read to all AI Employees, so the primer you drop in at 9:00 informs the Routine that runs at 9:05.",
        },
      ],
    },
    faqs: [
      {
        q: "How is a Resource different from a Note or a Memory?",
        a: "A Resource is content the team did not write — an article, ebook, or transcript ingested once and queried on demand. A Note is a page the team authors together, and a Memory is a durable fact auto-injected into an AI Employee's prompt.",
      },
      {
        q: "What formats can I ingest?",
        a: "Web pages by URL (fetched and extracted to plain text), PDF, EPUB, TXT, Markdown, and HTML uploads up to 25 MB per file, and pasted raw text. Video files are accepted but transcripts aren't extracted yet — upload the transcript as text in the meantime.",
      },
      {
        q: "Can AI Employees add their own Resources?",
        a: "Yes. The create_resource tool lets an employee index a URL, file a pasted transcript or research summary, or file an actual file it already holds — a PDF a customer emailed over, a Word contract it converted to PDF, a form it downloaded. The authoring employee automatically gets full control of its own row; teammates start at read-only. Video files still need a human, because transcripts aren't extracted yet.",
      },
      {
        q: "Can an AI Employee email a Resource to someone?",
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
    accent: "bg-lime-50 text-lime-700 ring-lime-200",
    tagline: "A pipeline wires 17 node types on one canvas.",
    taglineAccent: "A model enters the flow only at the node that asks an AI Employee.",
    summary:
      "A visual DAG of 17 node types fired by cron, a webhook, inbound Gmail, or a new task, with 20 Integrations callable as nodes.",
    seoTitle: "Pipelines: visual automation, 17 node types · Genosyn",
    description:
      "Self-hosted visual automation: 17 node types on a canvas, fired by a cron line, a secret webhook URL, inbound Gmail, or a new task. 20 Integrations callable.",
    intro:
      "Pipelines are the wire-driven half of the company. A pipeline is a DAG of typed nodes that fires from a Run-now button, a 5-field cron line, a webhook URL only you hold, an inbound Gmail message, or a new task in a Project, and it does the same thing on every pass. Put an AI Employee in the middle only where a step needs judgment.",
    checks: [
      "17 node types across 4 families",
      "Manual, schedule, webhook, email, and task triggers",
      "20 Integrations callable as nodes",
      "Every run logged and auditable",
    ],
    features: [
      {
        icon: "mousePointer",
        title: "Drag a node, then type {{trigger.body.name}}",
        body: "Drag nodes from a catalog palette, wire edges between handles, and configure each node in a side panel. Data moves between them as {{trigger.body.name}} templates, and a whole-token value keeps its type.",
      },
      {
        icon: "webhook",
        title: "Five triggers, from a cron line to inbound Gmail",
        body: "Fire a pipeline from a Run-now button, a 5-field cron schedule, an incoming webhook with its own secret URL, an inbound email on a connected Gmail mailbox, or a new task added to a Project. The scheduler's 30-second heartbeat advances before firing, so slow runs can't double-fire.",
      },
      {
        icon: "boxes",
        title: "Six actions write into Bases, Projects, and channels",
        body: "Six built-in actions write straight into the primitives your team already uses: post a channel message, add a todo, create a project, append a Base record, ask an AI Employee, or write a journal note.",
      },
      {
        icon: "split",
        title: "Color-coded true/false edges and a full HTTP node",
        body: "If/else branches carry color-coded true/false edges. Set-variable nodes and delays sit alongside a full HTTP request node with method, headers, and body, whose responses auto-parse as JSON.",
      },
      {
        icon: "plug",
        title: "One node calls Stripe, Postgres, or 18 more",
        body: "One node invokes any tool on any connected Integration, from Stripe and Gmail to GitHub, Notion, Linear, Airtable, Postgres, Telegram and more, with the result captured for downstream nodes.",
      },
      {
        icon: "scrollText",
        title: "The Runs tab holds your last 50 runs",
        body: "Every run records its status, which trigger fired, the payload, per-node outputs, and a step-by-step log. The Runs tab lists the last 50 and refreshes itself while one is in flight.",
      },
    ],
    employees: {
      heading: "One node hands the flow to an AI Employee",
      body: "Pipelines and AI Employees are complements, not competitors. Keep the deterministic 90% on wires and drop a model in only where a decision is genuinely needed.",
      bullets: [
        {
          title: "Ask AI Employee, mid-flow",
          body: "One node sends a message to an employee and captures its reply for downstream nodes — a webhook arrives, the employee summarizes or decides, the pipeline carries on deterministically.",
        },
        {
          title: "Routines can pull the trigger",
          body: "An employee running a Routine can POST to a pipeline's webhook URL, so AI-driven work can kick off wire-driven work.",
        },
        {
          title: "Employees build them, not just run in them",
          body: "Ask an employee to stand up a receiver and it composes the steps, tests them, and hands you the webhook URL — through its genosyn tools, no canvas required.",
        },
        {
          title: "An employee-built flow can't exceed its author",
          body: "Pipelines run as the company, so every step an employee writes is checked against that employee's own Grants before it saves. A Base, private channel, restricted Project, or Connection it wasn't granted is refused, naming the step.",
        },
      ],
    },
    faqs: [
      {
        q: "How are Pipelines different from Routines?",
        a: "Routines are scheduled work performed by an AI Employee — a model is always in the loop. Pipelines are deterministic DAGs of typed nodes: same result every run, no LLM involved unless you explicitly add an Ask-AI-employee node. Routines are AI-driven; Pipelines are wire-driven.",
      },
      {
        q: "What can trigger a pipeline?",
        a: "Five trigger types: Manual (a Run-now button), Schedule (standard 5-field cron on a 30-second heartbeat), Webhook (each node gets a unique secret URL and the POST body becomes the trigger payload), Email received (a new inbound message in a connected Gmail inbox), and Task created (a new task added to any Project). The email trigger takes an optional comma-separated Mailboxes list — leave it empty to watch every connected mailbox — plus sender, subject, and attachment filters; the task trigger narrows by Project, priority, or title. A pipeline can carry multiple triggers, and each run records which one fired.",
      },
      {
        q: "Can a pipeline talk to my other tools?",
        a: "Yes. The Call-integration node invokes any tool on any connected Integration — 20 are registered, including Stripe, Gmail, GitHub, Notion, Linear, Airtable, Postgres, MySQL, ClickHouse, Telegram, X, Reddit, and LinkedIn. For everything else there's a generic HTTP node.",
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
    docsPath: "/docs/pipelines",
    keywords: [
      "self-hosted workflow automation",
      "open source n8n alternative",
      "open source Zapier alternative",
      "visual DAG editor",
      "webhook automation self-hosted",
      "cron triggered automation",
      "AI Employee automation platform",
    ],
  },

  // ───────────────────────────────── Explore ─────────────────────────────────
  {
    slug: "explore",
    name: "Explore",
    category: "Analytics",
    icon: "barChart3",
    accent: "bg-sky-50 text-sky-700 ring-sky-200",
    tagline: "Save the MRR query once as a Chart.",
    taglineAccent: "Every run stops at 30 seconds and 5,000 rows, Member or AI Employee.",
    summary:
      "BI on the database Connections you already have: SQL saved as Charts, pinned to a 12-column Dashboard, runnable by any AI Employee.",
    seoTitle: "Explore: SQL saved as Charts and Dashboards · Genosyn",
    description:
      "Self-hosted BI over the Postgres, MySQL, and ClickHouse Connections you already have. Save SQL as Charts, pin them to Dashboards, and let AI Employees run them.",
    intro:
      'Explore is BI without a second deployment. Write SQL against a database Connection your company already configured, watch the rows come back in the preview, and save the query as a named Chart with one of six visualizations. Pin that Chart to a 12-column Dashboard and "what was MRR last month" costs one click, for a Member or an AI Employee.',
    checks: [
      "Postgres, MySQL, ClickHouse",
      "Six viz types, rendered as SVG",
      "12-column dashboard grid",
      "Same 30s / 5,000-row cap for AI",
    ],
    features: [
      {
        icon: "database",
        title: "Postgres, MySQL, and ClickHouse Connections you already have",
        body: "Charts run against the Integration Connections you already configured, so there are no separate BI credentials to hold. Configs stay encrypted and are decrypted per run, with a fresh client for every query.",
      },
      {
        icon: "code2",
        title: "One save turns the SQL into a Chart",
        body: "Write SQL in the editor with inline errors and a live result preview, then save it as a named Chart. Every run stops at a 30-second timeout and a 5,000-row cap.",
      },
      {
        icon: "pieChart",
        title: "Six visualizations render as inline SVG",
        body: "Table, scalar, bar, line, area, and pie, each configured in a side panel and previewed live against your current result set. Everything renders as inline SVG, with no chart-library dependency.",
      },
      {
        icon: "layoutDashboard",
        title: "Pin Charts to a 12-column drag-and-drop grid",
        body: "Pin Charts as cards on a drag-and-drop 12-column grid with per-card resize. A Chart's title can be overridden per context: MRR on the finance board, Revenue (MTD) on the home one.",
      },
      {
        icon: "share2",
        title: "Every AI Employee starts at read on a Chart",
        body: "Charts and Dashboards default to read for every AI Employee, authors get write on what they create, and humans grant, revoke, or promote from the Share menu.",
      },
      {
        icon: "shieldAlert",
        title: "A SELECT-only database user is the actual guard",
        body: "The executor doesn't pretend to enforce read-only. Connect a SELECT-only database role, as the docs tell you to, and even a write-granted employee can't UPDATE your production data.",
      },
    ],
    employees: {
      heading: "Ten built-in tools under the same 30-second timeout",
      body: "AI Employees use Explore through ten built-in tools — list, get, and run Charts; create and update them; assemble Dashboards — under the same execution envelope humans get.",
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
        q: "Can AI Employees run and build charts?",
        a: "Yes. Every employee defaults to read access on every Chart and Dashboard — list, get, run — and gets write on ones it authors. Humans grant or revoke per Chart or Dashboard from the Share menu.",
      },
      {
        q: "What are the query limits?",
        a: "Every execution — ad-hoc from the editor, a saved Chart, or an AI Employee's run — goes through the same executor with a 30-second wall-clock timeout and a 5,000-row cap; larger result sets are truncated server-side.",
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
    accent: "bg-pink-50 text-pink-700 ring-pink-200",
    tagline: "An AI Employee works your Google Ads account.",
    taglineAccent:
      "Meta, Microsoft Advertising, and Reddit are native Integrations, and every budget increase queues an Approval.",
    summary:
      "Campaign briefs, Creative review, Experiments, and a spend ledger across Google, Meta, Microsoft Advertising, and Reddit Ads.",
    seoTitle: "Paid Marketing: Google, Meta, Microsoft, Reddit · Genosyn",
    description:
      "An AI Employee reads your Google, Meta, Microsoft, and Reddit ad accounts every morning, records performance, and queues every budget increase for a human.",
    intro:
      "A Campaign brief in Genosyn carries the audience, the offer, the KPI, the budget, the platform ids, and the autonomy policy an AI Employee has to work inside. Creative goes through review, and an Experiment needs a hypothesis and a sample threshold before it starts. Raising a budget queues an Approval, and pausing a runaway campaign at 02:00 never waits for anyone.",
    checks: [
      "Google, Meta, Microsoft, Reddit Ads",
      "Campaign, Creative & Experiment workspace",
      "Autonomous observe → decide → act → learn loop",
      "Every spend increase needs a human — by default",
      "Per-change, daily & monthly hard caps",
    ],
    features: [
      {
        icon: "layoutDashboard",
        title: "One Campaign brief holds audience, offer, KPI, and budget",
        body: "A Campaign brief carries audience, offer, KPI, target, budget, owner, platform ids, and autonomy policy. Creative moves through review, and an Experiment needs a hypothesis, sample threshold, winner, and rationale.",
      },
      {
        icon: "shieldAlert",
        title: "Three caps sit above every human approval",
        body: "Per-change, rolling 24-hour, and rolling 30-day limits on authorized budget increases, plus a kill switch. All of it is enforced on every path, so even a human Approval cannot exceed a hard cap.",
      },
      {
        icon: "bell",
        title: "Approvals reach you three ways: bell, websocket, push",
        body: "A budget raise or campaign enable queues an Approval carrying a before→after snapshot, and owners and admins hear about it by bell, websocket, and web-push. If the campaign changed by the time you approve, the replay aborts instead of firing stale.",
      },
      {
        icon: "zap",
        title: "Pausing a campaign at 02:00 skips the queue",
        body: "Spend-decreasing actions never wait in a queue. Pausing a campaign or lowering a budget happens immediately. A runaway at 2am is stopped first and explained after.",
      },
      {
        icon: "table2",
        title: "Every Campaign snapshot records spend, clicks, and conversions",
        body: "Immutable Campaign snapshots record settled spend, impressions, clicks, conversions, value, period, and source, and stay distinct from the AdSpendEvent ledger of authorized budget changes.",
      },
      {
        icon: "globe",
        title: "LinkedIn, X, and TikTok run through the browser",
        body: "LinkedIn, X, and TikTok gate their ads APIs behind months-long reviews, so the documented path is the built-in browser: pinned hosts, approval-gated form submits, and human take-over for logins and 2FA.",
      },
    ],
    employees: {
      heading: "The Performance Marketer template ships three Routines",
      body: "The Performance Marketer template ships a Soul, agency operating Skill, and three Routines that treat evidence and budget discipline as the job.",
      bullets: [
        {
          title: "Daily pacing check",
          body: "A Routine reads every granted ad account each morning, judges pacing over a 7-day window (platforms legally overdeliver on single days), flags zero-delivery campaigns, and treats “couldn’t read the account” as itself an alert.",
        },
        {
          title: "Daily Campaign optimization",
          body: "A Routine reads every assigned Campaign policy and live platform object, records performance, checks Creative fatigue and Experiments, then acts only to observe, optimize, or autonomous mode.",
        },
        {
          title: "ROAS against real revenue",
          body: "The weekly report joins ad spend to GA4 conversions by UTM campaign — and where you run Finance in Genosyn, to actual invoiced revenue, not the platform’s self-graded attribution.",
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
    accent: "bg-green-50 text-green-700 ring-green-200",
    tagline: "Seven Deal Stages run from New to Closed Won.",
    taglineAccent: "The Deal, the invoice, and the payment against it are rows in one database.",
    summary:
      "Contacts, Deals, Sequences, and Signals in the same database as your invoices, with timelines that fill from synced mail.",
    seoTitle: "Revenue: Deals, Sequences, and Signals · Genosyn",
    description:
      "Contacts, Deals, Sequences, and Signals in the same database as your invoices. Timelines fill from synced mail, and every outbound draft waits for a human.",
    intro:
      "Most stacks keep the ad click, the Contact, the Deal, the invoice, and the payment in four systems that agree only after somebody reconciles them. In Genosyn they are rows in one database. An AI Employee works them at read, write, or send, whichever level a human wrote on its Grant.",
    checks: [
      "Deals, contacts, and one timeline",
      "The timeline fills itself from email",
      "Drafts wait for a human Send",
      "read < write < send AI grants",
    ],
    features: [
      {
        icon: "layoutGrid",
        title: "Moving a Deal to Closed Won stamps the date",
        body: "Seven Deal Stages seeded from a conventional B2B ladder, New through Closed Won, arrive as a flat ordered list you edit, each carrying a forecast probability. Moving a deal into a won or lost stage closes it and stamps the date. Genosyn reserves Pipeline for its DAG automation, so here you get stages and a board.",
      },
      {
        icon: "history",
        title: "Every synced message lands on one Contact timeline",
        body: "Mail sync matches thread participants against known Contacts and writes each message onto the timeline as it lands, so opening a contact shows every conversation you have ever had without anyone logging a thing. It links only to contacts that already exist. A mailbox is mostly newsletters and receipts, and auto-creating from strangers would bury the list in a week.",
      },
      {
        icon: "mailPlus",
        title: "A Sequence names one AI Employee and a brief",
        body: "A Sequence stores no message bodies. It names an AI Employee and a standing brief, so every touch is written for that contact from their real context: prior threads, the open deal, the Signal that enrolled them. Drafts land in the same review queue your mail already uses, and a reply stops the enrolment within a heartbeat.",
      },
      {
        icon: "shieldCheck",
        title: "RFC 8058 unsubscribe ships with the first message",
        body: "Every send path shares one outbound choke-point, and suppression is re-checked there at send rather than at draft time. RFC 8058 List-Unsubscribe with one-click POST, a public unsubscribe endpoint, weekday send windows, and a per-sequence daily cap are on from the first message.",
      },
      {
        icon: "zap",
        title: "A Signal queries Postgres, ClickHouse, or Stripe on cron",
        body: "A saved query against a connected Postgres, MySQL, ClickHouse, or Stripe account runs on cron, deduplicated so an account fires once instead of on every tick. A firing then logs an activity, sends a notification, opens a Deal, enrols a Sequence, or wakes an AI Employee with the payload.",
      },
      {
        icon: "barChart3",
        title: "Collected cash sums the payments actually recorded",
        body: "MRR movement covers new, expansion, contraction, churn, and reactivation, alongside ARR, NRR and GRR cohorts, win rate, sales-cycle length, stage conversion, pipeline coverage, CAC by channel, LTV:CAC and payback. The arithmetic is pure and property-tested, and collected cash comes from recorded invoice payments rather than a deal marked won.",
      },
    ],
    employees: {
      heading: "One Grant per employee: read, write, or send",
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
          body: "Every AI write is recorded against the employee's name in the audit log, and the timeline shows whether a Member or an AI Employee logged each event. A contact or a deal can be owned by either.",
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
        q: "Can an AI Employee send outbound email without me?",
        a: "Not by default. Every drafted touch lands in the Drafts review queue and a human presses Send. Unattended sending requires the sequence to be marked auto-send and the employee to hold send on both its revenue grant and that mailbox — and suppression, send windows, and daily caps still apply, with no path around them.",
      },
      {
        q: "What exactly is a Signal?",
        a: "A saved query over a connected product database or Stripe, plus a rule for what to do with the rows it returns, evaluated on a standard 5-field cron. It runs through the same executor and the same 30-second, 5,000-row envelope as an Explore chart, and a unique dedupe key means one row fires once rather than on every tick. Actions are: log an activity, notify, open a Deal, enrol a Sequence, or hand it to an AI Employee.",
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
    tagline: "Your whole Gmail mailbox is mirrored inside Genosyn.",
    taglineAccent: "An AI Employee holds read, draft, or send on it, and draft is the default.",
    summary:
      "A real client over your Gmail mailbox: two-way sync, full-text search, inbound rules, and AI Employees granted read, draft, or send.",
    seoTitle: "Email: a Gmail client staffed by AI Employees · Genosyn",
    description:
      "Work your Gmail inbox inside Genosyn: two-way sync every 30 seconds, full-text search, inbound rules, and AI Employees that triage and draft. You press Send.",
    intro:
      "Genosyn imports the whole Gmail mailbox into a local index and keeps it in two-way sync: folders, labels, search, compose. What it really replaces is the copy-paste loop between your inbox and a chat window. Grant an employee draft on the mailbox and a support email arrives already triaged, with a reply sitting on the thread.",
    checks: [
      "Two-way Gmail sync, ~1 min fresh",
      "No Pub/Sub or extra infra",
      "read < draft < send AI levels",
      "Every AI action audited",
    ],
    features: [
      {
        icon: "refreshCw",
        title: "Incremental polling runs every 30 seconds",
        body: "First sync imports the entire mailbox newest-first and resumes in the background, after which 30-second incremental polling takes over. Every action writes through to the Gmail API first, so Gmail and Genosyn always agree.",
      },
      {
        icon: "inbox",
        title: "Compose, reply, forward, and attach inside Genosyn",
        body: "Folder and label sidebar with unread counts, compose, reply, reply-all, forward, attachments in and out, and drafts. That includes the AI-written drafts you edit and send.",
      },
      {
        icon: "search",
        title: "Search the whole Gmail mailbox, bodies included",
        body: "Full-text search runs over subjects, participants, and complete message bodies. Structured filters narrow it: from, to, date range, label, unread, has-attachment.",
      },
      {
        icon: "handshake",
        title: "Hand a thread over in one of three modes",
        body: "Pick a granted employee, give an instruction, and choose one of three modes. Draft a reply, reply directly, or triage. The employee runs with its full Soul, Skills, and memory, and the result lands on the thread.",
      },
      {
        icon: "filter",
        title: "One rule sends support@ mail to an employee",
        body: "Conditions on from, to, subject, body, or attachments fire an action: label, mark read, star, archive, or hand the thread to an AI Employee. Rules never run on backfill or on your own sent mail.",
      },
      {
        icon: "shieldCheck",
        title: "Three levels per mailbox: read, draft, send",
        body: "Access is per employee and per mailbox at read, draft, or send. Draft is the default, so an employee leaves a finished reply and a human presses Send. The levels bind the Gmail integration tools too, so there are no side doors.",
      },
    ],
    employees: {
      heading: "AI Employees reach the mailbox three ways",
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
        q: "Can an AI Employee send email without my approval?",
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
    tagline: "A statement ages the balance into five buckets.",
    taglineAccent: "Every figure on it comes off the invoices Finance already issued.",
    summary:
      "Accounts with contacts, ACV, and signed contracts, plus statements that age receivables across five buckets straight from your invoices.",
    seoTitle: "Customers: accounts, ACV, contracts, statements · Genosyn",
    description:
      "A CRM inside Genosyn: accounts with contacts and ACV, signed contracts up to 25 MB, and per-customer statements that age balances across five buckets.",
    intro:
      "A Customer record carries the billing email, the tax ID, the default currency, and the address that prints on every invoice. Its slug prefixes the document numbers: ACME-CORP-INV-0001. Contacts, Annual Contract Value, and the signed MSA hang off that same row, and the statement is derived live from Finance rather than kept as a second ledger.",
    checks: [
      "Accounts, contacts, and ACV",
      "Contract uploads to 25 MB",
      "Statements with 5-bucket aging",
      "PDF and print-ready output",
    ],
    features: [
      {
        icon: "building2",
        title: "ACME-CORP-INV-0001 comes from the account slug",
        body: "Name, billing email, phone, tax ID, default currency, and addresses make up the record that appears on every invoice. Each account's slug prefixes its document numbers: ACME-CORP-INV-0001.",
      },
      {
        icon: "contactRound",
        title: "Any number of contacts, one marked primary",
        body: "Add as many contacts per customer as the account needs, each with name, role, email, and phone. Mark one primary. All of it is managed inline on the customer page.",
      },
      {
        icon: "trendingUp",
        title: "ACV gets its own column, independent of invoices",
        body: "Annual Contract Value is tracked per account in its default currency as an independent sales metric. Editing it never touches issued invoices.",
      },
      {
        icon: "fileSignature",
        title: "Signed MSAs and NDAs upload to 25 MB",
        body: "Upload signed MSAs, order forms, and NDAs as PDF, image, or document up to 25 MB. They sit on your own server, browsable globally or per customer.",
      },
      {
        icon: "receipt",
        title: "One statement, derived live from invoices and payments",
        body: "Every issued invoice lands as a charge and every payment as a credit, in date order with opening balance, running balance, and balance due. It is derived live, so there is no second ledger to drift.",
      },
      {
        icon: "clock",
        title: "Five buckets: current, 1–30, 31–60, 61–90, 90+",
        body: "Outstanding balance is bucketed into current, 1–30, 31–60, 61–90, and 90+ days past due, filterable by period and switchable per currency. Balances are never summed across currencies.",
      },
    ],
    employees: {
      heading: "One permission model across Customers and Finance",
      body: "Customer data flows straight into Finance — invoices, estimates, payments, exports — on the platform your AI Employees already operate, with one permission model and one audit trail.",
      bullets: [
        {
          title: "Overviews with an action queue",
          body: "Each account page shows headline numbers — ACV, outstanding balance, lifetime billed — plus a queue of overdue invoices and estimates awaiting response, deep-linked into Finance.",
        },
        {
          title: "PDFs from the same pipeline",
          body: "Statements render server-side through headless Chromium — the same rendering path invoices use and the same artifact machinery AI Employees hand you PDFs with.",
        },
        {
          title: "Stripe-side visibility today",
          body: "An employee granted a Stripe Connection can already browse the Stripe-side customer catalog read-only; native customer tools for AI Employees are on the roadmap, gated by approvals.",
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
    tagline: "Invoice ACME-CORP-INV-0001 posts to the ledger at issue.",
    taglineAccent: "Voiding it reverses every entry that posting made.",
    summary:
      "Estimates become invoices, invoices post to a double-entry ledger, and the period closes into Retained Earnings.",
    seoTitle: "Finance: invoicing and a double-entry ledger · Genosyn",
    description:
      "Self-hosted accounting inside Genosyn: estimates, invoices, recurring billing, bills, a double-entry ledger, three reports, Stripe reconciliation, and period close.",
    intro:
      "Money is stored as integer minor units with a 3-letter ISO currency code on every row, so nothing rounds twice. Finance runs the whole cycle: an estimate converts to an invoice, the invoice mints its number and posts a journal entry, Stripe payouts reconcile against it, and the period locks with a closing entry into Retained Earnings. Nobody exports anything to a second accounting tab.",
    checks: [
      "Real double-entry ledger",
      "Gapless, customer-prefixed numbering",
      "P&L, balance sheet, cash flow",
      "Money as integer minor units",
    ],
    features: [
      {
        icon: "fileText",
        title: "One click turns an estimate into an invoice",
        body: "Estimates run a full lifecycle and convert to invoices in one click, copying every line, issuing the invoice, and posting the journal entry. Line items carry per-line inclusive or exclusive tax.",
      },
      {
        icon: "repeat",
        title: "Schedules fire every 14 days and email the PDF",
        body: "Schedules fire every N days, weeks, months, quarters, or years, and a plain-English preview says when. Each tick drafts by default, or auto-issues and emails the PDF through your configured provider.",
      },
      {
        icon: "bookOpenCheck",
        title: "Ten system accounts seed the chart on day one",
        body: "The chart of accounts arrives seeded with ten system accounts, alongside balance enforcement at the service layer, manual journal entries, and a trial balance. Document lifecycles post themselves, and voiding reverses every entry.",
      },
      {
        icon: "barChart3",
        title: "Drill from a P&L row to its journal entries",
        body: "P&L, balance sheet, and cash flow, each with period filters and prior-period comparison columns. Drill through from any account row to the entries behind it.",
      },
      {
        icon: "landmark",
        title: "Stripe payouts and CSV imports auto-match your bills",
        body: "Vendors and bills mirror the receivable side, auto-posting with FX gain/loss. Reconcile against Stripe payouts or CSV imports using auto-match heuristics, with a manual matching UI for whatever is left.",
      },
      {
        icon: "lock",
        title: "The closing entry posts to Retained Earnings",
        body: "Accounting periods lock with a closing entry into Retained Earnings, after which the ledger refuses writes inside them. Hand your accountant plain-CSV exports of the journal and trial balance.",
      },
    ],
    employees: {
      heading: "Browser-enabled AI Employees drive Finance today",
      body: "Finance is not a silo behind a third-party API — it shares one platform, one permission model, and one audit trail with your AI Employees.",
      bullets: [
        {
          title: "API-first surface",
          body: "The entire Finance surface is reachable through the company REST API with scoped API keys — scriptable from CI, external tools, or agent code.",
        },
        {
          title: "Browser-driven today",
          body: "Browser-enabled AI Employees can drive the Finance UI directly through the built-in browser tools, with approval-gated form submits.",
        },
        {
          title: "Native tools, gated, next",
          body: "A dedicated finance tool surface for employees is on the roadmap — read-only tools first, money-moving actions behind the same approval-by-amount pattern the ad platforms already use for spend increases.",
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

  // ─────────────────────────────── Repositories ──────────────────────────────
  {
    slug: "repositories",
    name: "Repositories",
    category: "Engineering",
    icon: "gitBranch",
    accent: "bg-violet-50 text-violet-700 ring-violet-200",
    tagline: "Genosyn runs git init on your own server.",
    taglineAccent: "An AI Employee commits to its own branch for a human to read.",
    summary:
      "A git repository for code or a quarter's strategy: browser editor, branches, and AI work sessions you read before merging.",
    seoTitle: "Repositories: git for code and documents · Genosyn",
    description:
      "Version-controlled workspaces for code and documents. Edit and commit in the browser, publish a repository to GitHub, and review what an AI Employee wrote.",
    intro:
      "A Repository holds a service's source or a quarter's strategy, and either way it is a plain git repository your company owns. Members browse, search, edit, and commit under their own name in the browser. Hand a piece of work to a granted AI Employee and it takes its own worktree and its own branch, runs your tests against what it wrote, and reports back for a human to merge or discard.",
    checks: [
      "Start empty inside Genosyn, or clone any git URL",
      "Publish a local repository to GitHub later",
      "Browser editor with search, diffs, and history",
      "AI work sessions you review before merging",
      "Per-repository control over what AI may run",
      "Credentials AES-256-GCM encrypted",
    ],
    features: [
      {
        icon: "folderGit2",
        title: "Strategy docs get the same git history as code",
        body: "Mark a Repository as code or documents and the copy, editor defaults, and AI briefing follow. Underneath, both are a plain git repository, so a quarter's strategy gets the same branches, diffs, and history as a service.",
      },
      {
        icon: "gitFork",
        title: "Genosyn creates the GitHub repository and pushes your history",
        body: "Clone any HTTPS or SSH URL, or create one empty with git init and no remote at all. When it outgrows that, pick a connected GitHub Connection. Genosyn creates the repository on GitHub, private by default, and pushes the history. No personal access token is minted or pasted, and AI session branches are left behind.",
      },
      {
        icon: "fileText",
        title: "The browser editor respects .gitignore and renders README.md",
        body: "A tree that respects .gitignore, an editor with syntax highlighting, and create, rename, move, and delete. Search is literal and includes uncommitted files, the README renders on the Overview, and diffs come per file or whole-tree, with every commit attributed to the Member who made it.",
      },
      {
        icon: "history",
        title: "Open a file as it was 40 commits ago",
        body: "Create a branch from any revision, switch between them, and read the log for the repository or one file, each commit with its own diff. Open a file as it stood at an older commit. Fast-forward pull and push belong to owners and admins.",
      },
      {
        icon: "bot",
        title: "An AI Employee runs your tests on its branch",
        body: "Describe the work and pick a granted AI Employee. It runs in its own git worktree on its own branch, editing through Genosyn-executed tools and running your tests and linter against what it wrote, so the diff you read has already been checked. It commits and reports. You merge it, or discard it.",
      },
      {
        icon: "shieldCheck",
        title: "AES-256-GCM encrypts the tokens no model can reach",
        body: "The checkout that holds credentials is unreachable by any model process. Tokens and SSH keys are AES-256-GCM encrypted and never returned to the client. They are used only in the push path, which only an owner or admin can trigger.",
      },
    ],
    employees: {
      heading: "A session ends with one branch and one report",
      body: "Grant an employee a Repository and you can hand it a piece of work the way you would hand it to a person: describe the outcome, let it work in isolation, then read what it did before any of it lands.",
      bullets: [
        {
          title: "Isolated by construction",
          body: "Each session gets its own git worktree and branch. Two sessions never collide, and an employee cannot reach the shared checkout, write into .git, or make a tool follow a symlink out of the tree.",
        },
        {
          title: "Commands you decide on",
          body: "Choose per repository what an employee may run: nothing, only what matches your list, or anything. The default list covers the usual test, lint, and build tooling and leaves out curl, ssh, and git push. Commands run behind bubblewrap with the session's worktree as their whole filesystem — and where that isolation is unavailable, sessions carry on reading, writing, and committing without them.",
        },
        {
          title: "A diff and a report",
          body: "The session ends with commits on a branch and a short written report of what changed, what was left alone, and what could not be verified. Publish merges it; discard deletes the branch.",
        },
      ],
    },
    faqs: [
      {
        q: "Is this only for source code?",
        a: "No. A Repository is any version-controlled workspace — a service's source, a quarter's strategy, a set of operating policies. The kind field (code or documents) changes the copy, the editor defaults, and how an AI Employee is briefed; underneath, every Repository is a plain git repository.",
      },
      {
        q: "Do I need a GitHub account, or any git host?",
        a: "No. A local Repository is created empty inside Genosyn with git init and never leaves your server. A remote Repository clones any HTTPS or SSH URL — GitHub, GitLab, Bitbucket, or a self-hosted server. And a local one can be connected to GitHub whenever you want, which creates it there and pushes the history it already has.",
      },
      {
        q: "What does connecting a repository to GitHub actually do?",
        a: "It creates the repository on GitHub through the Connection your company already authorised under Settings → Integrations, then pushes the history the repository already has. Nobody creates or pastes a personal access token: the Connection's token is resolved per operation and never stored on the repository, and later pushes to that remote use the same Connection. Branches from AI work sessions are deliberately left out of that first push. If you would rather create the repository yourself, paste the clone URL of an empty one instead — a remote that already has commits is refused, not force-pushed. Owner or admin only.",
      },
      {
        q: "Do I need coding tools or a sandbox enabled?",
        a: "Not for reading, writing, and committing: the browser editor and AI work sessions run against a server-owned checkout with no shell involved. You need the sandbox for two things. One is letting an employee run your tests and linter inside a work session. The other is the separate per-employee checkout, the one an employee uses with ordinary git during open-ended chat and Routine work. The standard Docker install has the sandbox by default, unless its host denies bubblewrap the Linux namespaces it needs.",
      },
      {
        q: "Can an AI Employee push straight to my remote?",
        a: "No. It commits to its own branch in its own worktree. A Member reviews the diff and merges, and only an owner or admin can push. Credentials are used exclusively in that push path and never enter a tree a model can reach.",
      },
      {
        q: "Who is allowed to do what?",
        a: "Browsing, searching, editing, committing, branching, and starting AI work sessions are open to any company Member. Pushing, pulling, connecting a repository to a remote, and repository configuration — clone URL, credentials, and AI grants — require an owner or admin, because a local commit can be undone and a push cannot be recalled.",
      },
      {
        q: "How are my tokens and SSH keys stored?",
        a: "Encrypted at rest with AES-256-GCM, the same protection as model API keys, and never shown back in plaintext — the UI reports only whether a credential is set. An SSH key is written to an App-private temporary directory for exactly one operation and removed afterwards.",
      },
      {
        q: "What happens if I delete a repository in Genosyn?",
        a: "It removes the grants, the work sessions, and the server-side checkout. A remote repository is never touched on its host. A local repository has no remote, so deleting it deletes the only copy of its history.",
      },
    ],
    docsPath: "/docs/repositories",
    keywords: [
      "version control for documents",
      "git repository web editor self-hosted",
      "AI Employee edit and commit code",
      "review AI code changes before merge",
      "self-hosted AI software engineer",
      "per-agent repository permissions",
      "git without GitHub self-hosted",
      "publish a local git repository to GitHub",
      "create a GitHub repository without a personal access token",
    ],
  },
];

export const PRODUCT_CATEGORIES: string[] = [
  "The core",
  "Essentials",
  "Knowledge",
  "Automation",
  "Analytics",
  "Marketing",
  "Operations",
  "Engineering",
];

export function findProduct(slug: string): ProductDef | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}
