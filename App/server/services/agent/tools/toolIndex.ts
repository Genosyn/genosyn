import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";

/**
 * The searchable view of the genosyn tool catalogue: which domain each tool
 * belongs to, and the words an operator would actually use to ask for it.
 *
 * ## Why this is a view and not a manifest field
 *
 * `mcp/protocol.ts` re-projects only `{name, description, inputSchema}` when it
 * answers `tools/list`, but `routes/mcpInternal.ts` serves `STATIC_TOOLS` raw
 * from `/manifest`. So a new field on {@link McpToolSpec} would leak to external
 * MCP clients through one path while staying invisible on the other — a
 * published contract change nobody asked for. Keying by name from beside the
 * agent costs one assertion and changes no contract.
 *
 * ## Why hand-curated keywords
 *
 * Ranking on descriptions alone does not work on this corpus, and that is
 * measurable rather than suspected: "spreadsheet" matches none of the 104
 * tools, "database" matches only `run_chart`, and "invoice" matches fourteen —
 * mostly Base tools that happen to use invoices as a worked example. A model
 * asking for "the spreadsheet thing" would be told it has no such tool while
 * `base_rows` sat one synonym away.
 *
 * So the keyword layer is the retrieval surface, and `discovery.test.ts` is its
 * regression gate. Add a keyword when a plausible phrasing misses; do not
 * delete one because it looks redundant.
 */

export type ToolDomain = {
  /** Human-facing label, used in the prompt and in `find_tools`' footer. */
  label: string;
  /** One line on what the domain is for. */
  blurb: string;
  /** Manifest tool names in this domain. */
  tools: string[];
};

export const TOOL_DOMAINS: Record<string, ToolDomain> = {
  orientation: {
    label: "orientation",
    blurb: "Find out who you are and who else works here.",
    tools: ["get_self", "list_employees", "list_teams"],
  },
  routines: {
    label: "routines",
    blurb: "Scheduled recurring AI work. Never call these tasks.",
    tools: ["list_routines", "create_routine", "update_routine", "delete_routine"],
  },
  projects: {
    label: "projects & todos",
    blurb: "One-off work items for humans and AI employees.",
    tools: ["list_projects", "create_project", "list_todos", "create_todo", "update_todo"],
  },
  journal: {
    label: "journal",
    blurb: "Your own diary. The last week is auto-injected into every prompt.",
    tools: ["list_journal", "add_journal_entry"],
  },
  memory: {
    label: "memory",
    blurb: "Durable facts about yourself, auto-injected into every prompt.",
    tools: ["list_memory", "add_memory", "update_memory", "delete_memory"],
  },
  skills: {
    label: "skills",
    blurb: "The Skill playbooks attached to an AI employee.",
    tools: ["list_skills", "create_skill", "update_skill", "delete_skill"],
  },
  bases: {
    label: "bases",
    blurb: "The structured data store — bases, tables, fields and rows.",
    tools: [
      "list_bases",
      "get_base",
      "create_base",
      "create_base_table",
      "update_base_table",
      "delete_base_table",
      "add_base_field",
      "update_base_field",
      "delete_base_field",
      "list_base_rows",
      "create_base_row",
      "update_base_row",
      "delete_base_row",
    ],
  },
  base_records: {
    label: "base records",
    blurb: "One row of a Base, with its comment thread and attached files.",
    tools: [
      "get_base_record",
      "list_record_comments",
      "create_record_comment",
      "delete_record_comment",
      "list_record_attachments",
      "attach_file_to_record",
      "read_record_attachment",
      "delete_record_attachment",
    ],
  },
  notes: {
    label: "notes",
    blurb: "The company's long-form pages and notebooks.",
    tools: [
      "list_notebooks",
      "list_notes",
      "search_notes",
      "get_note",
      "create_note",
      "update_note",
      "delete_note",
    ],
  },
  resources: {
    label: "resources",
    blurb: "The company's reference library of ingested documents.",
    tools: [
      "list_resources",
      "search_resources",
      "get_resource",
      "export_resource",
      "create_resource",
      "update_resource",
      "delete_resource",
    ],
  },
  charts: {
    label: "charts",
    blurb: "Saved SQL charts you can run and edit.",
    tools: ["list_charts", "get_chart", "run_chart", "create_chart", "update_chart", "delete_chart"],
  },
  dashboards: {
    label: "dashboards",
    blurb: "Dashboards assembled out of saved charts.",
    tools: ["list_dashboards", "get_dashboard", "create_dashboard", "add_dashboard_card"],
  },
  workspace: {
    label: "workspace chat",
    blurb: "Company channels and the messages in them.",
    tools: [
      "list_workspace_channels",
      "create_workspace_channel",
      "rename_workspace_channel",
      "archive_workspace_channel",
      "send_workspace_message",
    ],
  },
  handoffs: {
    label: "handoffs",
    blurb: "Hand work to a teammate, and resolve handoffs sent to you.",
    tools: [
      "list_handoffs",
      "create_handoff",
      "complete_handoff",
      "decline_handoff",
      "cancel_handoff",
    ],
  },
  mail: {
    label: "mail",
    blurb: "The company's Gmail mailboxes. Needs a per-mailbox grant.",
    tools: [
      "list_mail_accounts",
      "search_mail",
      "get_mail_thread",
      "create_mail_draft",
      "edit_mail_draft",
      "update_mail_thread",
      "send_mail",
      "suggest_mail_actions",
    ],
  },
  finance: {
    label: "finance",
    blurb: "Invoices, customers, payments and the books. Needs a finance grant.",
    tools: [
      "list_finance_accounts",
      "list_finance_transactions",
      "get_finance_transaction",
      "review_finance_transaction",
      "get_finance_report",
      "list_invoices",
      "get_invoice",
      "list_customers",
      "get_customer",
      "create_customer",
      "update_customer",
      "create_invoice",
      "send_invoice",
      "record_payment",
      "void_invoice",
    ],
  },
  revenue: {
    label: "revenue",
    blurb: "Contacts, deals, the pipeline, sequences and signals. Needs a revenue grant.",
    tools: [
      "list_contacts",
      "search_contacts",
      "get_contact",
      "get_contact_timeline",
      "list_deals",
      "get_deal",
      "get_deal_board",
      "list_deal_stages",
      "list_sequences",
      "list_signals",
      "get_revenue_report",
      "create_contact",
      "update_contact",
      "create_deal",
      "update_deal",
      "move_deal_stage",
      "log_activity",
      "add_deal_contact",
      "enroll_in_sequence",
      "suppress_email",
    ],
  },
  files: {
    label: "files",
    blurb: "Send a file to a teammate, and read or fill PDF forms.",
    tools: ["send_chat_attachment", "read_pdf_fields", "fill_pdf_form"],
  },
  code: {
    label: "code",
    blurb: "The git repositories granted to you.",
    tools: ["list_code_repositories"],
  },
};

/**
 * Words that should find a tool but do not appear in its description.
 *
 * Every entry here is a miss someone actually hit, or would have. Keep the
 * vocabulary an operator would type, not the vocabulary the code uses.
 */
export const TOOL_KEYWORDS: Record<string, string[]> = {
  // Bases are the worst offender: nothing in their prose says "spreadsheet".
  list_bases: ["spreadsheet", "table", "grid", "database", "dataset"],
  get_base: ["spreadsheet", "table", "grid", "schema"],
  create_base: ["spreadsheet", "table", "grid", "new database", "tracker"],
  create_base_table: ["spreadsheet", "tab", "sheet", "worksheet"],
  update_base_table: ["rename table", "sheet"],
  delete_base_table: ["drop table", "sheet"],
  add_base_field: ["column", "field", "property", "add column"],
  update_base_field: ["column", "rename column", "select options", "dropdown"],
  delete_base_field: ["column", "drop column"],
  list_base_rows: ["rows", "records", "query", "database", "sql", "filter", "spreadsheet", "read data"],
  create_base_row: ["row", "record", "entry", "add data", "insert"],
  update_base_row: ["row", "record", "edit data", "cell"],
  delete_base_row: ["row", "record", "remove data"],
  get_base_record: ["row", "record", "detail"],
  list_record_comments: ["comment", "thread", "discussion", "note on a row"],
  create_record_comment: ["comment", "reply on a record"],
  delete_record_comment: ["comment"],
  list_record_attachments: ["file", "attachment", "upload", "document"],
  attach_file_to_record: ["file", "attachment", "upload", "attach"],
  read_record_attachment: ["file", "attachment", "download", "open file"],
  delete_record_attachment: ["file", "attachment"],

  // Charts / dashboards — "sql" and "report" never appear together in prose.
  run_chart: ["sql", "query", "database", "report", "numbers", "metrics"],
  list_charts: ["sql", "report", "graph", "metrics"],
  get_chart: ["sql", "graph", "report"],
  create_chart: ["sql", "graph", "report", "visualise", "visualize"],
  update_chart: ["sql", "graph"],
  delete_chart: ["graph"],
  list_dashboards: ["report", "overview", "kpi"],
  get_dashboard: ["report", "kpi"],
  create_dashboard: ["report", "kpi", "overview"],
  add_dashboard_card: ["report", "tile", "widget", "panel"],

  // Mail — operators say "inbox" and "reply", the prose says "thread".
  list_mail_accounts: ["inbox", "mailbox", "gmail", "email account"],
  search_mail: ["inbox", "email", "gmail", "find message", "search inbox"],
  get_mail_thread: ["inbox", "email", "read email", "conversation"],
  create_mail_draft: ["email", "compose", "write email", "reply", "draft"],
  edit_mail_draft: ["email", "revise draft", "amend"],
  update_mail_thread: ["archive email", "label", "mark read", "inbox"],
  send_mail: ["email", "reply", "send email", "respond"],
  suggest_mail_actions: ["inbox", "triage", "what should i do with this email"],

  // Finance — "who owes us money" is the query, "receivable" is the word.
  list_invoices: ["receivable", "billing", "who owes us", "unpaid", "outstanding", "ar"],
  get_invoice: ["receivable", "billing", "bill"],
  create_invoice: ["bill", "billing", "charge", "receivable", "raise an invoice"],
  send_invoice: ["bill", "billing", "email invoice", "chase"],
  record_payment: ["paid", "payment", "receipt", "mark paid", "settle"],
  void_invoice: ["cancel invoice", "write off"],
  list_customers: ["client", "account", "buyer", "crm"],
  get_customer: ["client", "account", "buyer"],
  create_customer: ["client", "account", "new client"],
  update_customer: ["client", "account"],
  list_finance_accounts: ["ledger", "books", "chart of accounts", "bank"],
  list_finance_transactions: ["ledger", "books", "bank", "spend", "expenses", "transactions"],
  get_finance_transaction: ["ledger", "books", "expense"],
  review_finance_transaction: ["ledger", "books", "approve", "categorise", "categorize", "reconcile"],
  get_finance_report: ["p&l", "profit", "loss", "balance sheet", "books", "financials"],

  // Revenue — the CRM half of the money. Finance answers "who owes us"; this
  // answers "who are we talking to", and none of that vocabulary — pipeline,
  // lead, prospect, churn, cadence — appears in the finance prose. "client" is
  // deliberately absent: it belongs to `create_customer`, and duplicating it
  // here would put two plausible tools on the same query.
  list_contacts: ["crm", "leads", "prospects", "contacts"],
  search_contacts: ["crm", "lead", "prospect", "find a person", "find someone"],
  get_contact: ["lead", "prospect", "person"],
  get_contact_timeline: ["history", "timeline", "what happened with", "last spoke"],
  list_deals: ["pipeline", "opportunities", "deals in flight"],
  get_deal: ["opportunity", "pipeline"],
  get_deal_board: ["pipeline", "board", "kanban", "what is in the pipeline"],
  list_deal_stages: ["pipeline", "stages", "sales process"],
  list_sequences: ["campaign", "outbound", "drip", "cadence"],
  list_signals: ["trigger", "product usage", "churn risk", "intent"],
  get_revenue_report: ["mrr", "arr", "churn", "retention", "funnel", "win rate", "cac"],
  create_contact: ["new lead", "capture a lead", "add a contact"],
  update_contact: ["enrich a contact", "lifecycle stage"],
  create_deal: ["new opportunity", "open a deal", "pipeline"],
  update_deal: ["deal amount", "next step"],
  move_deal_stage: ["close won", "closed lost", "advance the deal", "mark won"],
  log_activity: ["log a call", "log a meeting", "log a note", "meeting notes"],
  add_deal_contact: ["buying committee", "stakeholder", "champion"],
  enroll_in_sequence: ["outbound", "campaign", "enroll", "cadence"],
  suppress_email: ["unsubscribe", "do not contact", "opt out", "suppression list"],

  // Notes / resources — "doc", "page" and "wiki" are the words in use.
  list_notes: ["doc", "document", "page", "wiki"],
  search_notes: ["doc", "document", "page", "wiki", "find a doc"],
  get_note: ["doc", "document", "page", "wiki", "read a doc"],
  create_note: ["doc", "document", "page", "wiki", "write up"],
  update_note: ["doc", "document", "page", "edit doc"],
  delete_note: ["doc", "document", "page"],
  list_notebooks: ["doc", "wiki", "folder"],
  list_resources: ["knowledge", "library", "reference", "pdf", "upload"],
  search_resources: ["knowledge", "library", "reference", "look up", "rag"],
  get_resource: ["knowledge", "library", "reference", "read"],
  export_resource: ["knowledge", "download", "export"],
  create_resource: ["knowledge", "library", "ingest", "upload"],
  update_resource: ["knowledge", "library"],
  delete_resource: ["knowledge", "library"],

  // Files
  send_chat_attachment: ["file", "download", "attach", "send file", "deliver"],
  read_pdf_fields: ["pdf", "form", "fields"],
  fill_pdf_form: ["pdf", "form", "complete form", "fill in"],

  // Everything else where an obvious synonym is missing.
  create_routine: ["schedule", "recurring", "cron", "every day", "automate"],
  update_routine: ["schedule", "reschedule", "pause", "resume", "edit schedule"],
  delete_routine: ["schedule", "stop recurring"],
  list_routines: ["schedule", "recurring", "cron"],
  create_project: ["board", "workstream"],
  create_todo: ["task", "ticket", "action item", "to-do"],
  update_todo: ["task", "ticket", "complete", "close", "done"],
  list_todos: ["task", "ticket", "action item"],
  add_journal_entry: ["log", "diary", "record what i did", "decision log"],
  list_journal: ["log", "diary", "history"],
  send_workspace_message: ["slack", "chat", "post", "channel", "message the team"],
  list_workspace_channels: ["slack", "chat", "channel"],
  create_workspace_channel: ["slack", "chat", "channel"],
  rename_workspace_channel: ["slack", "channel"],
  archive_workspace_channel: ["slack", "channel", "close channel"],
  create_handoff: ["delegate", "escalate", "hand over", "ask a colleague"],
  list_handoffs: ["delegate", "escalate", "my queue"],
  complete_handoff: ["done", "resolve"],
  decline_handoff: ["reject", "refuse"],
  cancel_handoff: ["withdraw"],
  list_code_repositories: ["git", "repo", "codebase", "source"],
  list_employees: ["team", "colleague", "who else", "roster"],
  list_teams: ["team", "department", "group"],
  get_self: ["who am i", "my role", "myself"],
  list_skills: ["playbook", "procedure", "sop"],
  create_skill: ["playbook", "procedure", "sop", "write a playbook"],
  update_skill: ["playbook", "procedure", "sop"],
  delete_skill: ["playbook", "procedure"],
  add_memory: ["remember", "note to self", "durable fact"],
  list_memory: ["remember", "what do i know"],
  update_memory: ["remember", "correct a fact"],
  delete_memory: ["forget"],
};

/** Domain key for a manifest tool name, or undefined if it has no home. */
export function domainOf(toolName: string): string | undefined {
  for (const [key, domain] of Object.entries(TOOL_DOMAINS)) {
    if (domain.tools.includes(toolName)) return key;
  }
  return undefined;
}

/**
 * Fail at boot if the index and the manifest have drifted apart.
 *
 * Copies the idiom `collapseStaticTools()` already uses: a tool that exists but
 * sits in no domain is invisible to `find_tools`, which is the one failure mode
 * this whole design cannot tolerate — the capability is present, reachable, and
 * undiscoverable. Better to refuse to start than to ship a hole.
 */
export function assertIndexCoversManifest(): void {
  const indexed = new Set(Object.values(TOOL_DOMAINS).flatMap((d) => d.tools));
  const manifest = new Set(STATIC_TOOLS.map((t) => t.name));

  const missing = [...manifest].filter((n) => !indexed.has(n));
  if (missing.length > 0) {
    throw new Error(
      `TOOL_DOMAINS in toolIndex.ts does not cover ${missing.length} manifest tool(s): ` +
        `${missing.join(", ")}. Add each to a domain — an unindexed tool cannot be found ` +
        `by find_tools, so the employee has it but can never reach it.`,
    );
  }

  const stale = [...indexed].filter((n) => !manifest.has(n));
  if (stale.length > 0) {
    throw new Error(
      `TOOL_DOMAINS in toolIndex.ts names ${stale.length} tool(s) that are not in ` +
        `STATIC_TOOLS: ${stale.join(", ")}. Remove them or fix the rename.`,
    );
  }

  const badKeyword = Object.keys(TOOL_KEYWORDS).filter((n) => !manifest.has(n));
  if (badKeyword.length > 0) {
    throw new Error(
      `TOOL_KEYWORDS in toolIndex.ts names ${badKeyword.length} tool(s) that are not in ` +
        `STATIC_TOOLS: ${badKeyword.join(", ")}.`,
    );
  }
}

assertIndexCoversManifest();
