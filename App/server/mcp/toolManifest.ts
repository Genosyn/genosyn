/*
 * Single source of truth for the built-in Genosyn MCP tool manifest.
 *
 * Every entry describes one tool the `genosyn` MCP server exposes: its name,
 * a model-facing description, and a JSON-Schema for the arguments. The
 * server-side handler for each tool lives in `routes/mcpInternal.ts` at
 * `POST /tools/<name>` — the endpoint is always derived from the name, so it
 * is not stored here.
 *
 * Two consumers read this manifest:
 *   - the in-process agent (`services/agent/tools/genosyn.ts`), which maps each
 *     entry to a model tool and dispatches calls to `POST /tools/<name>`; and
 *   - the external Streamable-HTTP endpoint (`routes/mcpConnect.ts`), which
 *     imports it directly to answer `tools/list` for outside MCP clients.
 *
 * Integration-backed tools (Stripe, Gmail, ...) are NOT here — they are
 * discovered per-employee at runtime via `POST /integrations/_list`.
 *
 * When you add a tool: add its handler in `mcpInternal.ts` AND an entry here.
 * Nothing else needs to change — both transports pick it up automatically.
 */

/** A JSON-Schema object describing a tool's arguments. Intentionally loose:
 * individual tools use enums, nullable unions, nested objects, etc. */
export type McpToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type McpToolSpec = {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
};

/**
 * Shared attachment schema for the native mail compose tools (`create_mail_draft`,
 * `send_mail`). Files are named by slug — the server reads the bytes itself, so no
 * base64 ever crosses the model. Each item is exactly one of: a Resource
 * (`resourceSlug`, optionally reformatted) or an invoice (`invoiceSlug`, rendered
 * to a PDF on the fly, gated on the caller's finance access).
 */
const MAIL_ATTACHMENTS_PROPERTY = {
  type: "array",
  maxItems: 10,
  description:
    "Optional files to attach. Give each item exactly one of `resourceSlug` (a Resource, from list_resources) or `invoiceSlug` (an invoice rendered as a PDF, from the finance tool's list_invoices — needs finance access). The server reads the bytes; do not paste base64. Total attachment size is capped around 3 MB.",
  items: {
    type: "object",
    properties: {
      resourceSlug: {
        type: "string",
        description: "Attach this Resource, by slug from list_resources / search_resources.",
      },
      invoiceSlug: {
        type: "string",
        description:
          "Attach this invoice as a PDF, by slug from the finance tool (op list_invoices). Handy for replying to a billing thread with the invoice attached.",
      },
      format: {
        type: "string",
        enum: ["original", "pdf", "html", "md", "txt"],
        description:
          "For `resourceSlug` only. Defaults to 'original' (the uploaded file byte-for-byte). Do not pass 'pdf' for a resource that is already a PDF.",
      },
      filename: {
        type: "string",
        description: "Optional. Overrides the filename the recipient sees.",
      },
    },
    additionalProperties: false,
  },
} as const;

const MARKETING_CAMPAIGN_PROPERTIES = {
  name: { type: "string", description: "Human-readable Campaign name." },
  objective: {
    type: "string",
    enum: ["awareness", "traffic", "leads", "sales", "retention"],
  },
  status: {
    type: "string",
    enum: ["draft", "ready", "active", "paused", "completed", "archived"],
  },
  autonomyMode: {
    type: "string",
    enum: ["observe", "optimize", "autonomous"],
    description:
      "observe = report only; optimize = propose/perform safe levers; autonomous = operate inside policy and Connection guardrails.",
  },
  channel: {
    type: "string",
    description: "Provider id such as google-ads, meta-ads, or browser-managed.",
  },
  connectionId: { type: ["string", "null"] },
  externalAccountId: { type: "string" },
  externalCampaignId: {
    type: "string",
    description: "Required before status can become active.",
  },
  ownerEmployeeId: { type: ["string", "null"] },
  brief: { type: "string", description: "Strategy, constraints, and positioning in markdown." },
  audience: {
    type: "string",
    description: "The target audience and exclusions. Never include PII.",
  },
  offer: { type: "string" },
  landingPageUrl: { type: "string" },
  successMetric: { type: "string", description: "Primary KPI, e.g. qualified_leads or roas." },
  targetValue: { type: "string", description: "Exact decimal target as text." },
  dailyBudgetMinor: {
    type: "number",
    description: "Planned daily budget in minor currency units (e.g. cents).",
  },
  currency: { type: "string", description: "Three-letter ISO currency code." },
  startsAt: { type: ["string", "null"], description: "ISO datetime." },
  endsAt: { type: ["string", "null"], description: "ISO datetime." },
} as const;

const MARKETING_CREATIVE_PROPERTIES = {
  campaignId: { type: "string" },
  name: { type: "string" },
  format: {
    type: "string",
    enum: ["text", "image", "video", "carousel", "responsive"],
  },
  status: {
    type: "string",
    enum: ["draft", "review", "approved", "active", "retired", "rejected"],
  },
  variantGroup: {
    type: "string",
    description: "Shared label for Creative variants intended to compete.",
  },
  concept: { type: "string" },
  headline: { type: "string" },
  body: { type: "string" },
  callToAction: { type: "string" },
  assetUrl: { type: "string", description: "Company-controlled asset or Resource URL." },
  destinationUrl: { type: "string" },
  externalCreativeId: { type: "string" },
  reviewNote: { type: "string" },
} as const;

const MARKETING_EXPERIMENT_PROPERTIES = {
  campaignId: { type: "string" },
  name: { type: "string" },
  hypothesis: { type: "string" },
  status: { type: "string", enum: ["draft", "running", "decided", "stopped"] },
  primaryMetric: { type: "string" },
  minimumSampleSize: { type: "string", description: "Decision threshold as exact text." },
  creativeIds: {
    type: "array",
    items: { type: "string" },
    minItems: 2,
    maxItems: 20,
  },
  winnerCreativeId: { type: ["string", "null"] },
  decisionRationale: { type: "string" },
  startsAt: { type: ["string", "null"] },
  endsAt: { type: ["string", "null"] },
} as const;

const REVENUE_BULK_TARGET_PROPERTY = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, maxItems: 5000 },
    followUpIds: {
      type: "array",
      maxItems: 5000,
      items: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["task", "deal", "partnership"] },
          id: { type: "string" },
        },
        required: ["source", "id"],
        additionalProperties: false,
      },
    },
    filter: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["all", "overdue", "today", "upcoming"] },
        q: { type: "string" },
        includeArchived: { type: "boolean" },
        ownerId: { type: "string" },
        ownerEmployeeId: { type: "string" },
        assignedUserId: { type: "string" },
        assignedEmployeeId: { type: "string" },
        unassigned: { type: "boolean" },
        accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
        lifecycleStage: {
          type: "string",
          enum: [
            "subscriber",
            "lead",
            "qualified",
            "opportunity",
            "customer",
            "churned",
            "unqualified",
          ],
        },
        dealStatus: { type: "string", enum: ["open", "won", "lost"] },
        dealStageId: { type: "string" },
        partnershipStatus: { type: "string" },
        source: { type: "string", enum: ["task", "deal", "partnership"] },
        followUpSource: { type: "string", enum: ["task", "deal", "partnership"] },
        status: { type: "string", enum: ["open", "completed", "cancelled"] },
        taskStatus: { type: "string", enum: ["open", "completed", "cancelled"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        linkedResourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        linkedResourceId: { type: "string" },
        dueFrom: { type: "string" },
        dueTo: { type: "string" },
        reminderFrom: { type: "string" },
        reminderTo: { type: "string" },
        overdueMinDays: { type: "integer", minimum: 0, maximum: 36500 },
        overdueMaxDays: { type: "integer", minimum: 0, maximum: 36500 },
        staleBefore: { type: "string" },
        createdBefore: { type: "string" },
        closedDeals: { type: "string", enum: ["include", "only", "exclude"] },
        archivedResources: { type: "string", enum: ["include", "only", "exclude"] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const REVENUE_BULK_ACTION_PROPERTY = {
  type: "object",
  description:
    "One action. Required fields by type: assign_owner(ownerId, ownerEmployeeId); set_contact_lifecycle(lifecycleStage); set_account_status(accountStatus); set_custom_fields(values); update_standard_fields(confirm plus shared values or per-record rows); archive(archived); move_deal_stage(stageId and lostReason when the destination is Closed Lost); update_follow_up(at least one patch field).",
  properties: {
    type: {
      type: "string",
      enum: [
        "assign_owner",
        "set_contact_lifecycle",
        "set_account_status",
        "set_custom_fields",
        "update_standard_fields",
        "archive",
        "move_deal_stage",
        "update_follow_up",
      ],
    },
    ownerId: { type: ["string", "null"] },
    ownerEmployeeId: { type: ["string", "null"] },
    lifecycleStage: {
      type: "string",
      enum: [
        "subscriber",
        "lead",
        "qualified",
        "opportunity",
        "customer",
        "churned",
        "unqualified",
      ],
    },
    accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
    values: { type: "object", additionalProperties: true },
    rows: {
      type: "array",
      maxItems: 5000,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          values: { type: "object", additionalProperties: true },
        },
        required: ["id", "values"],
        additionalProperties: false,
      },
    },
    confirm: { type: "string", enum: ["UPDATE_STANDARD_FIELDS"] },
    notesMode: { type: "string", enum: ["replace", "append", "clear"] },
    archived: { type: "boolean" },
    stageId: { type: "string" },
    lostReason: { type: "string" },
    taskStatus: { type: "string", enum: ["open", "completed", "cancelled"] },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    assignedUserId: { type: ["string", "null"] },
    assignedEmployeeId: { type: ["string", "null"] },
    dueAt: { type: ["string", "null"] },
    reminderAt: { type: ["string", "null"] },
  },
  required: ["type"],
  additionalProperties: false,
} as const;

const HISTORICAL_DEAL_ROWS_PROPERTY = {
  type: "array",
  maxItems: 200,
  items: {
    type: "object",
    properties: {
      sourceRecordId: { type: "string" },
      dealId: { type: "string" },
      historyCompleteness: {
        type: "string",
        enum: ["complete", "partial", "snapshot_only"],
      },
      originalCreatedAt: { type: "string", description: "Original ISO creation datetime." },
      initialStageId: { type: ["string", "null"] },
      snapshotAt: { type: "string", description: "Effective ISO snapshot datetime." },
      events: {
        type: "array",
        maxItems: 2000,
        items: {
          type: "object",
          properties: {
            sourceEventId: { type: "string" },
            eventType: {
              type: "string",
              enum: [
                "stage_changed",
                "amount_changed",
                "owner_changed",
                "expected_close_changed",
                "won",
                "lost",
              ],
            },
            effectiveAt: { type: "string", description: "ISO effective datetime." },
            fromStageId: { type: ["string", "null"] },
            toStageId: { type: ["string", "null"] },
            fromAmountCents: { type: ["integer", "null"] },
            toAmountCents: { type: ["integer", "null"] },
            fromCurrency: { type: ["string", "null"] },
            toCurrency: { type: ["string", "null"] },
            currency: { type: "string" },
            fromOwnerId: { type: ["string", "null"] },
            fromOwnerEmployeeId: { type: ["string", "null"] },
            toOwnerId: { type: ["string", "null"] },
            toOwnerEmployeeId: { type: ["string", "null"] },
            fromExpectedCloseDate: { type: ["string", "null"] },
            toExpectedCloseDate: { type: ["string", "null"] },
            lostReason: { type: "string" },
            sourceActor: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["sourceEventId", "eventType", "effectiveAt"],
          additionalProperties: false,
        },
      },
    },
    required: ["sourceRecordId", "dealId", "historyCompleteness", "events"],
    additionalProperties: false,
  },
} as const;

const REVENUE_IMPORT_ROWS_PROPERTY = {
  type: "array",
  minItems: 1,
  maxItems: 1_000,
  items: {
    type: "object",
    properties: {
      sourceId: {
        type: "string",
        description: "Stable source-system row identifier, unique inside this import.",
      },
      values: {
        type: "object",
        description: "Source field names mapped to scalar or structured source values.",
        additionalProperties: true,
      },
    },
    required: ["sourceId", "values"],
    additionalProperties: false,
  },
} as const;

const REVENUE_IMPORT_SOURCE_PROPERTIES = {
  sourceKind: { type: "string", enum: ["csv", "json", "connection"] },
  sourceLabel: { type: "string" },
  sourceConnectionId: {
    type: "string",
    description:
      "Required for connection sources and forbidden otherwise. The AI Employee needs a Grant to it.",
  },
  rows: REVENUE_IMPORT_ROWS_PROPERTY,
} as const;

const LINKED_REVENUE_IMPORT_MAPPING_PROPERTY = {
  type: "object",
  properties: {
    account: { type: "object", additionalProperties: { type: "string" } },
    contact: { type: "object", additionalProperties: { type: "string" } },
    deal: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["account", "contact", "deal"],
  additionalProperties: false,
} as const;

export const STATIC_TOOLS: McpToolSpec[] = [
  {
    name: "get_self",
    description:
      "Return your own employee profile (id, name, slug, role) and the company you belong to. Call this first when you need to orient yourself.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_employees",
    description:
      "List every AI employee in this company — useful for finding a teammate to delegate work to, or to answer questions about the team.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_skills",
    description:
      "List the Skill playbooks attached to an AI employee. Pass `employeeSlug` to inspect a teammate; omit it to list your own. The returned `body` is the full markdown playbook.",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the target employee. Defaults to yourself.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_skill",
    description:
      "Create a new Skill (playbook) for an AI employee. Use this when a teammate asks you to codify a reusable recipe — e.g. 'Record Revenue', 'Triage Bug Report', 'Weekly Report' — so it can be referenced by name later instead of re-explained each time. `body` is the markdown playbook (triggers, steps, notes). If omitted a starter template is written in. Genosyn uses 'Skill' — never 'Tool' or 'Capability' — for these.",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the employee who will own the skill. Defaults to yourself.",
        },
        name: {
          type: "string",
          description: "Short human-readable name, e.g. 'Record Revenue'.",
        },
        toolset: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional. Model-facing tool names this playbook uses (e.g. ["send_invoice", "record_payment"]). Declared tools are loaded up-front for any turn where this Skill applies, so you never have to look them up. Declaring a tool does not grant access to it — Grants are still checked when it is called.',
        },
        body: {
          type: "string",
          description:
            "Optional markdown playbook. Convention: `## When to use it`, `## Steps`, `## Notes`.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_skill",
    description:
      "Update an existing Skill's name or body. Use this to revise a playbook after learning something new, not for trivial typo fixes. Pass the `skillId` UUID from `list_skills`.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "UUID from `list_skills`." },
        name: { type: "string" },
        toolset: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional. Model-facing tool names this playbook uses (e.g. ["send_invoice", "record_payment"]). Declared tools are loaded up-front for any turn where this Skill applies, so you never have to look them up. Declaring a tool does not grant access to it — Grants are still checked when it is called.',
        },
        body: { type: "string", description: "Replacement markdown playbook." },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_skill",
    description:
      "Remove a Skill from an AI employee. Use sparingly — only when the playbook is definitively obsolete. Pass the `skillId` UUID from `list_skills`.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string" },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_routines",
    description:
      "List Routines (scheduled recurring AI work) for an employee. Pass `employeeSlug` to inspect a teammate; omit it to list your own.",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the target employee. Defaults to yourself.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_routine",
    description:
      "Create a new Routine for an AI employee. A Routine is a recurring piece of work scheduled via a cron expression. Use this when a teammate (human or AI) asks you to set up a recurring report, check-in, or scheduled task. Genosyn deliberately uses 'Routine' — never 'Task' — for this scheduled work.",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the employee who will own the routine. Defaults to yourself.",
        },
        name: {
          type: "string",
          description: "Short human-readable name, e.g. 'Weekly revenue report'.",
        },
        cronExpr: {
          type: "string",
          description:
            "5-field cron expression (minute hour day-of-month month day-of-week). Examples: '0 9 * * 1' = every Monday at 9:00, '*/15 * * * *' = every 15 minutes.",
        },
        brief: {
          type: "string",
          description:
            "Optional markdown brief describing what the routine should do on each run. If omitted a starter template is written in.",
        },
        tags: {
          type: "string",
          description:
            "Optional comma-separated tags, e.g. 'finance, weekly'. Tags are shared across the company; any that don't exist yet are created.",
        },
      },
      required: ["name", "cronExpr"],
      additionalProperties: false,
    },
  },
  {
    name: "update_routine",
    description:
      "Update an existing Routine's name, cron schedule, brief, tags, or enabled state. Use this to edit or pause a routine in place — never create a duplicate routine to work around an outdated one. Pass the `routineId` UUID from `list_routines`; only the fields you pass change.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string", description: "UUID from `list_routines`." },
        name: { type: "string" },
        cronExpr: {
          type: "string",
          description:
            "5-field cron expression (minute hour day-of-month month day-of-week). Examples: '0 9 * * 1' = every Monday at 9:00, '*/15 * * * *' = every 15 minutes.",
        },
        brief: {
          type: "string",
          description: "Replacement markdown brief describing what the routine does on each run.",
        },
        tags: {
          type: "string",
          description:
            "Comma-separated tags, e.g. 'finance, weekly'. Replaces the routine's whole tag set — pass an empty string to clear them, omit to leave them unchanged. Any tags that don't exist yet are created.",
        },
        enabled: {
          type: "boolean",
          description:
            "false pauses the routine without deleting it (run history is kept); true resumes it.",
        },
      },
      required: ["routineId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_routine",
    description:
      "Delete a Routine and its run history. Use sparingly — prefer `update_routine` with `enabled: false` to pause work that might come back. Pass the `routineId` UUID from `list_routines`.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string", description: "UUID from `list_routines`." },
      },
      required: ["routineId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List every Project (task manager container) you have access to. Projects hold Todos. Most projects are open to everyone in the company, but a human can restrict one to a named list of people and AI employees — a project you were not given access to simply will not appear here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_project",
    description:
      "Create a new Project (a container for Todos). Check `list_projects` first — a project with this name may already exist that you do not have access to. Choose a short uppercase key (e.g. 'ENG' or 'OPS') used to prefix todo numbers; the server derives one from the name if you omit it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name, e.g. 'Engineering'." },
        description: { type: "string", description: "One-line summary." },
        key: {
          type: "string",
          description: "Short uppercase key (1–6 chars, alphanumeric). Optional.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_todos",
    description: "List the Todos in a Project, by project slug.",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string", description: "Slug of the project (e.g. 'engineering')." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_todo",
    description:
      "Add a Todo to a Project you can edit. Defaults the assignee to yourself so you can take ownership of follow-through; pass `assigneeEmployeeSlug` to delegate, or `null` to leave it unassigned. Pass `reviewerEmployeeSlug` to nominate a reviewer — when the assignee marks the todo `in_review`, that reviewer is expected to sign it off. To break a big todo into steps, pass `parentTodoId` to create a subtask (one level deep; subtasks keep their own status and assignee).",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        assigneeEmployeeSlug: {
          type: ["string", "null"],
          description: "Slug of the assignee employee, or null to unassign.",
        },
        reviewerEmployeeSlug: {
          type: ["string", "null"],
          description:
            "Slug of the AI employee who should review this todo when it moves to in_review. Null = no reviewer yet.",
        },
        dueAt: {
          type: ["string", "null"],
          description: "Due date as an ISO-8601 timestamp, or null.",
        },
        recurrence: {
          type: "string",
          enum: ["none", "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"],
        },
        parentTodoId: {
          type: ["string", "null"],
          description:
            "UUID of the parent todo to nest this one under as a subtask. The parent must be in the same project and must not be a subtask itself.",
        },
      },
      required: ["projectSlug", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_todo",
    description:
      'Update a Todo by id, in a Project you can edit — change status, priority, title, description, assignee, reviewer, or due date. When you finish work on a todo assigned to you, set `status: "in_review"` (and optionally set `reviewerEmployeeSlug`) so a reviewer can sign it off instead of marking it done yourself.',
    inputSchema: {
      type: "object",
      properties: {
        todoId: { type: "string", description: "UUID of the todo." },
        title: { type: "string" },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        assigneeEmployeeSlug: { type: ["string", "null"] },
        reviewerEmployeeSlug: {
          type: ["string", "null"],
          description:
            "Slug of the AI employee who should review this todo, or null to clear. Set this when you move a todo to `in_review`.",
        },
        dueAt: { type: ["string", "null"] },
        parentTodoId: {
          type: ["string", "null"],
          description:
            "UUID of the parent todo to nest this one under as a subtask, or null to promote it back to a top-level todo.",
        },
      },
      required: ["todoId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_journal",
    description:
      "List recent Journal entries for an AI employee (runs, system events, and notes). Omit `employeeSlug` to list your own.",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_journal_entry",
    description:
      "Write a free-form note into your own Journal. Use this to log decisions, observations, or summaries a human might read later. The journal is an append-only feed; the last ~7 days are auto-injected into every prompt you receive, so future-you will see this.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_memory",
    description:
      "List your own Memory items — durable facts/preferences you previously saved. These are already injected into every prompt; use this tool when you need exact ids to update or delete them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_memory",
    description:
      "Save a durable fact into your own Memory so future prompts automatically recall it. Use this for preferences, stable context about teammates, conventions, or learnings that should influence every future conversation. Keep `title` under ~100 chars — it's the memory headline. `body` is optional elaboration.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short fact headline, e.g. 'Prefers ARR over MRR'.",
        },
        body: {
          type: "string",
          description: "Optional elaboration or reasoning.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_memory",
    description:
      "Update an existing Memory item's title or body. Use when a previously-saved fact has evolved, not for small typo fixes.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "UUID from list_memory." },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_memory",
    description:
      "Remove a Memory item. Use sparingly — only when the fact is definitively wrong or obsolete.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_bases",
    description:
      "List every Base (Airtable-style structured data workspace) you have been granted access to. Each base contains tables; use `get_base` to inspect their schema.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_base",
    description:
      "Return the full schema of a Base you have access to — its active tables, fields, and field types. Archived tables are omitted until a Member restores them. Pass `baseSlug` from `list_bases`. Use this before reading or writing rows so you know the field ids.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string", description: "Slug of the base (e.g. 'crm')." },
      },
      required: ["baseSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_base",
    description:
      "Create a new Base (Airtable-style structured-data workspace) in this company. Use this when a teammate asks for a new place to store tabular data — CRM, revenue tracker, content calendar, etc. The base starts empty; add tables with `create_base_table` and fields with `add_base_field`. Access is auto-granted to you (the creator) so the base appears in your `list_bases` immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name, e.g. 'Revenue' or 'CRM'.",
        },
        description: {
          type: "string",
          description: "One-line description shown on the base card.",
        },
        icon: {
          type: "string",
          description:
            "Optional lucide-react icon name (e.g. 'LineChart'). Defaults to 'Database'.",
        },
        color: {
          type: "string",
          enum: ["indigo", "emerald", "amber", "rose", "sky", "violet", "slate"],
          description: "Accent color. Defaults to 'indigo'.",
        },
        templateId: {
          type: "string",
          description:
            "Optional template id (e.g. 'blank', 'crm'). Seeds starter tables, fields, and sample rows. Omit to start empty.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "create_base_table",
    description:
      "Add a new table to a Base you have access to. A seed primary 'Name' text field is created automatically so the table is immediately writable; add more fields with `add_base_field`. Returns the new table's slug.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string", description: "Slug of the target base." },
        name: {
          type: "string",
          description: "Human-readable table name, e.g. 'Snapshots' or 'Customers'.",
        },
      },
      required: ["baseSlug", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_base_table",
    description: "Rename a table inside a Base.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string", description: "Current slug of the table." },
        name: { type: "string", description: "New display name." },
      },
      required: ["baseSlug", "tableSlug", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_base_table",
    description:
      "Delete an active table from a Base, along with all of its fields, rows, comments, views, and attachments. Archived tables are inaccessible to AI Employees. Irreversible — confirm with a human first when uncertain.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
      },
      required: ["baseSlug", "tableSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "add_base_field",
    description:
      "Add a field (column) to a table. Supported types: text, longtext, number, checkbox, date, datetime, email, url, select, multiselect, link, plus the record-link types customer, invoice, project, employee, member, note, pipeline. For `select` / `multiselect`, pass `options` as an array of `{label, color}` — option ids are generated server-side. For `link`, pass `linkTargetTableSlug` to point at a sibling table in the same base. Record-link types need no extra config: they always point at this company's records of that product (finance Customers, Invoices, task Projects, AI Employees, human Members, Notes, Pipelines), and cells hold arrays of ids — valid ids come back as `resourceOptions` on `list_base_rows`. Set `isPrimary: true` to make this the primary field (demotes any previous primary).",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        name: { type: "string", description: "Field display name." },
        type: {
          type: "string",
          enum: [
            "text",
            "longtext",
            "number",
            "checkbox",
            "date",
            "datetime",
            "email",
            "url",
            "select",
            "multiselect",
            "link",
            "customer",
            "invoice",
            "project",
            "employee",
            "member",
            "note",
            "pipeline",
          ],
        },
        options: {
          type: "array",
          description: "select/multiselect options.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              color: {
                type: "string",
                enum: ["indigo", "emerald", "amber", "rose", "sky", "violet", "slate"],
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        linkTargetTableSlug: {
          type: "string",
          description: "For link fields: slug of the target table in the same base.",
        },
        isPrimary: { type: "boolean" },
      },
      required: ["baseSlug", "tableSlug", "name", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "update_base_field",
    description:
      "Rename a field, mark it as the primary field, or replace its `options` (select/multiselect). Changing field `type` is not supported — delete and recreate if needed. Replacing options removes any option ids not present in the new list; existing row cells referencing removed options are silently orphaned.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        fieldId: { type: "string", description: "UUID from `get_base`." },
        name: { type: "string" },
        isPrimary: { type: "boolean" },
        options: {
          type: "array",
          description:
            "Replacement select/multiselect options. Include existing ids to preserve them.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Existing option id. Omit to create a new one." },
              label: { type: "string" },
              color: {
                type: "string",
                enum: ["indigo", "emerald", "amber", "rose", "sky", "violet", "slate"],
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      required: ["baseSlug", "tableSlug", "fieldId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_base_field",
    description:
      "Delete a field from a table. Fails if the field is the table's primary field — promote another field first via `update_base_field`. Values stored in that field are stripped from every row.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        fieldId: { type: "string" },
      },
      required: ["baseSlug", "tableSlug", "fieldId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_base_rows",
    description:
      "Read rows from a table inside a Base. Returns fields, records, link-option labels, and a `pagination` object with the table's `total` row count so you can tell a short page from the end of the table. Rows sort by the table's manual order, which new rows are appended to — so the newest row is last in `asc` (the default) and first in `desc`. To read the most recent row, pass `{limit: 1, order: \"desc\"}` rather than fetching everything and scanning for it. Defaults to 100 rows; pass `limit` up to 500 and `offset` to page. Link options are capped at 200 per target table — call `list_base_rows` on that table directly if you need more. Record-link fields (customer, invoice, project, employee, member, note, pipeline) resolve through `resourceOptions`: a map from field type to `{id, label, sublabel}` entries — use those ids when writing such cells.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Rows to skip before reading. Defaults to 0.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description:
            "Sort direction over the table's manual row order. Defaults to `asc` (oldest first). Use `desc` for newest first.",
        },
      },
      required: ["baseSlug", "tableSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_base_row",
    description:
      "Insert a new row into a Base table. `data` is a map from field id → value. Call `get_base` first if you need field ids. Select/multiselect values use option ids; link values are arrays of target row ids; record-link fields (customer, invoice, project, employee, member, note, pipeline) take arrays of ids from `list_base_rows`'s `resourceOptions`.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        data: {
          type: "object",
          description: "Map from field id to cell value.",
          additionalProperties: true,
        },
      },
      required: ["baseSlug", "tableSlug", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "update_base_row",
    description:
      "Update specific cells on an existing row. `data` is a partial map from field id → value. Setting a value to null/empty clears that cell.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        rowId: { type: "string", description: "UUID of the row." },
        data: { type: "object", additionalProperties: true },
      },
      required: ["baseSlug", "tableSlug", "rowId", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_base_row",
    description: "Delete a row from a Base table by id.",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        rowId: { type: "string" },
      },
      required: ["baseSlug", "tableSlug", "rowId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_workspace_channels",
    description:
      "List the workspace-chat channels you can see in this company (public channels, plus any private channels you're a member of). DMs are excluded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_workspace_channel",
    description:
      "Create a new workspace channel. You'll be added as a member on create. Default is `public` — everyone in the company can join. Pass `kind: 'private'` if the conversation should be invite-only. Use this when a teammate asks you to spin up a space for a project or topic.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short channel name, e.g. 'revenue-weekly'.",
        },
        topic: {
          type: "string",
          description: "Optional one-line topic shown in the channel header.",
        },
        kind: {
          type: "string",
          enum: ["public", "private"],
          description: "Defaults to 'public'.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_workspace_channel",
    description:
      "Rename a workspace channel and/or update its topic. `channel` accepts either the channel slug (preferred) or its UUID. Pass at least one of `name` or `topic`. DMs can't be renamed.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel slug (e.g. 'revenue') or UUID from list_workspace_channels.",
        },
        name: { type: "string" },
        topic: { type: "string" },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_workspace_channel",
    description:
      "Archive a workspace channel. It's hidden from the sidebar but the history is preserved. Use for abandoned or completed projects; don't archive active discussions.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel slug or UUID.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "list_teams",
    description:
      "List the Teams (org chart groupings) in this company. Each team comes with its members so you can see who's on which team and resolve `@slug` to a real teammate. Use this when a teammate references 'the eng team' or 'who's on revenue?'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_handoffs",
    description:
      "List handoffs you're involved in. Use this at the top of a chat turn or routine run to check your inbox for delegated work. Defaults to incoming pending handoffs; pass `direction: 'outgoing'` for things you delegated, `direction: 'any'` for both, and `status` to filter (pending | completed | declined | cancelled).",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["incoming", "outgoing", "any"],
          description: "Defaults to 'incoming'.",
        },
        status: {
          type: "string",
          enum: ["pending", "completed", "declined", "cancelled"],
        },
        limit: {
          type: "number",
          description: "Max rows to return (1–200, default 50).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_handoff",
    description:
      "Hand a piece of work off to another AI employee. The receiver picks it up at the start of their next chat turn or routine run via list_handoffs. Pass `toEmployee` (slug or UUID) for an explicit handoff, or `toManager: true` to send it up your reporting line. Use this when something is genuinely outside your remit — don't fire-and-forget routine work, do the work yourself.",
    inputSchema: {
      type: "object",
      properties: {
        toEmployee: {
          type: "string",
          description: "Slug (preferred) or UUID of the receiving employee.",
        },
        toManager: {
          type: "boolean",
          description:
            "If true, hand off to your `reportsTo` employee. Errors if you don't have a manager set.",
        },
        title: {
          type: "string",
          description: "Short summary, e.g. 'Investigate Stripe webhook 500s'.",
        },
        body: {
          type: "string",
          description:
            "Markdown brief: context, what you've already tried, what success looks like, links.",
        },
        dueAt: {
          type: "string",
          description: "Optional ISO-8601 deadline. The receiver sees this in their inbox.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_handoff",
    description:
      "Mark a handoff you received as completed. Pass a `resolutionNote` describing what you did so the sender has the trail. Only the receiver can complete; only pending handoffs can transition.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string", description: "UUID from list_handoffs." },
        resolutionNote: {
          type: "string",
          description: "Markdown summary of what you did.",
        },
      },
      required: ["handoffId"],
      additionalProperties: false,
    },
  },
  {
    name: "decline_handoff",
    description:
      "Decline a handoff you received. Pass a `resolutionNote` explaining why so the sender can re-route. Only the receiver can decline; only pending handoffs can transition.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string", description: "UUID from list_handoffs." },
        resolutionNote: {
          type: "string",
          description: "Reason for declining (e.g. 'Out of scope; ask @bob-pm').",
        },
      },
      required: ["handoffId"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_handoff",
    description:
      "Retract a handoff you sent that hasn't been picked up yet. Use when the work no longer matters (priority shifted, problem resolved upstream). Only the sender can cancel; only pending handoffs can transition.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string", description: "UUID from list_handoffs." },
        resolutionNote: {
          type: "string",
          description: "Optional reason for cancelling.",
        },
      },
      required: ["handoffId"],
      additionalProperties: false,
    },
  },
  {
    name: "send_workspace_message",
    description:
      "Post a message into the workspace chat — a public/private channel, a DM with another AI employee, or a DM with a human Member. Specify exactly one of `channel`, `dmEmployee`, or `dmUser`. If you @mention another employee by slug (e.g. 'can you take this @bob-pm?'), they will be auto-invited to public channels and reply on their own. Posts into a public channel auto-add you as a member; private channels require an existing membership. Use this for proactive updates (standups, status, handoffs) — don't spam, every message costs tokens for any employee asked to reply.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            "Channel slug (e.g. 'engineering') or UUID. For public/private channels only — DMs use `dmEmployee` or `dmUser`.",
        },
        dmEmployee: {
          type: "string",
          description:
            "Slug or UUID of another AI employee in the company. Opens (or reuses) a 1:1 DM with them and posts.",
        },
        dmUser: {
          type: "string",
          description:
            "UUID of a human Member of this company. Opens (or reuses) a 1:1 DM with them and posts. Get IDs from the company directory.",
        },
        content: {
          type: "string",
          description:
            "The message body. Markdown is rendered. Use @employee-slug to ping another AI; they'll be auto-added to public channels and reply.",
        },
        parentMessageId: {
          type: "string",
          description:
            "Optional UUID of a message you're replying to (threaded). Omit for a top-level post.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notebooks",
    description:
      "List Notebooks for this company. Notebooks are the top-level grouping for Notes (every Note lives in exactly one Notebook). Use this to discover where the team files different kinds of pages — runbooks, briefs, post-mortems — before creating a new note.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description:
      "List Notes (Notion-style markdown pages) for this company. Notes are a shared knowledge base — both humans and AI employees can read and write. Use this to discover what context the team has captured before answering a question, or to find a page to update. Archived (trashed) notes are excluded by default; pass `includeArchived: true` to include them. Pass `notebookSlug` to scope to one notebook, or `parentSlug` to list direct children of a specific page.",
    inputSchema: {
      type: "object",
      properties: {
        notebookSlug: {
          type: "string",
          description:
            "Optional. Slug of a notebook — only notes in that notebook are returned. See list_notebooks.",
        },
        parentSlug: {
          type: "string",
          description: "Optional. Slug of a parent note — only direct children are returned.",
        },
        includeArchived: {
          type: "boolean",
          description: "Defaults to false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_notes",
    description:
      "Search Notes by title and body using a substring match (case-insensitive). Use this when you need to find an existing page on a topic before creating a new one — duplicating notes makes the knowledge base noisy. Returns up to 50 hits ordered by most recently edited.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to look for in titles and bodies.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_note",
    description:
      "Read a single Note by its slug, including the full markdown body. Use this when you've found a relevant note via list/search and want to read its contents in full before answering or editing.",
    inputSchema: {
      type: "object",
      properties: {
        noteSlug: {
          type: "string",
          description: "Slug from list_notes / search_notes.",
        },
      },
      required: ["noteSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_note",
    description:
      "Create a new Note (Notion-style markdown page) in this company. Use this to capture decisions, runbooks, project context, design rationale, or anything a teammate (human or AI) might want to read later. Markdown headings, lists, and links are encouraged. Pass `notebookSlug` to file the page in a specific notebook (otherwise it lands in the company's default notebook), or `parentSlug` to nest the new page underneath an existing one — useful for grouping a related cluster of pages. The note will appear in the sidebar for everyone in the company.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Page title, e.g. 'Onboarding runbook' or 'Q1 plan'.",
        },
        body: {
          type: "string",
          description: "Markdown body. Optional — empty pages are allowed.",
        },
        icon: {
          type: "string",
          description: "Optional emoji or short string shown in the sidebar (e.g. '📘').",
        },
        notebookSlug: {
          type: "string",
          description:
            "Optional. Slug of the notebook to file the page in. Defaults to the company's default notebook. Ignored when `parentSlug` is set — sub-pages inherit their parent's notebook.",
        },
        parentSlug: {
          type: "string",
          description: "Optional. Slug of the parent page for nested pages.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description:
      "Update an existing Note's title, body, icon, parent, or archived state. Use this to revise a page after learning something new — prefer editing over creating duplicates. Pass `archived: true` to move it to the trash, `archived: false` to restore. Set `parentSlug: null` to move the page back to the top level.",
    inputSchema: {
      type: "object",
      properties: {
        noteSlug: { type: "string", description: "Slug from list/search." },
        title: { type: "string" },
        body: { type: "string" },
        icon: { type: "string" },
        parentSlug: {
          type: ["string", "null"],
          description: "New parent slug, or null to move to the top level.",
        },
        archived: {
          type: "boolean",
          description: "true → move to trash; false → restore.",
        },
      },
      required: ["noteSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_note",
    description:
      "Permanently delete a Note. Use sparingly — prefer `update_note` with `archived: true` so a human can restore it from the trash if you were wrong. Direct children of the deleted note are re-parented one level up so they aren't orphaned.",
    inputSchema: {
      type: "object",
      properties: {
        noteSlug: { type: "string" },
      },
      required: ["noteSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_resources",
    description:
      "List the Resources (external material — articles, ebooks, transcripts — that the team has ingested for you to study) you have been granted access to in this company. Each row carries a title, sourceKind (url / text / pdf / epub / video), summary, tag list, and content length so you can decide whether to pull the full text via `get_resource`. Distinct from Memory (durable facts auto-injected into your prompt) and Notes (pages the team writes together) — Resources are someone else's words, ingested for you to study.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_resources",
    description:
      "Search Resources by title, summary, tags, and full extracted text using a substring match (case-insensitive). Use before answering domain questions — the team may have ingested a primer that already covers the topic. Returns up to 50 hits ordered by most-recently-updated. Only Resources you have been granted access to are searched.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to look for in titles, summaries, tags, and body text.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_resource",
    description:
      "Read a single Resource by its slug, including the full extracted plain text. Use this after `list_resources` / `search_resources` to pull in the actual material to read. Body text is capped at 1 MiB on ingestion; longer ebooks are truncated.",
    inputSchema: {
      type: "object",
      properties: {
        resourceSlug: {
          type: "string",
          description: "Slug from list_resources / search_resources.",
        },
      },
      required: ["resourceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "export_resource",
    description:
      "Render a Resource's body in a downloadable format and return it as base64 — use this when a teammate asks for a Resource as a PDF, HTML, plain-text, or markdown file. PDFs go through Chromium so the result honours headings, tables, code blocks, and the same styling humans see in the browser, no manual layout required. The base64 in `contentBase64` plugs straight into `send_chat_attachment` (most common — the human gets a download chip on your reply) or `attach_file_to_record` (when filing the deliverable on a Base row). Capped at 8 MiB per export; large EPUBs may exceed that and have to be downloaded by a human from the resource page.",
    inputSchema: {
      type: "object",
      properties: {
        resourceSlug: {
          type: "string",
          description: "Slug from list_resources / search_resources.",
        },
        format: {
          type: "string",
          enum: ["pdf", "html", "md", "txt"],
          description:
            "'pdf' for a printable document, 'html' for a styled standalone page, 'md' for the raw markdown source, 'txt' for plain text.",
        },
      },
      required: ["resourceSlug", "format"],
      additionalProperties: false,
    },
  },
  {
    name: "list_code_repositories",
    description:
      "List the Code Repositories you have been granted access to in this company. Each git repo is already checked out in your working directory at `code-repos/<slug>/`, with credentials and your committer identity configured for you — so you can `cd` into the path and use ordinary `git` to read, branch, commit, and (when your access level is `write`) push. Each row carries the repo name, slug, localPath, defaultBranch, your accessLevel (`read` / `write`), the clone URL, and the last sync status. There is no MCP tool for committing or pushing — do that with `git` inside the checkout.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_resource",
    description:
      "Add a new Resource that the team can study. Use this to capture an external URL the team should index, or to paste in a long-form note that's better filed as a Resource than a Note (e.g. a transcript, a primer, a research summary). Pass `sourceKind: 'url'` with `url` to fetch + extract a page; pass `sourceKind: 'text'` with `title` and `body` (markdown) to file a paste. The author gets `delete` access automatically (full control); teammates start at `read`. URL fetches that fail still create the row with `status: 'failed'` so a human can fix it. PDF/EPUB uploads are humans-only — use the React UI for those.",
    inputSchema: {
      type: "object",
      properties: {
        sourceKind: {
          type: "string",
          enum: ["text", "url"],
          description: "'text' for a paste, 'url' to fetch and extract.",
        },
        title: {
          type: "string",
          description: "Required for `text`; optional for `url` (defaults to the page title).",
        },
        url: {
          type: "string",
          description: "The URL to fetch. Required when sourceKind is 'url'.",
        },
        body: {
          type: "string",
          description: "Markdown content. Required when sourceKind is 'text'.",
        },
        summary: {
          type: "string",
          description:
            "Optional short summary surfaced alongside the title. Auto-generated from the body if omitted.",
        },
        tags: {
          type: "string",
          description: "Optional comma-separated tags, e.g. 'pricing, b2b'.",
        },
      },
      required: ["sourceKind"],
      additionalProperties: false,
    },
  },
  {
    name: "update_resource",
    description:
      "Update an existing Resource's title, summary, tags, or markdown body. The body can only be edited on `text`-kind resources — for PDFs/EPUBs/URLs the body is the extracted preview that has to match the original source. Requires at least `edit` access; rows you created via `create_resource` already have it. For other rows, ask a human to promote you in the share modal — they pick between View only, Can edit, and Can delete.",
    inputSchema: {
      type: "object",
      properties: {
        resourceSlug: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        tags: { type: "string" },
        body: {
          type: "string",
          description:
            "Markdown body. Only valid on text-kind resources; rejected with 400 otherwise.",
        },
      },
      required: ["resourceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_resource",
    description:
      "Permanently delete a Resource (and any uploaded bytes on disk). Requires `delete` access — strictly more than `edit`. Rows you created via `create_resource` already have it; for other rows, ask a human to promote you. There is no undo, so prefer `update_resource` to correct a mistake when possible.",
    inputSchema: {
      type: "object",
      properties: {
        resourceSlug: { type: "string" },
      },
      required: ["resourceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_base_record",
    description:
      "Open a single Base record like a form: returns the row's fields + values, every field definition for the table, the comment thread, and the list of file attachments. Use this when a teammate asks you to read or update a specific row, or before posting a comment so you know the row's context. Pair with `update_base_row` (existing) for cell edits, `create_record_comment` to discuss, and `attach_file_to_record` to drop in supporting files.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: {
          type: "string",
          description: "UUID from `list_base_rows` (the `id` field on each record).",
        },
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_record_comments",
    description:
      "List the comment thread on a Base record. Both human Members and AI Employees post into the same stream; the `author.kind` field distinguishes them. Use this before commenting so you don't duplicate context already in the thread.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: {
          type: "string",
          description: "Record UUID from `list_base_rows` / `get_base_record`.",
        },
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_record_comment",
    description:
      "Post a comment on a Base record's thread, authored by you (the AI Employee). Use this to share an analysis, flag a discrepancy, or @-summarise findings to a human teammate. Markdown is fine. Keep it concise — long monologues belong in a Note.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        body: {
          type: "string",
          description: "Comment body (markdown). 1–10000 chars.",
        },
      },
      required: ["recordId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_record_comment",
    description:
      "Delete one of your own comments on a Base record. You can only delete comments you (this AI employee) authored — humans manage their own messages from the UI.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        commentId: { type: "string" },
      },
      required: ["recordId", "commentId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_record_attachments",
    description:
      "List the files attached to a Base record, with metadata (filename, mime type, size, who uploaded). Use this before reading a file to confirm it exists and is small enough.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "attach_file_to_record",
    description:
      "Attach a file to a Base record. Provide either `contentText` (for text/markdown/CSV/JSON output you generated) OR `contentBase64` (for small binary blobs). Caps at 5 MB per AI upload; larger files have to come from a human via the UI. The attachment shows up in the record's drawer for both humans and AI to see.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        filename: {
          type: "string",
          description: "Filename including extension, e.g. 'report.csv'.",
        },
        mimeType: {
          type: "string",
          description:
            "Optional. Defaults to text/plain for contentText, application/octet-stream for contentBase64.",
        },
        contentText: {
          type: "string",
          description: "UTF-8 text content. Use for plain text, markdown, CSV, JSON, etc.",
        },
        contentBase64: {
          type: "string",
          description: "Base64-encoded bytes. Use for small binary files like PNGs.",
        },
      },
      required: ["recordId", "filename"],
      additionalProperties: false,
    },
  },
  {
    name: "read_record_attachment",
    description:
      "Read a record attachment's bytes as UTF-8 text. Useful for ingesting CSVs, JSON, markdown, or notes that a teammate dropped on a record. Caps at the `maxBytes` argument (default 256 KiB) — larger files return an error so you don't blow your context window. Binary attachments will likely come back as garbled UTF-8; check the mime type first via `list_record_attachments`.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        attachmentId: { type: "string" },
        maxBytes: {
          type: "number",
          description: "Cap content read into the response. Default 262144 (256 KiB).",
        },
      },
      required: ["recordId", "attachmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_record_attachment",
    description:
      "Delete a file attachment you previously uploaded to a Base record. You can only delete your own uploads; human uploads have to be removed from the UI.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        attachmentId: { type: "string" },
      },
      required: ["recordId", "attachmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "send_chat_attachment",
    description:
      "Send a file to the human as part of your current chat reply. Provide either `contentText` (for text/markdown/CSV/JSON) OR `contentBase64` (for binary blobs like PDFs or images). Caps at 10 MB per upload. The file shows up as a download chip on your reply bubble; the human can click to download it. Use this whenever you generated a deliverable the human asked for — a filled PDF, a CSV report, a written document — instead of pasting it as a wall of text into your reply.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Filename including extension, e.g. 'invoice-filled.pdf'.",
        },
        mimeType: {
          type: "string",
          description:
            "Optional. Defaults to text/plain for contentText, application/octet-stream for contentBase64. Use 'application/pdf' for PDFs.",
        },
        contentText: {
          type: "string",
          description: "UTF-8 text content. Use for plain text, markdown, CSV, JSON, etc.",
        },
        contentBase64: {
          type: "string",
          description: "Base64-encoded bytes. Use for PDFs and other binary files.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf_fields",
    description:
      "List the form fields in a PDF the human attached to chat. Returns each field's name, type (text/checkbox/radio/dropdown), current value, and (for dropdowns/radio groups) the option set. Use this BEFORE `fill_pdf_form` so you know what fields exist and what values they expect — e.g. don't guess at field names like 'Company Name' when the actual field is named 'CompanyName' or 'company_name'.",
    inputSchema: {
      type: "object",
      properties: {
        attachmentId: {
          type: "string",
          description: "Id of a chat attachment the human uploaded. PDFs only.",
        },
      },
      required: ["attachmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "fill_pdf_form",
    description:
      "Fill an existing PDF form's fields and send the result back to the human as a chat attachment. `fields` is a {fieldName: value} map — strings for text fields, booleans for checkboxes, the option string for dropdowns/radio groups. Run `read_pdf_fields` first to confirm the field names. By default the form is flattened so values are baked in; pass `flatten: false` if the human still needs to edit it.",
    inputSchema: {
      type: "object",
      properties: {
        attachmentId: {
          type: "string",
          description: "Id of the source PDF attachment the human uploaded.",
        },
        fields: {
          type: "object",
          additionalProperties: {
            type: ["string", "boolean"],
          },
          description: "Map of field name to value. Use the names from read_pdf_fields verbatim.",
        },
        outputFilename: {
          type: "string",
          description:
            "Filename for the produced PDF. Defaults to the source's name with a '-filled' suffix.",
        },
        flatten: {
          type: "boolean",
          description:
            "When true (default) values are baked in and the form can't be edited further. Set to false to leave fields editable.",
        },
      },
      required: ["attachmentId", "fields"],
      additionalProperties: false,
    },
  },
  // ---------- Explore (M20) — Metabase-style analytics ----------
  {
    name: "list_charts",
    description:
      "List every saved Chart you have access to. A Chart is a saved SQL query + visualization (table / scalar / bar / line / area / pie) bound to a postgres / mysql / clickhouse Integration Connection. You start at `read` on every chart and `write` on the ones you author; humans manage per-employee grants from the chart's share modal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_chart",
    description:
      "Fetch one Chart by slug — returns title, description, SQL, viz config, and the connection it runs against. Pair with `run_chart` to actually execute the query.",
    inputSchema: {
      type: "object",
      properties: {
        chartSlug: {
          type: "string",
          description: "Slug from list_charts.",
        },
      },
      required: ["chartSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "run_chart",
    description:
      "Execute a saved Chart and return its rows. SQL runs against the chart's bound database Connection with a 30s timeout and 5,000-row cap. Use this when a teammate asks 'what's our MRR' / 'which orgs signed up last week' — find a Chart with `list_charts`, run it, summarise the result.",
    inputSchema: {
      type: "object",
      properties: {
        chartSlug: {
          type: "string",
          description: "Slug from list_charts.",
        },
        maxRows: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Cap on rows returned (default 1000, max 5000).",
        },
      },
      required: ["chartSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_chart",
    description:
      "Author a new Chart. Use this to capture a useful query so the team can re-run it later instead of re-typing the SQL. `connectionId` is the UUID of the Integration Connection the SQL runs against — look it up via the integrations surface. `vizType` defaults to 'table'; for `scalar` the first cell of the first row is shown, for `bar` / `line` / `area` set `vizConfig.dimension` to the X-axis column and `vizConfig.measures` to one or more numeric column names. For `pie` use `dimension` + a single `measure`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Display title." },
        connectionId: {
          type: "string",
          description: "UUID of an Integration Connection (postgres / mysql / clickhouse).",
        },
        sql: { type: "string", description: "The SQL the chart runs." },
        description: {
          type: "string",
          description: "Optional short description shown next to the title.",
        },
        vizType: {
          type: "string",
          enum: ["table", "scalar", "bar", "line", "area", "pie"],
          description: "Visualization kind. Defaults to table.",
        },
        vizConfig: {
          type: "object",
          description:
            "Per-type config: bar/line/area = { dimension, measures[] }; pie = { dimension, measure }; scalar = { measure?, prefix?, suffix? }.",
          additionalProperties: true,
        },
      },
      required: ["title", "connectionId", "sql"],
      additionalProperties: false,
    },
  },
  {
    name: "update_chart",
    description:
      "Edit an existing Chart's title, description, SQL, or visualization. Pass only the fields you want to change. Requires `write` access on the chart — authors have it; teammates need a human to promote them via the share modal.",
    inputSchema: {
      type: "object",
      properties: {
        chartSlug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        sql: { type: "string" },
        vizType: {
          type: "string",
          enum: ["table", "scalar", "bar", "line", "area", "pie"],
        },
        vizConfig: { type: "object", additionalProperties: true },
      },
      required: ["chartSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_chart",
    description:
      "Permanently remove a Chart and detach it from any Dashboards it was on. Be careful — humans see the same charts you do. Requires `write` access on the chart.",
    inputSchema: {
      type: "object",
      properties: {
        chartSlug: { type: "string" },
      },
      required: ["chartSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dashboards",
    description:
      "List every Dashboard you have access to. A Dashboard is a grid of Chart cards arranged for a human reader. You start at `read` and `write` on dashboards you author; humans manage per-employee grants from the share modal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_dashboard",
    description:
      "Fetch one Dashboard by slug along with its cards and the Charts those cards reference. Use this when a teammate asks 'what's on the Revenue dashboard'.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardSlug: { type: "string" },
      },
      required: ["dashboardSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_dashboard",
    description: "Create a new empty Dashboard. Add cards afterwards with `add_dashboard_card`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "add_dashboard_card",
    description:
      "Pin a Chart onto a Dashboard. `x`/`y`/`w`/`h` position it on a 12-column grid; omit them to append a 6×4 card to the bottom. `titleOverride` lets the card show a different label than the underlying chart. Requires `write` access on the dashboard and `read` on the chart.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardSlug: { type: "string" },
        chartSlug: { type: "string" },
        x: { type: "integer", minimum: 0, maximum: 11 },
        y: { type: "integer", minimum: 0 },
        w: { type: "integer", minimum: 1, maximum: 12 },
        h: { type: "integer", minimum: 1, maximum: 40 },
        titleOverride: { type: "string" },
      },
      required: ["dashboardSlug", "chartSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_finance_accounts",
    description:
      "List the company's chart of accounts with ids, codes, names, account types, and archived state. Use these ids when reviewing transaction categories.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_finance_transactions",
    description:
      "List posted accounting transactions and every debit/credit line. Filter by review status to find work: `unreviewed` needs an AI or human check, `ai_reviewed` is waiting for final human approval, and `approved` is final. Category proposals do not affect the ledger until a human approves them.",
    inputSchema: {
      type: "object",
      properties: {
        reviewStatus: {
          type: "string",
          enum: ["unreviewed", "ai_reviewed", "approved"],
        },
        source: { type: "string", description: "Optional ledger source filter." },
        from: { type: "string", description: "Optional ISO date/datetime lower bound." },
        to: { type: "string", description: "Optional ISO date/datetime upper bound." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_finance_transaction",
    description:
      "Fetch one accounting transaction with all debit/credit lines, current review state, and any staged category proposal.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "Ledger transaction UUID." },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
  {
    name: "review_finance_transaction",
    description:
      "Semi-approve an accounting transaction as an AI employee. Inspect the full debit/credit entry first. Pass zero category changes when it is already correct, or stage expense/revenue line moves to another account of the same type. This never posts a reclassification or gives final approval: it notifies owners/admins and waits for a human decision.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "Ledger transaction UUID." },
        changes: {
          type: "array",
          maxItems: 20,
          description:
            "Proposed category changes. Omit or pass [] when the current categories are correct.",
          items: {
            type: "object",
            properties: {
              lineId: { type: "string", description: "Ledger line UUID." },
              accountId: {
                type: "string",
                description: "Proposed expense/revenue account id from list_finance_accounts.",
              },
            },
            required: ["lineId", "accountId"],
            additionalProperties: false,
          },
        },
        note: {
          type: "string",
          description: "Concise rationale and any uncertainty for the human reviewer.",
        },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_finance_report",
    description:
      "Read a live accounting report from the general ledger: profit and loss (`income_statement`), balance sheet, cash flow, trial balance, or monthly chart trends. Period reports need `from` and `to`; balance/trial balance use `asOf`.",
    inputSchema: {
      type: "object",
      properties: {
        report: {
          type: "string",
          enum: ["income_statement", "balance_sheet", "cash_flow", "trial_balance", "trends"],
        },
        from: { type: "string", description: "ISO date/datetime period start." },
        to: { type: "string", description: "ISO date/datetime period end." },
        asOf: { type: "string", description: "ISO date/datetime snapshot date." },
      },
      required: ["report"],
      additionalProperties: false,
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoices, newest first. Optionally filter by `status` (draft/sent/paid/void) or `customerSlug`. Returns compact rows (number, status, customer, totals, balance, dates); call get_invoice for line items and payments. Needs `read` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "sent", "paid", "void"] },
        customerSlug: {
          type: "string",
          description: "Filter to one customer (from list_customers).",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_invoice",
    description:
      "Fetch one invoice in full: header, customer, line items, payments, and displayed status. Needs `read` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceSlug: { type: "string", description: "The invoice slug (from list_invoices)." },
      },
      required: ["invoiceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_customers",
    description:
      "List the company's customers with ids, slugs, contact details, and default currency. Archived customers are hidden unless `includeArchived` is true. Needs `read` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_customer",
    description: "Fetch one customer with its contacts. Needs `read` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        customerSlug: { type: "string", description: "The customer slug (from list_customers)." },
      },
      required: ["customerSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_customer",
    description:
      "Create a customer to bill. Returns the new customer including its slug (use it for create_invoice). Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Customer / company name." },
        email: {
          type: "string",
          description: "Primary email — the default recipient for invoice emails.",
        },
        phone: { type: "string" },
        billingAddress: { type: "string" },
        shippingAddress: { type: "string" },
        taxNumber: { type: "string" },
        currency: { type: "string", description: "ISO 4217 code (defaults to USD)." },
        notes: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_customer",
    description:
      "Update a customer's details. Only the fields you pass change; the slug never changes on rename. Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        customerSlug: { type: "string", description: "Which customer to update." },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        billingAddress: { type: "string" },
        shippingAddress: { type: "string" },
        taxNumber: { type: "string" },
        currency: { type: "string", description: "ISO 4217 code." },
        notes: { type: "string" },
      },
      required: ["customerSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_invoice",
    description:
      "Create a DRAFT invoice for a customer with one or more line items. Amounts are integer minor units (cents); `unitPriceCents` of 5000 is $50.00. Optionally attach a `taxRateId` per line (from list_finance_accounts is NOT it — tax rates are configured by a human; omit for no tax). This does not issue or email anything — call send_invoice next. Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        customerSlug: {
          type: "string",
          description: "Who to bill (from list_customers / create_customer).",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code; defaults to the customer's currency.",
        },
        issueDate: { type: "string", description: "ISO datetime; defaults to now." },
        dueDate: { type: "string", description: "ISO datetime; defaults to 14 days after issue." },
        notes: { type: "string" },
        footer: { type: "string" },
        lines: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          description: "Invoice line items.",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unitPriceCents: {
                type: "integer",
                description: "Unit price in minor units (cents).",
              },
              taxRateId: {
                type: "string",
                description: "Optional tax-rate id configured by a human.",
              },
              productId: { type: "string", description: "Optional catalog product id." },
            },
            required: ["description", "quantity", "unitPriceCents"],
            additionalProperties: false,
          },
        },
      },
      required: ["customerSlug", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "send_invoice",
    description:
      "Issue the invoice if it is still a draft (mints its number and posts it to the ledger) and email it to the customer on file. Use this to actually bill someone. `to`/`cc` override the recipients; `attachPdf` defaults to true. Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceSlug: { type: "string" },
        message: { type: "string", description: "Optional note included in the email body." },
        attachPdf: { type: "boolean", description: "Attach the invoice PDF (default true)." },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Override recipients (defaults to the customer email).",
        },
        cc: { type: "array", items: { type: "string" }, description: "Extra CC recipients." },
      },
      required: ["invoiceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "record_payment",
    description:
      "Record a payment received against an issued invoice — this is how you mark an invoice paid. Auto-posts DR Bank / CR Accounts Receivable and flips the invoice to `paid` once payments cover the total. `amountCents` is in minor units. Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceSlug: { type: "string" },
        amountCents: {
          type: "integer",
          minimum: 1,
          description: "Amount received in minor units (cents).",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code; defaults to the invoice currency.",
        },
        paidAt: {
          type: "string",
          description: "ISO datetime the payment was received; defaults to now.",
        },
        method: { type: "string", enum: ["cash", "bank_transfer", "stripe", "lightning", "other"] },
        reference: { type: "string", description: "Payment reference / transaction id." },
        notes: { type: "string" },
      },
      required: ["invoiceSlug", "amountCents"],
      additionalProperties: false,
    },
  },
  {
    name: "void_invoice",
    description:
      "Void an issued invoice. Reverses every ledger posting tied to it (the issue and any payments) and marks it `void` — terminal. Drafts cannot be voided (delete them instead). Needs `invoice` finance access.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceSlug: { type: "string" },
      },
      required: ["invoiceSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_mail_accounts",
    description:
      "List the company mailboxes (Email section) you have been granted access to, with your access level on each: `read` (browse threads), `draft` (also write drafts, apply labels, archive, mark read), or `send` (also send mail). Call this first when asked to work with email — the account id it returns is optional for the other mail tools when you hold exactly one grant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_mail",
    description:
      "Search the whole local index of a granted mailbox — every synced message, body included. `query` is free text: terms AND together (each may match subject, participants, or body; quote for exact phrases) and Gmail-style operators work verbatim — from:, to:, subject:, label:, in:inbox|archive|sent|drafts|spam|trash, has:attachment, is:unread|read|starred, before:/after:YYYY-MM-DD. The structured filters (`from`, `to`, `after`, `before`, `label`, `unreadOnly`, `hasAttachment`) do the same thing and win over their operator twins when both appear. Searches everything except spam/trash unless `in:` says otherwise. Returns thread summaries newest-first — fetch full bodies with `get_mail_thread`.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Mail account id from `list_mail_accounts`. Optional when you have exactly one granted mailbox.",
        },
        query: {
          type: "string",
          description: "Free-text — matches subject, participants, and body.",
        },
        from: { type: "string", description: "Sender address/name substring." },
        to: { type: "string", description: "Recipient address substring." },
        after: { type: "string", description: "Only threads on/after this date (YYYY-MM-DD)." },
        before: { type: "string", description: "Only threads before this date (YYYY-MM-DD)." },
        label: {
          type: "string",
          description: "Gmail label id (INBOX, STARRED, SENT, …) or a user label name.",
        },
        unreadOnly: { type: "boolean" },
        hasAttachment: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_mail_thread",
    description:
      "Fetch one email thread with every message body (plain text), recipients, labels, drafts, and attachment metadata. `threadId` is the local thread id from `search_mail` or a handover briefing.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Local thread id." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_mail_draft",
    description:
      "Write a Gmail draft — the human-in-the-loop way to answer email: the draft lands in the thread (and the owner's Gmail Drafts) for a human to review and send. Pass `threadId` to draft a reply (recipients and subject are inferred from the thread when omitted); omit it for a fresh compose, which requires `to` and an `accountId` when you hold more than one grant. Attach files with `attachments` — a Resource by slug, or an invoice as a PDF by slug (e.g. to reply to a billing thread with the invoice PDF). Requires the `draft` access level.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Reply on this thread." },
        accountId: {
          type: "string",
          description: "Required for fresh composes with multiple grants.",
        },
        to: { type: "string", description: "Comma-separated recipients. Inferred for replies." },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string", description: "Inferred (Re: …) for replies." },
        bodyText: { type: "string", description: "Plain-text body of the draft." },
        attachments: MAIL_ATTACHMENTS_PROPERTY,
      },
      required: ["bodyText"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_mail_draft",
    description:
      "Replace fields on an existing Gmail draft. Fetch the email first with `get_mail_thread`, then pass its draft `messageId` plus every field that should change; omitted fields stay as they are. Gmail may assign a new message id, which is returned. Requires the `draft` access level.",
    inputSchema: {
      type: "object",
      properties: {
        draftMessageId: {
          type: "string",
          description: "Local message id of the existing draft.",
        },
        to: { type: "string", description: "Replacement comma-separated recipients." },
        cc: { type: "string", description: "Replacement cc recipients." },
        bcc: { type: "string", description: "Replacement bcc recipients." },
        subject: { type: "string", description: "Replacement subject." },
        bodyText: { type: "string", description: "Replacement plain-text draft body." },
      },
      required: ["draftMessageId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_mail_thread",
    description:
      "Triage a thread: mark read/unread, star/unstar, archive or move back to inbox, and apply or remove labels. `addLabels` names are created in Gmail on first use, so categorize freely (e.g. 'Support', 'Invoices'). Changes write through to Gmail immediately. Requires the `draft` access level.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        markRead: { type: "boolean" },
        markUnread: { type: "boolean" },
        star: { type: "boolean" },
        unstar: { type: "boolean" },
        archive: { type: "boolean" },
        moveToInbox: { type: "boolean" },
        addLabels: {
          type: "array",
          items: { type: "string" },
          description: "User label names to apply (created if missing).",
        },
        removeLabels: {
          type: "array",
          items: { type: "string" },
          description: "Label names or ids to remove.",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "send_mail",
    description:
      "Send email from a granted mailbox — this goes out immediately under the company's address, so only use it when the instruction explicitly allows sending; otherwise prefer `create_mail_draft`. Three forms: pass `draftMessageId` to send an existing draft; pass `threadId` (+ `bodyText`) to compose and send a reply; or pass `to` + `subject` + `bodyText` for a fresh message. Attach files with `attachments` (a Resource or an invoice PDF by slug) on the compose/reply forms. Requires the `send` access level.",
    inputSchema: {
      type: "object",
      properties: {
        draftMessageId: {
          type: "string",
          description: "Local message id of a draft to send as-is.",
        },
        threadId: { type: "string", description: "Reply on this thread." },
        accountId: {
          type: "string",
          description: "Required for fresh composes with multiple grants.",
        },
        to: { type: "string", description: "Comma-separated recipients. Inferred for replies." },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string", description: "Inferred (Re: …) for replies." },
        bodyText: { type: "string", description: "Plain-text body." },
        attachments: MAIL_ATTACHMENTS_PROPERTY,
      },
      additionalProperties: false,
    },
  },
  {
    name: "suggest_mail_actions",
    description:
      "Offer the teammate one-click action buttons in an email's AI chat. Call this once at the end of a turn when there are concrete next steps for the human — the buttons render under your reply and execute with the human's own authority, so use it to propose things beyond your grant level (e.g. a draft-level employee suggesting a send). Kinds and their required fields: `reply` opens the composer pre-filled (`threadId` for a reply, or `to` + `subject` for fresh mail; always `bodyText`); `send_draft` sends an existing draft (`messageId` of the draft); `thread_action` triages (`threadId` + `action`: markRead | markUnread | star | unstar | archive | moveToInbox | trash | applyLabel | removeLabel, `labelName` for the label ones); `open_thread` jumps to a thread (`threadId`); `hand_over` starts a Mail Handover (`threadId` + `employeeId` + `mode` + `instruction`); `create_rule` proposes an inbox rule (`rule` object). Keep it to the 1–4 most useful buttons; `label` is the button text. Requires the `read` access level. Only has an effect inside per-email AI chat — elsewhere the suggestions are dropped.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "Mail account id. Optional when you have exactly one granted mailbox.",
        },
        suggestions: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "reply",
                  "send_draft",
                  "thread_action",
                  "open_thread",
                  "hand_over",
                  "create_rule",
                ],
              },
              label: {
                type: "string",
                description: "Button text — short and imperative, e.g. 'Send the draft'.",
              },
              threadId: { type: "string", description: "Local thread id." },
              messageId: {
                type: "string",
                description: "Local message id of a draft (send_draft).",
              },
              to: {
                type: "string",
                description: "Comma-separated recipients (reply, fresh compose).",
              },
              cc: { type: "string" },
              subject: { type: "string" },
              bodyText: { type: "string", description: "Proposed body (reply)." },
              action: {
                type: "string",
                enum: [
                  "markRead",
                  "markUnread",
                  "star",
                  "unstar",
                  "archive",
                  "moveToInbox",
                  "trash",
                  "applyLabel",
                  "removeLabel",
                ],
                description: "Triage action (thread_action).",
              },
              labelName: {
                type: "string",
                description: "Label name for applyLabel / removeLabel.",
              },
              employeeId: {
                type: "string",
                description: "Employee to hand the thread to (hand_over).",
              },
              mode: {
                type: "string",
                enum: ["draft", "reply", "triage"],
                description: "Handover mode (hand_over).",
              },
              instruction: { type: "string", description: "Handover instruction (hand_over)." },
              rule: {
                type: "object",
                description: "Proposed mail rule (create_rule).",
                properties: {
                  name: { type: "string" },
                  conditions: {
                    type: "object",
                    properties: {
                      from: { type: "string" },
                      to: { type: "string" },
                      subjectContains: { type: "string" },
                      bodyContains: { type: "string" },
                      hasAttachment: { type: "boolean" },
                    },
                    additionalProperties: false,
                  },
                  actions: {
                    type: "array",
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: ["applyLabel", "markRead", "star", "archive", "handToEmployee"],
                        },
                        labelName: { type: "string" },
                        employeeId: { type: "string" },
                        instruction: { type: "string" },
                        mode: { type: "string", enum: ["draft", "reply", "triage"] },
                      },
                      required: ["type"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["name", "conditions", "actions"],
                additionalProperties: false,
              },
            },
            required: ["kind", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  },
  // ---------- Revenue (M32) — contacts, deals, activities, sequences, signals ----------
  //
  // Granular on purpose. The `op`-dispatched family shape is retired (see
  // `services/agent/tools/genosynFamilies.ts`): these tools disagree on their
  // required arguments, so a merged schema would demand nothing and bury the
  // real requirements in prose. They are all deferred — reached through
  // `find_tools` / `call_tool` — so the count costs nothing on the hot path.
  {
    name: "list_contacts",
    description:
      "List Contacts — people in the revenue system, as opposed to the billable accounts `list_customers` returns. Ordered by most recently touched, so the top of the list is who you last spoke to. Filter with `q` (name / email / employer / job title), `lifecycleStage`, `customerId`, or `ownedByMe`. Archived rows are hidden unless `includeArchived`. Call `get_contact` for one person in full, or `get_contact_timeline` for their history. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Substring match over name, email, employer and job title.",
        },
        lifecycleStage: {
          type: "string",
          enum: [
            "subscriber",
            "lead",
            "qualified",
            "opportunity",
            "customer",
            "churned",
            "unqualified",
          ],
        },
        customerId: {
          type: "string",
          description: "Only contacts attached to this billable account (a Customer id).",
        },
        ownedByMe: {
          type: "boolean",
          description: "Only contacts a human put you down as the owner of.",
        },
        customFieldKey: { type: "string" },
        customFieldValue: {
          type: "string",
          description: "Exact normalized value for customFieldKey.",
        },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_contacts",
    description:
      "Find a Contact by free text — name, email, employer, or job title, case-insensitive substring. Use this when a teammate names somebody and you need their id before doing anything else; `list_contacts` is the one to reach for when you want to browse or filter. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, e.g. 'ana@' or 'Northwind' or 'VP Eng'.",
        },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_contact",
    description:
      "Fetch one Contact in full, plus the deals still open with them. `doNotContact`, `unsubscribedAt` and `bouncedAt` on the row are the answer to 'may I email this person' — read them before drafting anything. Call `get_contact_timeline` for the conversation history. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact id from list/search_contacts." },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_contact_timeline",
    description:
      "Read everything that has happened with a Contact — emails in and out (written by mail sync on their own, so this is populated even if nobody typed anything), calls, meetings, notes, stage changes and sequence touches, newest first. By default it also folds in activity on that contact's deals, which is what a human means by 'our history with them'. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "email_in",
              "email_out",
              "call",
              "meeting",
              "note",
              "task",
              "deal_created",
              "stage_change",
              "deal_won",
              "deal_lost",
              "enrollment",
              "sequence_step",
              "unsubscribe",
              "bounce",
              "signal",
            ],
          },
          description: "Only these kinds. Omit for the whole timeline.",
        },
        includeRelatedDeals: {
          type: "boolean",
          description: "Include activity on this contact's deals. Defaults to true.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_activities",
    description:
      "Search the company-wide Revenue Activity ledger across subjects and bodies, with resource, kind, date, and actor filters. Use this for audits beyond one Contact or Deal timeline. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "email_in",
              "email_out",
              "call",
              "meeting",
              "note",
              "task",
              "deal_created",
              "stage_change",
              "deal_won",
              "deal_lost",
              "enrollment",
              "sequence_step",
              "unsubscribe",
              "bounce",
              "signal",
            ],
          },
        },
        contactId: { type: "string" },
        dealId: { type: "string" },
        customerId: { type: "string" },
        partnershipId: { type: "string" },
        from: { type: "string", description: "ISO datetime." },
        to: { type: "string", description: "ISO datetime." },
        actorUserId: { type: "string" },
        actorEmployeeId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_activity",
    description:
      "Fetch a Revenue Activity directly by id, including its resource links, author, task metadata, and machine metadata. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { activityId: { type: "string" } },
      required: ["activityId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_activity",
    description:
      "Correct the text, occurrence time, or Revenue links on a manually logged note, call, meeting, or task. Machine-derived email, stage, Sequence, and Signal history is immutable. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        activityId: { type: "string" },
        subject: { type: "string" },
        bodyText: { type: "string" },
        occurredAt: { type: "string" },
        contactId: { type: ["string", "null"] },
        dealId: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        partnershipId: { type: ["string", "null"] },
      },
      required: ["activityId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_activity",
    description:
      "Delete an incorrectly logged manual note, call, meeting, or task and recompute record recency. Machine-derived history cannot be deleted. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { activityId: { type: "string" } },
      required: ["activityId"],
      additionalProperties: false,
    },
  },
  {
    name: "export_activities",
    description:
      "Export the company-wide Revenue Activity ledger as CSV using the same search, resource, kind, date, and actor filters as `list_activities`. Returns `contentText` for `send_chat_attachment`; narrow filters if it exceeds 8 MiB. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "email_in",
              "email_out",
              "call",
              "meeting",
              "note",
              "task",
              "deal_created",
              "stage_change",
              "deal_won",
              "deal_lost",
              "enrollment",
              "sequence_step",
              "unsubscribe",
              "bounce",
              "signal",
            ],
          },
        },
        contactId: { type: "string" },
        dealId: { type: "string" },
        customerId: { type: "string" },
        partnershipId: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        actorUserId: { type: "string" },
        actorEmployeeId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_deals",
    description:
      "List Deals — one opportunity each, newest-updated first. Filter by `q` (title / description), `status` (open / won / lost), `stageId`, `customerId`, `contactId`, or `ownedByMe`. A deal's status always follows the stage it sits in; `weightedValueCents` is the amount times the stage probability. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        status: { type: "string", enum: ["open", "won", "lost"] },
        stageId: { type: "string", description: "Stage id from list_deal_stages." },
        customerId: { type: "string" },
        contactId: {
          type: "string",
          description: "Deals whose primary contact is this person.",
        },
        ownedByMe: { type: "boolean", description: "Only deals you are the owner of." },
        customFieldKey: { type: "string" },
        customFieldValue: { type: "string" },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_deal",
    description:
      "Fetch one Deal with its stage, amount, weighted value, timeline and buying committee (every contact linked to it, with their role). Use this before proposing a next step so you are working from what actually happened rather than the title. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "Deal id from list_deals / get_deal_board." },
        activityLimit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["dealId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deal_board",
    description:
      "Read the pipeline as the board a human sees: every stage in order, the open deals sitting in it, and the stage's total and probability-weighted value. This is the one call for 'what does the pipeline look like'. Needs `read` revenue access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_deal_stages",
    description:
      "List the company's deal stages in board order, with each stage's `kind` (open / won / lost) and default probability. You need a stage id to open a deal in a specific column or to move one — get it here. Moving a deal into a `won` or `lost` stage closes it. Needs `read` revenue access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_deal_stage",
    description:
      "Create a Deal Stage at the end of the company’s ordered sales process. `kind` is open, won, or lost and becomes immutable after creation because it drives Deal status. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        probability: { type: "integer", minimum: 0, maximum: 100 },
        kind: { type: "string", enum: ["open", "won", "lost"] },
        color: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_deal_stage",
    description:
      "Edit a Deal Stage’s name, forecast probability, colour, or description. Stage kind cannot be changed after creation. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        stageId: { type: "string" },
        name: { type: "string" },
        probability: { type: "integer", minimum: 0, maximum: 100 },
        color: { type: "string" },
        description: { type: "string" },
      },
      required: ["stageId"],
      additionalProperties: false,
    },
  },
  {
    name: "reorder_deal_stages",
    description:
      "Replace the Deal Stage order with the complete ordered list of stage ids. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        orderedIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 100,
        },
      },
      required: ["orderedIds"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_deal_stage",
    description:
      "Archive a Deal Stage. Refuses while open Deals still sit in it, so move them first. Historical Deals retain the archived stage. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { stageId: { type: "string" } },
      required: ["stageId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sequences",
    description:
      "List outbound Sequences — multi-step campaigns where each touch is drafted individually by a named AI employee from that contact's real context, not merged from a template. Rows carry the step count, per-status enrolment counts, the owning employee, the mailbox, and `autoSend` (off means every drafted touch waits in the review queue for a human). Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Substring match over name and description." },
        status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
        includeArchived: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_sequence",
    description:
      "Fetch one Sequence with its full brief, ordered steps, send window, and enrolment counts. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { sequenceId: { type: "string" } },
      required: ["sequenceId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_sequence",
    description:
      "Create an outbound Sequence assigned to an AI Employee and mailbox. It starts as a draft unless status is supplied; create its ladder with `replace_sequence_steps` before activating it. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
        mailAccountId: { type: "string" },
        employeeId: { type: "string" },
        brief: { type: "string" },
        autoSend: { type: "boolean" },
        stopOnReply: { type: "boolean" },
        dailyCap: { type: "integer", minimum: 0, maximum: 100000 },
        sendWindow: {
          type: ["object", "null"],
          properties: {
            days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
            startHour: { type: "integer", minimum: 0, maximum: 23 },
            endHour: { type: "integer", minimum: 0, maximum: 23 },
            timezone: { type: "string" },
          },
          required: ["days", "startHour", "endHour", "timezone"],
          additionalProperties: false,
        },
      },
      required: ["name", "mailAccountId", "employeeId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_sequence",
    description:
      "Edit a Sequence’s configuration, assignment, brief, status, caps, send window, or auto-send flag. Use `replace_sequence_steps` for the ladder. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
        mailAccountId: { type: "string" },
        employeeId: { type: "string" },
        brief: { type: "string" },
        autoSend: { type: "boolean" },
        stopOnReply: { type: "boolean" },
        dailyCap: { type: "integer", minimum: 0, maximum: 100000 },
        sendWindow: {
          type: ["object", "null"],
          properties: {
            days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
            startHour: { type: "integer", minimum: 0, maximum: 23 },
            endHour: { type: "integer", minimum: 0, maximum: 23 },
            timezone: { type: "string" },
          },
          required: ["days", "startHour", "endHour", "timezone"],
          additionalProperties: false,
        },
      },
      required: ["sequenceId"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_sequence_steps",
    description:
      "Replace a Sequence’s complete ordered step ladder. Each step carries a delay, drafting instruction, and whether it threads with the previous touch. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: { type: "string" },
        steps: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              delayDays: { type: "integer", minimum: 0, maximum: 365 },
              delayHours: { type: "integer", minimum: 0, maximum: 23 },
              instruction: { type: "string" },
              threadWithPrevious: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["sequenceId", "steps"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_sequence",
    description:
      "Archive a Sequence and stop its active enrolments. This is a terminal cleanup operation for the campaign. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { sequenceId: { type: "string" } },
      required: ["sequenceId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_signals",
    description:
      "List Signals — product-usage triggers that run a query against a connected database on a schedule and fire an action (log an activity, notify, open a deal, enrol in a sequence, or hand the payload to an AI employee). Read these to understand what is already watching the product before proposing new outreach. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Filter on the enabled flag. Omit for both.",
        },
        includeArchived: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_signal",
    description:
      "Fetch one Signal’s complete query and action configuration. The SQL can expose production schema details, so use it only for the requested administration work. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { signalId: { type: "string" } },
      required: ["signalId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_signal",
    description:
      "Create a product-usage Signal. Signals default disabled: save, test with `test_signal`, then enable after checking the result and action. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        sourceKind: { type: "string", enum: ["sql", "stripe"] },
        connectionId: { type: ["string", "null"] },
        sql: { type: "string" },
        cron: { type: "string" },
        enabled: { type: "boolean" },
        dedupeKeyColumn: { type: "string" },
        emailColumn: { type: "string" },
        domainColumn: { type: "string" },
        amountColumn: { type: "string" },
        actionKind: {
          type: "string",
          enum: ["activity", "notify", "create_deal", "enroll_sequence", "hand_to_employee"],
        },
        actionConfig: { type: ["object", "null"], additionalProperties: true },
        employeeId: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_signal",
    description:
      "Edit or enable a Signal’s query, schedule, matching columns, action, and assignee. Test query changes before enabling them. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        signalId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        sourceKind: { type: "string", enum: ["sql", "stripe"] },
        connectionId: { type: ["string", "null"] },
        sql: { type: "string" },
        cron: { type: "string" },
        enabled: { type: "boolean" },
        dedupeKeyColumn: { type: "string" },
        emailColumn: { type: "string" },
        domainColumn: { type: "string" },
        amountColumn: { type: "string" },
        actionKind: {
          type: "string",
          enum: ["activity", "notify", "create_deal", "enroll_sequence", "hand_to_employee"],
        },
        actionConfig: { type: ["object", "null"], additionalProperties: true },
        employeeId: { type: ["string", "null"] },
      },
      required: ["signalId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_signal_events",
    description:
      "Read company-wide Signal execution history, optionally filtered by Signal or event status. Rows contain the payload, resolved Contact/account/Deal links, outcome, and failure detail. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        signalId: { type: "string" },
        status: { type: "string", enum: ["new", "actioned", "ignored", "failed"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "test_signal",
    description:
      "Run a Signal query as a dry run and return up to 20 rows without writing events or consuming dedupe keys. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { signalId: { type: "string" } },
      required: ["signalId"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_signal",
    description:
      "Archive and disable a Signal while retaining its event history. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { signalId: { type: "string" } },
      required: ["signalId"],
      additionalProperties: false,
    },
  },
  {
    name: "restore_signal",
    description:
      "Restore an archived Signal. It remains disabled until explicitly enabled. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { signalId: { type: "string" } },
      required: ["signalId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_report",
    description:
      "Read a live revenue report: `overview` (MRR movement, ARR, retention, funnel, pipeline coverage, CAC and cash collected in one call), `mrr` (the monthly series — the current month is included and still moving), `funnel` (stage conversion, win rate, cycle length, coverage), or `cac` (spend, wins and unit economics per channel). `from`/`to` default to the trailing twelve months; `mrr` uses `months` instead. CAC spend is authorized budget rather than realized spend — the payload says so via `spendIsProxy`, and you should say so too when you quote it. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        report: { type: "string", enum: ["overview", "mrr", "funnel", "cac"] },
        from: { type: "string", description: "ISO date/datetime period start." },
        to: { type: "string", description: "ISO date/datetime period end." },
        months: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "For `mrr` only. How many months back. Defaults to 12.",
        },
        targetCents: {
          type: "integer",
          minimum: 0,
          description:
            "Sales target for the period, in minor units. Drives pipeline coverage on `overview` / `funnel`; omit and coverage multiples come back null rather than invented.",
        },
        grossMarginPct: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description:
            "0-100. Needed for LTV, LTV:CAC and payback on `overview` / `cac`; omit and they come back null.",
        },
      },
      required: ["report"],
      additionalProperties: false,
    },
  },
  {
    name: "list_follow_ups",
    description:
      "Query the unified follow-up queue: task Activities plus Deal and Partnership dates. Supports arbitrary/unassigned assignees, priority/status, due and reminder windows, overdue age, resource, Deal Stage/status, Account status, archived/closed resources, text search, and cursor pagination. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["all", "overdue", "today", "upcoming"] },
        q: { type: "string" },
        source: { type: "string", enum: ["task", "deal", "partnership"] },
        assignedToMe: { type: "boolean" },
        assignedUserId: { type: "string" },
        assignedEmployeeId: { type: "string" },
        unassigned: { type: "boolean" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        status: { type: "string", enum: ["open", "completed", "cancelled"] },
        linkedResourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        linkedResourceId: { type: "string" },
        dueFrom: { type: "string", description: "ISO datetime." },
        dueTo: { type: "string", description: "ISO datetime." },
        reminderFrom: { type: "string", description: "ISO datetime." },
        reminderTo: { type: "string", description: "ISO datetime." },
        overdueMinDays: { type: "integer", minimum: 0, maximum: 36500 },
        overdueMaxDays: { type: "integer", minimum: 0, maximum: 36500 },
        createdBefore: { type: "string", description: "ISO datetime." },
        staleBefore: { type: "string", description: "ISO datetime." },
        dealStageId: { type: "string" },
        dealStatus: { type: "string", enum: ["open", "won", "lost"] },
        accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
        closedDeals: { type: "string", enum: ["include", "only", "exclude"] },
        archivedResources: { type: "string", enum: ["include", "only", "exclude"] },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_follow_up_views",
    description:
      "List the company’s shared saved Follow-up filters so Members and AI Employees can triage from the same queue definitions. Needs `read` revenue access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_follow_up_view",
    description:
      "Save a named company-wide Follow-up filter covering assignee, status, priority, due/reminder/overdue ranges, linked resource, Deal/Account state, text, and archived resources. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        filters: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["all", "overdue", "today", "upcoming"] },
            q: { type: "string" },
            source: { type: "string", enum: ["task", "deal", "partnership"] },
            assignedUserId: { type: "string" },
            assignedEmployeeId: { type: "string" },
            unassigned: { type: "boolean" },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            status: { type: "string", enum: ["open", "completed", "cancelled"] },
            linkedResourceType: {
              type: "string",
              enum: ["account", "contact", "deal", "partnership"],
            },
            linkedResourceId: { type: "string" },
            dueFrom: { type: "string" },
            dueTo: { type: "string" },
            reminderFrom: { type: "string" },
            reminderTo: { type: "string" },
            overdueMinDays: { type: "integer", minimum: 0, maximum: 36500 },
            overdueMaxDays: { type: "integer", minimum: 0, maximum: 36500 },
            createdBefore: { type: "string" },
            staleBefore: { type: "string" },
            dealStageId: { type: "string" },
            dealStatus: { type: "string", enum: ["open", "won", "lost"] },
            accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
            closedDeals: { type: "string", enum: ["include", "only", "exclude"] },
            archivedResources: {
              type: "string",
              enum: ["include", "only", "exclude"],
            },
          },
          additionalProperties: false,
        },
        sortOrder: { type: "number" },
      },
      required: ["name", "filters"],
      additionalProperties: false,
    },
  },
  {
    name: "update_follow_up_view",
    description:
      "Rename, reorder, or replace the filters of a shared Follow-up view. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        viewId: { type: "string" },
        name: { type: "string" },
        filters: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["all", "overdue", "today", "upcoming"] },
            q: { type: "string" },
            source: { type: "string", enum: ["task", "deal", "partnership"] },
            assignedUserId: { type: "string" },
            assignedEmployeeId: { type: "string" },
            unassigned: { type: "boolean" },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            status: { type: "string", enum: ["open", "completed", "cancelled"] },
            linkedResourceType: {
              type: "string",
              enum: ["account", "contact", "deal", "partnership"],
            },
            linkedResourceId: { type: "string" },
            dueFrom: { type: "string" },
            dueTo: { type: "string" },
            reminderFrom: { type: "string" },
            reminderTo: { type: "string" },
            overdueMinDays: { type: "integer", minimum: 0, maximum: 36500 },
            overdueMaxDays: { type: "integer", minimum: 0, maximum: 36500 },
            createdBefore: { type: "string" },
            staleBefore: { type: "string" },
            dealStageId: { type: "string" },
            dealStatus: { type: "string", enum: ["open", "won", "lost"] },
            accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
            closedDeals: { type: "string", enum: ["include", "only", "exclude"] },
            archivedResources: {
              type: "string",
              enum: ["include", "only", "exclude"],
            },
          },
          additionalProperties: false,
        },
        sortOrder: { type: "number" },
      },
      required: ["viewId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_follow_up_view",
    description:
      "Delete a shared Follow-up view without affecting any Follow-ups. Pass confirm `DELETE`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        viewId: { type: "string" },
        confirm: { type: "string", enum: ["DELETE"] },
      },
      required: ["viewId", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "create_follow_up",
    description:
      "Schedule a real follow-up task on a Contact, Deal, account, or Partnership. Supports due/reminder dates, priority, Member or AI Employee assignment, and an iCalendar-style recurrence rule such as `FREQ=WEEKLY;INTERVAL=1`. Defaults to assigning the task to you. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        bodyText: { type: "string" },
        dueAt: { type: ["string", "null"], description: "ISO date/datetime." },
        reminderAt: { type: ["string", "null"], description: "ISO date/datetime." },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        assignedUserId: { type: ["string", "null"] },
        assignedEmployeeId: { type: ["string", "null"] },
        recurrenceRule: { type: ["string", "null"] },
        contactId: { type: ["string", "null"] },
        dealId: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        partnershipId: { type: ["string", "null"] },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    name: "update_follow_up",
    description:
      "Reschedule, reassign, complete, cancel, or edit an existing follow-up task. Completing a recurring task creates its next occurrence. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        followUpId: { type: "string" },
        subject: { type: "string" },
        bodyText: { type: "string" },
        dueAt: { type: ["string", "null"] },
        reminderAt: { type: ["string", "null"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        status: { type: "string", enum: ["open", "completed", "cancelled"] },
        assignedUserId: { type: ["string", "null"] },
        assignedEmployeeId: { type: ["string", "null"] },
        recurrenceRule: { type: ["string", "null"] },
      },
      required: ["followUpId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_accounts",
    description:
      "List account records across the whole lifecycle. These are the existing Customer rows: `prospect` accounts are not billable until an invoice exists, so never create a finance-only duplicate. Filters include status, owner, and exact custom-field value. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        status: { type: "string", enum: ["prospect", "customer", "former"] },
        ownedByMe: { type: "boolean" },
        customFieldKey: { type: "string" },
        customFieldValue: { type: "string" },
        includeArchived: {
          type: "boolean",
          description: "Include archived source Accounts in the result.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_revenue_account",
    description:
      "Create a prospect or customer account with domain, website, industry, size, owner, notes and billing status. This writes the same Customer entity Finance uses, so a future invoice links to this row without migration. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
        domain: { type: "string" },
        websiteUrl: { type: "string" },
        industry: { type: "string" },
        employeeCount: { type: "integer", minimum: 0 },
        currency: { type: "string" },
        annualContractValueCents: { type: "integer", minimum: 0 },
        notes: { type: "string" },
        ownerId: { type: ["string", "null"] },
        ownerEmployeeId: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_account",
    description:
      "Fetch one account with its Contacts, Deals, typed custom fields and formal documents. Works for prospects and billed customers because both share the Customer entity. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" } },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_revenue_account",
    description:
      "Enrich or reassign an existing prospect/customer account. Pass only changed fields. Domain duplicates are refused. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        accountStatus: { type: "string", enum: ["prospect", "customer", "former"] },
        domain: { type: "string" },
        websiteUrl: { type: "string" },
        industry: { type: "string" },
        employeeCount: { type: "integer", minimum: 0 },
        currency: { type: "string" },
        annualContractValueCents: { type: "integer", minimum: 0 },
        notes: { type: "string" },
        ownerId: { type: ["string", "null"] },
        ownerEmployeeId: { type: ["string", "null"] },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_revenue_account",
    description:
      "Archive or restore an Account without deleting its Revenue or Finance history. Archived Accounts leave the default list but remain addressable and can be restored. Set `archived` false to restore; restoration refuses an active domain collision. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        archived: { type: "boolean" },
      },
      required: ["accountId", "archived"],
      additionalProperties: false,
    },
  },
  {
    name: "merge_revenue_accounts",
    description:
      "Merge a duplicate source Account into an active destination Account in one transaction. Reparents Revenue and Finance history, preserves issued document identities, applies explicit source/target choices for standard and custom field conflicts, copies missing Account custom values, and archives the source. Preview first, then pass conflict choices in `resolutions` and the source's exact current name in `confirmSourceName`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        sourceAccountId: { type: "string" },
        targetAccountId: { type: "string" },
        confirmSourceName: {
          type: "string",
          description: "The source Account's exact current name, as an explicit confirmation.",
        },
        resolutions: {
          type: "object",
          description:
            "Conflict field keys mapped to `source` or `target`. Custom keys use `custom:<field-id>`. Omitted conflicts keep the preview default.",
          additionalProperties: { type: "string", enum: ["source", "target"] },
        },
      },
      required: ["sourceAccountId", "targetAccountId", "confirmSourceName"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_classifications",
    description:
      "List the company's controlled values for Deal sources, buying-committee roles, Partnership types and Partnership statuses. Use these machine values on writes instead of inventing free text. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["deal_source", "committee_role", "partnership_type", "partnership_status"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_revenue_classification",
    description:
      "Add a controlled Deal source, buying-committee role, Partnership type, or Partnership status. The stable machine value is derived from the label unless supplied. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["deal_source", "committee_role", "partnership_type", "partnership_status"],
        },
        label: { type: "string" },
        value: { type: "string" },
      },
      required: ["kind", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "update_revenue_classification",
    description:
      "Rename, reorder, archive, or restore a controlled Revenue classification. Its machine value remains stable for historical reporting. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        classificationId: { type: "string" },
        label: { type: "string" },
        sortOrder: { type: "integer" },
        archived: { type: "boolean" },
      },
      required: ["classificationId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_custom_fields",
    description:
      "List typed custom-field definitions for Contacts, accounts, Deals, or Partnerships. Fields may be text, number, date, boolean, select, multi-select or URL. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_revenue_custom_field",
    description:
      "Create a typed custom-field definition for Contacts, accounts, Deals, or Partnerships. Stable keys make imported and AI-written values queryable. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        name: { type: "string" },
        key: { type: "string" },
        fieldType: {
          type: "string",
          enum: ["text", "number", "date", "boolean", "select", "multi_select", "url"],
        },
        options: { type: "array", items: { type: "string" }, maxItems: 200 },
        required: { type: "boolean" },
      },
      required: ["resourceType", "name", "fieldType"],
      additionalProperties: false,
    },
  },
  {
    name: "update_revenue_custom_field",
    description:
      "Edit a custom field’s label, select options, required flag, order, or archive state. Type and stable key cannot change once values may exist. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        fieldId: { type: "string" },
        name: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 200 },
        required: { type: "boolean" },
        sortOrder: { type: "integer" },
        archived: { type: "boolean" },
      },
      required: ["fieldId"],
      additionalProperties: false,
    },
  },
  {
    name: "install_base_migration_custom_fields",
    description:
      "Idempotently install the recommended typed fields for migrating a compressed CRM Base: monitoring stack, competitor/current provider, product interest, company/infrastructure size, geography/compliance, Stripe customer id, qualification score/signals, procurement/security status, and original Base row ids. Needs `write` revenue access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_revenue_custom_fields",
    description:
      "Set custom fields by stable field key on one Contact, Account, Deal or Partnership. Values are type-checked; null clears a value. With provenance, verificationState must explicitly be `verified`; the source must exist in this company, and Finance, email, and Integration sources also require the corresponding Grant. Omitting provenance records an AI-authored manual update. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        resourceId: { type: "string" },
        values: { type: "object", additionalProperties: true },
        provenance: {
          type: "object",
          properties: {
            sourceType: {
              type: "string",
              enum: ["email", "document", "integration", "finance", "website", "import", "manual"],
            },
            sourceId: { type: "string" },
            sourceLabel: { type: "string" },
            extractionMethod: { type: "string" },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            observedAt: { type: "string", description: "ISO datetime." },
            verificationState: {
              type: "string",
              enum: ["verified", "unverified"],
            },
            lastVerifiedAt: { type: ["string", "null"], description: "ISO datetime." },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["sourceType", "sourceId", "verificationState"],
          additionalProperties: false,
        },
      },
      required: ["resourceType", "resourceId", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "list_partnerships",
    description:
      "List native Partnership records with controlled type/status, next follow-up, integration/channel context and owner. Partnerships stay separate from Deals. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        type: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_partnership",
    description:
      "Fetch one Partnership plus every linked Contact, including the primary-contact and Reply-All flags. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { partnershipId: { type: "string" } },
      required: ["partnershipId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_partnership",
    description:
      "Create a native Partnership with controlled type/status, owner, account link, integration/channel context and follow-up dates. Read classifications first. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string" },
        status: { type: "string" },
        customerId: { type: ["string", "null"] },
        websiteUrl: { type: "string" },
        integrationContext: { type: "string" },
        channelContext: { type: "string" },
        notes: { type: "string" },
        ownerId: { type: ["string", "null"] },
        ownerEmployeeId: { type: ["string", "null"] },
        nextFollowUpAt: { type: ["string", "null"] },
        reminderAt: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_partnership",
    description:
      "Update or reassign one Partnership, including its next follow-up and operating context. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        partnershipId: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        status: { type: "string" },
        customerId: { type: ["string", "null"] },
        websiteUrl: { type: "string" },
        integrationContext: { type: "string" },
        channelContext: { type: "string" },
        notes: { type: "string" },
        ownerId: { type: ["string", "null"] },
        ownerEmployeeId: { type: ["string", "null"] },
        nextFollowUpAt: { type: ["string", "null"] },
        reminderAt: { type: ["string", "null"] },
      },
      required: ["partnershipId"],
      additionalProperties: false,
    },
  },
  {
    name: "add_partnership_contact",
    description:
      "Add or update a Contact on a Partnership, with role, primary-contact and Reply-All flags. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        partnershipId: { type: "string" },
        contactId: { type: "string" },
        role: { type: "string" },
        isPrimary: { type: "boolean" },
        replyAll: { type: "boolean" },
      },
      required: ["partnershipId", "contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_documents",
    description:
      "List formal documents related to a Deal, account, Partnership, or Contact: proposals, RFPs, security questionnaires, contracts and mail attachments. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        customerId: { type: "string" },
        partnershipId: { type: "string" },
        contactId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "link_revenue_document",
    description:
      "Create a formal relationship from a Deal/account/Partnership/Contact to an uploaded attachment, MailMessage attachment, or external URL. Use a chat-upload attachment id for local files. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "proposal",
            "rfp",
            "security_questionnaire",
            "contract",
            "email_attachment",
            "other",
          ],
        },
        title: { type: "string" },
        notes: { type: "string" },
        dealId: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        partnershipId: { type: ["string", "null"] },
        contactId: { type: ["string", "null"] },
        attachmentId: { type: ["string", "null"] },
        sourceMailMessageId: { type: ["string", "null"] },
        externalUrl: { type: "string" },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_document",
    description:
      "Fetch one formal Revenue document’s metadata and linked file metadata directly by id. Use `download_revenue_document` for its bytes. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_revenue_document",
    description:
      "Edit a formal Revenue document’s title, kind, notes, external URL, or Contact/account/Deal/Partnership links. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        kind: {
          type: "string",
          enum: [
            "proposal",
            "rfp",
            "security_questionnaire",
            "contract",
            "email_attachment",
            "other",
          ],
        },
        title: { type: "string" },
        notes: { type: "string" },
        dealId: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        partnershipId: { type: ["string", "null"] },
        contactId: { type: ["string", "null"] },
        externalUrl: { type: "string" },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_revenue_document",
    description:
      "Unlink a formal Revenue document record. The action is audited; it does not delete an external source document. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "download_revenue_document",
    description:
      "Fetch a linked Revenue document’s binary bytes as base64, with filename and MIME type, up to 8 MiB. Pass `contentBase64` to `send_chat_attachment` when a Member asks for the file. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_revenue_record_merge",
    description:
      "Preview merging an Account, Contact, Deal, or Partnership into a chosen survivor. Returns standard/custom field conflicts, proposed source/target resolutions, and relationship counts without writing. Pass tentative `resolutions` to recalculate the preview. Always inspect this before `merge_revenue_records`. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        sourceId: { type: "string" },
        targetId: { type: "string" },
        resolutions: {
          type: "object",
          description: "Optional conflict field choices. Custom keys use `custom:<field-id>`.",
          additionalProperties: { type: "string", enum: ["source", "target"] },
        },
      },
      required: ["resourceType", "sourceId", "targetId"],
      additionalProperties: false,
    },
  },
  {
    name: "merge_revenue_records",
    description:
      "Merge a reviewed duplicate candidate for an Account, Contact, Deal, or Partnership into the selected survivor. First use `preview_revenue_record_merge`; then pass its explicit standard/custom conflict choices, the exact source label, and the source/target ids. Relationships and aliases are preserved, the source becomes a redirecting tombstone, and the operation has guarded undo. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        sourceId: { type: "string" },
        targetId: { type: "string" },
        confirmSourceLabel: { type: "string" },
        resolutions: {
          type: "object",
          description:
            "Conflict field keys mapped to `source` or `target`. Custom keys use `custom:<field-id>`.",
          additionalProperties: { type: "string", enum: ["source", "target"] },
        },
      },
      required: ["resourceType", "sourceId", "targetId", "confirmSourceLabel"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_revenue_record_redirect",
    description:
      "Resolve a merged record’s tombstone to its surviving Account, Contact, Deal, or Partnership and merge operation. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        sourceId: { type: "string" },
      },
      required: ["resourceType", "sourceId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_operations",
    description:
      "List merge, bulk, and historical-import audit operations, including queued/running progress and rollback state. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["merge", "bulk", "history_import"] },
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership", "follow_up"],
        },
        status: {
          type: "string",
          enum: ["queued", "running", "completed", "partial", "failed", "rolled_back"],
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_operation",
    description:
      "Retrieve one Revenue merge/bulk/history operation and a paginated page of per-record before/after audit rows. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        rowLimit: { type: "integer", minimum: 1, maximum: 500 },
        rowOffset: { type: "integer", minimum: 0 },
      },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
  {
    name: "undo_revenue_operation",
    description:
      "Guardedly undo a merge, asynchronous bulk job, or historical Deal import. It refuses atomically if any affected row changed later. Pass confirm `UNDO`; use `get_revenue_operation` first to inspect the audit rows and current rollback state. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        confirm: { type: "string", enum: ["UNDO"] },
      },
      required: ["operationId", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_revenue_bulk_operation",
    description:
      "Dry-run a bulk Account, Contact, Deal, Partnership, or Follow-up mutation with a frozen selection preview and per-record validation. Actions cover archive/restore, safe standard/custom-field changes, owner/lifecycle/status changes, Deal Stage movement, and Follow-up reschedule/reassign/complete/cancel. Standard-field updates require confirm `UPDATE_STANDARD_FIELDS`. Selected IDs or a filter are required; Closed Lost movement requires a lost reason. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership", "follow_up"],
        },
        target: REVENUE_BULK_TARGET_PROPERTY,
        action: REVENUE_BULK_ACTION_PROPERTY,
        mode: { type: "string", enum: ["atomic", "partial"] },
      },
      required: ["resourceType", "target", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "start_revenue_bulk_job",
    description:
      "Freeze the previewed selection and queue an asynchronous Account, Contact, Deal, Partnership, or Follow-up bulk job. Supported actions include archive/restore, confirmed safe standard-field updates, and Follow-up triage. `atomic` rolls back every write on one failure; `partial` commits valid rows and reports failures. The stable idempotency key makes retries safe. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership", "follow_up"],
        },
        target: REVENUE_BULK_TARGET_PROPERTY,
        action: REVENUE_BULK_ACTION_PROPERTY,
        mode: { type: "string", enum: ["atomic", "partial"] },
        idempotencyKey: { type: "string" },
      },
      required: ["resourceType", "target", "action", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_bulk_job",
    description:
      "Read queued/running/completed bulk-job progress plus a paginated JSON page of per-record validation and reconciliation rows. Use `export_revenue_bulk_reconciliation` for CSV. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        rowLimit: { type: "integer", minimum: 1, maximum: 500 },
        rowOffset: { type: "integer", minimum: 0 },
      },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
  {
    name: "export_revenue_bulk_reconciliation",
    description:
      "Export a bulk job’s filtered, paginated per-record reconciliation as CSV for `send_chat_attachment`; use `get_revenue_bulk_job` for JSON status and rows. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_historical_deal_import",
    description:
      "Validate original Deal creation timestamps and ordered historical stage, amount, owner, expected-close, won/lost events without writing. Every event needs a stable source event id and effective timestamp; completeness controls boundary validation. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        batchKey: { type: "string" },
        sourceSystem: { type: "string" },
        rows: HISTORICAL_DEAL_ROWS_PROPERTY,
      },
      required: ["batchKey", "sourceSystem", "rows"],
      additionalProperties: false,
    },
  },
  {
    name: "run_historical_deal_import",
    description:
      "Commit a previewed historical Deal-event batch as immutable, source-identifiable reporting history. Replays are idempotent and the resulting operation has guarded undo. Pass confirm `IMPORT`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        batchKey: { type: "string" },
        sourceSystem: { type: "string" },
        rows: HISTORICAL_DEAL_ROWS_PROPERTY,
        confirm: { type: "string", enum: ["IMPORT"] },
      },
      required: ["batchKey", "sourceSystem", "rows", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "list_deal_history",
    description:
      "Page immutable Deal reporting events by Deal, source, event kind, or effective-time range. This is the historical source for conversion, velocity, sales-cycle and time-in-stage analysis. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        sourceKind: { type: "string", enum: ["live", "import", "activity_backfill"] },
        kind: {
          type: "string",
          enum: [
            "created",
            "snapshot",
            "stage_changed",
            "amount_changed",
            "owner_changed",
            "expected_close_changed",
            "won",
            "lost",
          ],
        },
        from: { type: "string", description: "ISO datetime." },
        to: { type: "string", description: "ISO datetime." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "backfill_deal_history",
    description:
      "Idempotently convert selected Deal lifecycle Activities into immutable Deal history for records created before the history ledger shipped. Preview first; commits reject an empty/unscoped selection. Pass a stable idempotencyKey and confirm `BACKFILL`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5_000,
        },
        idempotencyKey: { type: "string" },
        confirm: { type: "string", enum: ["BACKFILL"] },
      },
      required: ["dealIds", "idempotencyKey", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "list_deal_history_coverage",
    description:
      "Inventory Deal-by-Deal history coverage, import provenance, eligible and pending lifecycle Activities, completeness, and the safest next action. Use this before importing or backfilling historical Deal events. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealIds: { type: "array", items: { type: "string" }, maxItems: 5_000 },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_deal_history_backfill",
    description:
      "Preview which selected lifecycle Activities can safely become immutable Deal history, including migration snapshots and per-Activity skips or failures. An empty selection previews coverage company-wide but cannot be committed. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealIds: { type: "array", items: { type: "string" }, maxItems: 5_000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_revenue_snapshot",
    description:
      "Export a stable paginated JSON or CSV snapshot of Revenue records and audit ledgers, including Deal history, field evidence, duplicate candidates, operation audit rows, import reconciliation, and mailbox-scoped Gmail document candidates. For document_candidates, accountId is required and the AI Employee needs a read Grant to that exact Mail Account. Finance, email, and Integration evidence is limited to the AI Employee's Finance, mailbox, and Connection Grants. Audit resources accept resource-specific filters. CSV returns `contentText` for `send_chat_attachment`. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          enum: [
            "accounts",
            "contacts",
            "deals",
            "partnerships",
            "partnership_contacts",
            "buying_committees",
            "follow_ups",
            "documents",
            "stage_definitions",
            "custom_fields",
            "custom_values",
            "import_reconciliation",
            "deal_history",
            "field_evidence",
            "duplicate_candidates",
            "operation_audit",
            "document_candidates",
          ],
        },
        format: { type: "string", enum: ["json", "csv"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
        cursor: {
          type: "string",
          description: "Opaque nextCursor from the previous page; do not combine with offset.",
        },
        asOf: {
          type: "string",
          description:
            "Optional ISO snapshot boundary. Prefer the cursor, which already carries it.",
        },
        dealId: { type: "string", description: "Deal-history filter." },
        sourceKind: {
          type: "string",
          enum: ["live", "import", "activity_backfill"],
          description: "Deal-history source filter.",
        },
        kind: {
          type: "string",
          enum: [
            "created",
            "snapshot",
            "stage_changed",
            "amount_changed",
            "owner_changed",
            "expected_close_changed",
            "won",
            "lost",
            "merge",
            "bulk",
            "history_import",
          ],
          description: "Deal-history event kind or operation-audit kind.",
        },
        from: { type: "string", description: "Deal-history ISO lower time bound." },
        to: { type: "string", description: "Deal-history ISO upper time bound." },
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership", "follow_up"],
          description: "Field-evidence, duplicate-candidate, or operation-audit filter.",
        },
        resourceId: { type: "string", description: "Field-evidence resource filter." },
        fieldKey: { type: "string", description: "Field-evidence key filter." },
        sourceType: {
          type: "string",
          enum: ["email", "document", "integration", "finance", "website", "import", "manual"],
          description: "Field-evidence source filter.",
        },
        status: {
          type: "string",
          enum: [
            "proposed",
            "accepted",
            "rejected",
            "superseded",
            "open",
            "dismissed",
            "merged",
            "queued",
            "running",
            "completed",
            "partial",
            "failed",
            "rolled_back",
            "pending",
            "processing",
            "duplicate",
          ],
          description:
            "Field-evidence, duplicate-candidate, operation-audit, or document-candidate status filter.",
        },
        minScore: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Duplicate-candidate minimum score.",
        },
        accountId: {
          type: "string",
          description:
            "Required for document_candidates. Must identify the exact Mail Account with a read Grant for this AI Employee.",
        },
      },
      required: ["resource"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_revenue_account_domains",
    description:
      "Generate reviewable canonical-domain evidence from linked business Contact email domains, Account websites, redirects, aliases and normalized Account names. Accepted email evidence raises confidence; caller-supplied IDs do not verify a Contact. Public/disposable mail hosts are excluded and collisions become merge candidates. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        accountIds: { type: "array", items: { type: "string" }, maxItems: 5_000 },
        verifiedContactIds: { type: "array", items: { type: "string" }, maxItems: 20_000 },
        followWebsiteRedirects: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_revenue_firmographics",
    description:
      "Preview up to 100 active Accounts for a selected, granted firmographics Connection. Returns cache state, missing fields, and the maximum external requests before any provider credits are consumed. Needs `write` revenue access and a Grant to the Connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        accountIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        missingOnly: { type: "boolean" },
        refreshOlderThanDays: { type: "integer", minimum: 1, maximum: 3_650 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        force: { type: "boolean" },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_revenue_firmographics",
    description:
      "Look up at most 100 selected Accounts through a granted firmographics Connection and create reviewable field evidence for domain, website, industry, employee count, headquarters, and parent company. This may consume provider credits; preview first and pass confirm `PROPOSE`. It never mutates Accounts directly. Needs `write` revenue access and a Grant to the Connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        accountIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        missingOnly: { type: "boolean" },
        refreshOlderThanDays: { type: "integer", minimum: 1, maximum: 3_650 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        force: { type: "boolean" },
        confirm: { type: "string", enum: ["PROPOSE"] },
      },
      required: ["connectionId", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_firmographic_lookups",
    description:
      "Page the normalized firmographic reconciliation cache for a selected, granted Connection, including matched, not-found, and failed attempts without raw provider payloads. Needs `read` revenue access and a Grant to the Connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        accountId: { type: "string" },
        status: { type: "string", enum: ["matched", "not_found", "failed"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_commercial_value_backlog",
    description:
      "Page open zero-value Deals with Account ambiguity, Finance candidates, non-Integration evidence, stale-proposal state, and a recommended disposition. Stripe data is excluded; use the explicitly granted Stripe proposal tool for it. Use this backlog to choose an explicit safe proposal scope. Needs `read` revenue access and a `read` Finance Grant.",
    inputSchema: {
      type: "object",
      properties: {
        dealIds: { type: "array", items: { type: "string" }, maxItems: 5_000 },
        stageIds: { type: "array", items: { type: "string" }, maxItems: 500 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_finance_commercial_values",
    description:
      "Create reviewable Deal-value evidence for explicitly selected zero-value Deals from accepted estimates, Finance invoices and payments, and Account ACV. Ambiguous Accounts are skipped. Pass confirm `PROPOSE`. Needs `write` revenue access and a `full` Finance Grant.",
    inputSchema: {
      type: "object",
      properties: {
        dealIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5_000,
        },
        confirm: { type: "string", enum: ["PROPOSE"] },
      },
      required: ["dealIds", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_stripe_commercial_values",
    description:
      "Create reviewable Deal-value evidence from one explicitly selected, granted Stripe Connection's subscriptions and invoices, normalized into amount, MRR, ARR, ACV, TCV, one-time value, billing interval, confidence and verification state. Pass connectionId and confirm `PROPOSE`. Needs `write` revenue access and a Grant to that Connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description:
            "Granted Stripe Connection ID to reconcile; no implicit all-Connection scan.",
        },
        dealIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5_000,
        },
        confirm: { type: "string", enum: ["PROPOSE"] },
      },
      required: ["connectionId", "dealIds", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "create_commercial_value_proposal",
    description:
      "Record normalized commercial evidence for one Deal from a proposal, confirmed terms, document, email, integration, Finance, or a manual source. Finance evidence needs a `full` Finance Grant; email and Integration evidence need Grants to their source mailbox or Connection. The evidence stays reviewable until accepted. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        sourceType: {
          type: "string",
          enum: ["email", "document", "integration", "finance", "manual"],
        },
        sourceId: { type: "string" },
        sourceLabel: { type: "string" },
        sourceVerified: { type: "boolean" },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        extractedAt: { type: "string", description: "ISO datetime." },
        value: {
          type: "object",
          properties: {
            amountCents: { type: "integer", minimum: 0 },
            currency: { type: "string" },
            revenueType: { type: "string", enum: ["one_time", "recurring"] },
            billingInterval: {
              type: ["string", "null"],
              enum: ["month", "quarter", "year", null],
            },
            quantity: { type: ["integer", "null"], minimum: 0 },
            seats: { type: ["integer", "null"], minimum: 0 },
            mrrCents: { type: ["integer", "null"], minimum: 0 },
            arrCents: { type: ["integer", "null"], minimum: 0 },
            acvCents: { type: ["integer", "null"], minimum: 0 },
            tcvCents: { type: ["integer", "null"], minimum: 0 },
            oneTimeCents: { type: ["integer", "null"], minimum: 0 },
          },
          required: ["amountCents", "currency", "revenueType"],
          additionalProperties: false,
        },
        metadata: {},
      },
      required: ["dealId", "sourceType", "sourceId", "sourceVerified", "confidence", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_field_evidence",
    description:
      "List reviewable or historical field-level Revenue evidence, including source object, extraction method, confidence, observed/verified timestamps, verification state and superseded values. Finance, email, and Integration evidence is limited to the AI Employee's Finance, mailbox, and Connection Grants. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        resourceId: { type: "string" },
        fieldKey: { type: "string" },
        sourceType: {
          type: "string",
          enum: ["email", "document", "integration", "finance", "website", "import", "manual"],
        },
        status: {
          type: "string",
          enum: ["proposed", "accepted", "rejected", "superseded"],
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "review_revenue_field_evidence",
    description:
      "Accept or reject one Revenue field proposal. Finance-backed evidence needs a `full` Finance Grant; email and Integration evidence need Grants to their source mailbox or Connection. Conflicting accepted evidence requires explicit supersedeExisting so the previous value remains in history. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        evidenceId: { type: "string" },
        decision: { type: "string", enum: ["accept", "reject"] },
        supersedeExisting: { type: "boolean" },
      },
      required: ["evidenceId", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "scan_revenue_duplicates",
    description:
      "Refresh persistent, explainable Revenue duplicate candidates using canonical/alias domains, normalized names, Contact emails, Finance/Stripe identifiers and Deal-title similarity. Prior dismissals are remembered. Pass confirm `SCAN`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "string", enum: ["SCAN"] } },
      required: ["confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_duplicate_candidates",
    description:
      "List persistent Revenue duplicate candidates with score, matching evidence, status and dismissal memory. Use the generic merge tools after review. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        status: { type: "string", enum: ["open", "dismissed", "merged"] },
        minScore: { type: "integer", minimum: 0, maximum: 100 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dismiss_revenue_duplicate_candidate",
    description:
      "Dismiss one duplicate candidate and preserve that decision so later scans do not reopen the same pair. Pass confirm `DISMISS`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        confirm: { type: "string", enum: ["DISMISS"] },
      },
      required: ["candidateId", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "scan_revenue_mail_documents",
    description:
      "Scan a granted Gmail mailbox for Revenue attachments, classify and match them to Accounts, Contacts, Deals or Partnerships, and deduplicate by file hash plus immutable Gmail message/attachment provenance. Needs `write` revenue and `read` access to the named Mail Connection.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        from: { type: "string", description: "ISO datetime." },
        to: { type: "string", description: "ISO datetime." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_document_candidates",
    description:
      "List the Gmail attachment review queue for a granted mailbox, including classification, resource match, deduplication and immutable message/thread provenance. Needs `read` Revenue and Mail access.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "processing", "accepted", "rejected", "duplicate"],
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "review_revenue_document_candidate",
    description:
      "Accept or reject a Gmail attachment candidate. Acceptance creates a deduplicated Revenue Document linked to the chosen resource while retaining message, thread and attachment provenance. Needs `write` Revenue and `read` Mail access.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        decision: { type: "string", enum: ["accept", "reject"] },
        kind: {
          type: "string",
          enum: [
            "proposal",
            "rfp",
            "contract",
            "security_questionnaire",
            "email_attachment",
            "other",
          ],
        },
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership"],
        },
        resourceId: { type: "string" },
        note: { type: "string" },
      },
      required: ["candidateId", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_imports",
    description:
      "List summary-only Revenue import history without returning serialized row maps. Filter and paginate the compact headers, then use `get_revenue_import` for counts or `list_revenue_import_rows` for decisions. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        sourceKind: { type: "string", enum: ["base", "csv", "json", "connection"] },
        status: { type: "string", enum: ["completed", "rolled_back", "failed"] },
        resourceType: {
          type: "string",
          enum: ["account", "contact", "deal", "partnership", "account_contact_deal"],
        },
        from: { type: "string", description: "ISO datetime." },
        to: { type: "string", description: "ISO datetime." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_revenue_import",
    description:
      "Retrieve one compact Revenue import summary with action/status counts. It deliberately omits the large row map; use `list_revenue_import_rows` for JSON decisions or `export_revenue_import_reconciliation` for CSV. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: { importId: { type: "string" } },
      required: ["importId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_revenue_import_rows",
    description:
      "Page through one import’s JSON reconciliation decisions. Filter by resource, action/status, source id, native id, error text, or error presence; exact source/native ids provide direct row lookup. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string" },
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        status: {
          type: "string",
          enum: ["created", "matched", "skipped", "failed", "rolled_back"],
        },
        action: { type: "string" },
        q: { type: "string" },
        sourceId: { type: "string" },
        nativeId: { type: "string" },
        error: { type: "string" },
        hasError: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["importId"],
      additionalProperties: false,
    },
  },
  {
    name: "export_revenue_import_reconciliation",
    description:
      "Export a filtered page of import decisions as CSV for `send_chat_attachment`. Use status/action filters for separate failed, skipped, or duplicate/matched files. Needs `read` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string" },
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        status: {
          type: "string",
          enum: ["created", "matched", "skipped", "failed", "rolled_back"],
        },
        action: { type: "string" },
        q: { type: "string" },
        sourceId: { type: "string" },
        nativeId: { type: "string" },
        error: { type: "string" },
        hasError: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["importId"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_base_revenue_import",
    description:
      "Dry-run a granted Base table into Contacts, Accounts, Deals, or Partnerships. Mapping values are Base field ids; select option ids are resolved to their Base labels. Deal mappings may include `stage` and `source`, and each Deal decision returns the resolved native Deal Stage and Source. Returns create/duplicate/skip decisions without writing anything. Needs `write` revenue access and a Base Grant.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableId: { type: "string" },
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        mapping: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["baseId", "tableId", "resourceType", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "run_base_revenue_import",
    description:
      "Commit a previously previewed-style Base import, preserving the resolved Deal Stage and Source when mapped. Produces a durable source-row → native-id map and reconciliation report; duplicates are linked in the report but never overwritten. Needs `write` revenue access and a Base Grant.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableId: { type: "string" },
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        mapping: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["baseId", "tableId", "resourceType", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_linked_base_revenue_import",
    description:
      "Dry-run one Base row into a linked Account, Contact, and Deal. Supply separate native/custom-field mappings for all three resources; Base select option ids are resolved to labels, and Deal mappings may include `stage` and `source`. Returns per-resource duplicate/skip/create decisions with the resolved native Deal Stage and Source. Needs `write` revenue access and a Base Grant.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableId: { type: "string" },
        mapping: {
          type: "object",
          properties: {
            account: { type: "object", additionalProperties: { type: "string" } },
            contact: { type: "object", additionalProperties: { type: "string" } },
            deal: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["account", "contact", "deal"],
          additionalProperties: false,
        },
      },
      required: ["baseId", "tableId", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "run_linked_base_revenue_import",
    description:
      "Atomically split each Base row into a linked Account, Contact, and Deal while preserving the resolved Deal Stage and Source. The whole database write commits or rolls back together, duplicates are reused without overwrite, and the batch stores every source-to-native id. Needs `write` revenue access and a Base Grant.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableId: { type: "string" },
        mapping: {
          type: "object",
          properties: {
            account: { type: "object", additionalProperties: { type: "string" } },
            contact: { type: "object", additionalProperties: { type: "string" } },
            deal: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["account", "contact", "deal"],
          additionalProperties: false,
        },
      },
      required: ["baseId", "tableId", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_revenue_rows_import",
    description:
      "Dry-run up to 1,000 explicitly supplied CSV/JSON or connector rows into one Revenue resource. Mapping keys are native/custom destination fields and values are source field names. Connection-backed provenance requires a Grant to sourceConnectionId. Returns create/duplicate/skip decisions without writing. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REVENUE_IMPORT_SOURCE_PROPERTIES,
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        mapping: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["sourceKind", "sourceLabel", "rows", "resourceType", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "run_revenue_rows_import",
    description:
      "Commit a previewed CSV/JSON or connector row import into one Revenue resource with durable row reconciliation, field provenance, duplicate reuse, and guarded rollback. Connection-backed provenance requires a Grant to sourceConnectionId. Pass confirm `IMPORT`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REVENUE_IMPORT_SOURCE_PROPERTIES,
        resourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        mapping: { type: "object", additionalProperties: { type: "string" } },
        confirm: { type: "string", enum: ["IMPORT"] },
      },
      required: ["sourceKind", "sourceLabel", "rows", "resourceType", "mapping", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_linked_revenue_rows_import",
    description:
      "Dry-run up to 1,000 explicitly supplied CSV/JSON or connector rows into linked Accounts, Contacts, and Deals. Connection-backed provenance requires a Grant to sourceConnectionId. Returns per-resource decisions without writing. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REVENUE_IMPORT_SOURCE_PROPERTIES,
        mapping: LINKED_REVENUE_IMPORT_MAPPING_PROPERTY,
      },
      required: ["sourceKind", "sourceLabel", "rows", "mapping"],
      additionalProperties: false,
    },
  },
  {
    name: "run_linked_revenue_rows_import",
    description:
      "Atomically commit previewed CSV/JSON or connector rows as linked Accounts, Contacts, and Deals with durable row reconciliation, field provenance, duplicate reuse, and guarded rollback. Connection-backed provenance requires a Grant to sourceConnectionId. Pass confirm `IMPORT`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        ...REVENUE_IMPORT_SOURCE_PROPERTIES,
        mapping: LINKED_REVENUE_IMPORT_MAPPING_PROPERTY,
        confirm: { type: "string", enum: ["IMPORT"] },
      },
      required: ["sourceKind", "sourceLabel", "rows", "mapping", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "migrate_base_revenue_attachments",
    description:
      "Copy every Base record attachment covered by an import reconciliation map into formal Revenue documents. For a linked import, choose account, contact, or deal (Deal is the default). Idempotently skips matching filename/size links. Needs `write` revenue access and a Grant to the source Base.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string" },
        targetResourceType: {
          type: "string",
          enum: ["contact", "account", "deal", "partnership"],
        },
        kind: {
          type: "string",
          enum: [
            "proposal",
            "rfp",
            "security_questionnaire",
            "contract",
            "email_attachment",
            "other",
          ],
        },
      },
      required: ["importId"],
      additionalProperties: false,
    },
  },
  {
    name: "rollback_revenue_import",
    description:
      "Roll back rows created by one Revenue import. Rows changed or linked after import are preserved and reported as blocked instead of being deleted. Pass confirm `ROLLBACK`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string" },
        confirm: { type: "string", enum: ["ROLLBACK"] },
      },
      required: ["importId", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "create_contact",
    description:
      "Add a person to the revenue system. `name` is the only required field, but an email is what lets mail sync attach their whole conversation history to them automatically. Emails are unique per company — creating one that already exists is refused with the existing contact's id so you can update that row instead of forking it. Needs `write` revenue access; the write is recorded against your name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name." },
        email: { type: "string", description: "Normalized and de-duplicated on write." },
        phone: { type: "string" },
        title: { type: "string", description: "Job title, as they would write it." },
        linkedinUrl: { type: "string" },
        websiteUrl: { type: "string" },
        customerId: {
          type: ["string", "null"],
          description: "The billable account they belong to, if one exists yet.",
        },
        companyName: {
          type: "string",
          description: "Free-text employer, for somebody with no Customer row yet.",
        },
        lifecycleStage: {
          type: "string",
          enum: [
            "subscriber",
            "lead",
            "qualified",
            "opportunity",
            "customer",
            "churned",
            "unqualified",
          ],
          description: "Defaults to 'lead'.",
        },
        ownerId: { type: ["string", "null"], description: "Human Member owner." },
        ownerEmployeeId: {
          type: ["string", "null"],
          description: "AI Employee owner.",
        },
        source: {
          type: "string",
          description: "Where they came from, e.g. 'referral' or 'google-ads'.",
        },
        sourceDetail: { type: "string" },
        score: { type: "integer", minimum: 0, maximum: 100, description: "0 means unscored." },
        notes: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_contact",
    description:
      "Update a Contact. Only the fields you pass change. Use this to correct or enrich a row rather than creating a second one for the same person. `doNotContact: true` is a permanent human-style opt-out — it blocks every send to them, and clearing it is a decision for a human, so do not set it back to false on your own. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        title: { type: "string" },
        linkedinUrl: { type: "string" },
        websiteUrl: { type: "string" },
        customerId: { type: ["string", "null"] },
        companyName: { type: "string" },
        lifecycleStage: {
          type: "string",
          enum: [
            "subscriber",
            "lead",
            "qualified",
            "opportunity",
            "customer",
            "churned",
            "unqualified",
          ],
        },
        ownerId: { type: ["string", "null"], description: "Human Member owner." },
        ownerEmployeeId: {
          type: ["string", "null"],
          description: "AI Employee owner.",
        },
        source: { type: "string" },
        sourceDetail: { type: "string" },
        score: { type: "integer", minimum: 0, maximum: 100 },
        notes: { type: "string" },
        doNotContact: { type: "boolean" },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_deal",
    description:
      "Open a Deal — one opportunity. Lands in the first open stage unless you name a `stageId` from `list_deal_stages`. `amountCents` is integer minor units (500000 is $5,000.00). Naming a `primaryContactId` is what puts the deal on that person's timeline, and a `customerId` is what ties it to the billable account. A `deal_created` activity is written so the timeline starts at the beginning. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name, e.g. 'Northwind — 20 seats'." },
        description: { type: "string" },
        customerId: { type: ["string", "null"] },
        primaryContactId: {
          type: ["string", "null"],
          description: "The main person on the other side (a Contact id).",
        },
        stageId: {
          type: ["string", "null"],
          description: "From list_deal_stages. Omit for the first open stage.",
        },
        amountCents: {
          type: "integer",
          minimum: 0,
          description: "Deal value in minor units (cents).",
        },
        currency: { type: "string", description: "ISO 4217 code. Defaults to USD." },
        probabilityOverride: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 100,
          description: "Override the stage's default probability for this one deal.",
        },
        expectedCloseDate: { type: ["string", "null"], description: "ISO date/datetime." },
        source: {
          type: "string",
          description: "Controlled value from list_revenue_classifications.",
        },
        nextStep: { type: "string", description: "The concrete next action, in one line." },
        nextFollowUpAt: { type: ["string", "null"], description: "ISO date/datetime." },
        followUpReminderAt: { type: ["string", "null"], description: "ISO date/datetime." },
        ownerId: { type: ["string", "null"], description: "Human Member owner." },
        ownerEmployeeId: { type: ["string", "null"], description: "AI Employee owner." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_deal",
    description:
      "Update a Deal's title, description, amount, links, expected close date or next step. Only the fields you pass change. This deliberately cannot move a deal between stages — that carries the status invariant and writes the activity every funnel report reads, so it has its own tool, `move_deal_stage`. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        customerId: { type: ["string", "null"] },
        primaryContactId: { type: ["string", "null"] },
        amountCents: { type: "integer", minimum: 0 },
        currency: { type: "string" },
        probabilityOverride: { type: ["integer", "null"], minimum: 0, maximum: 100 },
        expectedCloseDate: { type: ["string", "null"] },
        source: { type: "string" },
        nextStep: { type: "string" },
        nextFollowUpAt: { type: ["string", "null"] },
        followUpReminderAt: { type: ["string", "null"] },
        ownerId: { type: ["string", "null"] },
        ownerEmployeeId: { type: ["string", "null"] },
      },
      required: ["dealId"],
      additionalProperties: false,
    },
  },
  {
    name: "move_deal_stage",
    description:
      "Move a Deal to another stage. This is how a deal advances — and how it closes: a stage whose `kind` is `won` or `lost` sets the deal's status and stamps `closedAt`, which every revenue report then counts. Do that deliberately, and pass `lostReason` when the stage is a lost one so the funnel report can say why. The move writes a `stage_change` / `deal_won` / `deal_lost` activity. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        stageId: { type: "string", description: "Target stage id from list_deal_stages." },
        lostReason: {
          type: "string",
          description: "Why it was lost. Only meaningful when moving into a lost stage.",
        },
      },
      required: ["dealId", "stageId"],
      additionalProperties: false,
    },
  },
  {
    name: "log_activity",
    description:
      "Write a note, call, meeting or task onto a Contact's and/or Deal's timeline. Use it after you actually did something — summarising a call, recording what a teammate told you, capturing a commitment — so the next person to open that record sees it. Emails, stage changes and sequence touches are written for you by the systems that perform them and cannot be logged here: a hand-written 'deal_won' would be a conversion no report could tell from a real one. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "call", "meeting", "task"] },
        subject: { type: "string", description: "One-line headline for the timeline row." },
        bodyText: { type: "string", description: "The detail. Markdown is fine." },
        occurredAt: {
          type: "string",
          description: "ISO datetime it actually happened. Defaults to now.",
        },
        contactId: { type: ["string", "null"] },
        dealId: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        partnershipId: { type: ["string", "null"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "add_deal_contact",
    description:
      "Put a Contact on a Deal's buying committee, with a controlled role from `list_revenue_classifications`. Idempotent — adding somebody already on it just updates their role. Use this as you learn who else is involved; the committee is what tells the next person who to copy. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        contactId: { type: "string" },
        role: { type: "string", description: "Their part in the decision." },
      },
      required: ["dealId", "contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "enroll_in_sequence",
    description:
      "Enrol contacts in an outbound Sequence. Partial success by design: a suppressed address, a do-not-contact flag, a missing email, an archived row or somebody already enrolled is skipped with a reason and the rest still go in — read `skipped` in the result and do not retry a refusal. Enrolling does not send anything itself; the sequence tick drafts each touch, and unless the sequence is marked auto-send a human presses Send. At most 500 contacts per call. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: { type: "string", description: "Sequence id from list_sequences." },
        contactIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description: "Contact ids to enrol.",
        },
        dealId: {
          type: "string",
          description: "Optional deal to attribute the enrolment and its touches to.",
        },
      },
      required: ["sequenceId", "contactIds"],
      additionalProperties: false,
    },
  },
  {
    name: "suppress_email",
    description:
      "Add an address to the company's do-not-mail list. Enforced at the single outbound choke-point, so it covers every path — a human pressing Send, a sequence step, your own `send_mail`. Call this the moment somebody asks to be removed, replies 'unsubscribe', or hard-bounces: mailing someone who already said no is the cheapest way to get the sending domain blocklisted. Idempotent — re-suppressing an address returns the existing row and leaves its original reason alone. Removing an address from the list is a human's decision and there is no tool for it. Needs `write` revenue access.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The address to suppress." },
        reason: {
          type: "string",
          enum: ["unsubscribe", "bounce", "complaint", "manual"],
          description:
            "Why. Use `unsubscribe` only when they actually asked, `bounce` for a hard bounce, `complaint` for a spam report. Defaults to `manual`.",
        },
        notes: { type: "string", description: "Where the request came from, for the record." },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "get_marketing_overview",
    description:
      "Read the autonomous ad-agency dashboard: Campaign counts and policies, Creative waiting for review, running Experiments, planned daily budget, and the latest recorded spend/impressions/clicks/conversions. The performance figures are immutable snapshots recorded from ad-platform reads; they are not the authorized-budget-change ledger. Needs `read` Marketing access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_marketing_campaigns",
    description:
      "List Marketing Campaigns — the durable briefs and operating policies that connect ad-platform objects to audience, offer, success metric, owner, budget and autonomy mode. Filter to your Campaigns with `ownedByMe`. Read the live platform separately before changing a linked Campaign. Needs `read` Marketing access.",
    inputSchema: {
      type: "object",
      properties: {
        status: MARKETING_CAMPAIGN_PROPERTIES.status,
        channel: MARKETING_CAMPAIGN_PROPERTIES.channel,
        ownedByMe: { type: "boolean" },
        includeArchived: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_marketing_campaign",
    description:
      "Fetch one Marketing Campaign with its full brief, Creative variants, Experiments and recent performance snapshots. Use this before proposing or performing an optimization so you inherit the strategy and the evidence from prior Routines. Needs `read` Marketing access.",
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string" } },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_marketing_campaign",
    description:
      "Create a Marketing Campaign brief. Start as draft while strategy is incomplete or ready when the brief, audience, channel, success metric and positive daily budget are all present. This does not create an external platform Campaign or authorize spend; use a granted ads Connection or guarded browser/MCP tool for that, then link its external id. Needs `write` Marketing access.",
    inputSchema: {
      type: "object",
      properties: MARKETING_CAMPAIGN_PROPERTIES,
      required: ["name", "objective"],
      additionalProperties: false,
    },
  },
  {
    name: "update_marketing_campaign",
    description:
      "Edit Campaign strategy or link it to the platform object you created. Marking it active, paused or completed needs `operate` Marketing access; active also requires a real external Campaign id. External spend changes remain separate ad-platform calls governed by the Connection's caps, kill switch and Approvals.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        ...MARKETING_CAMPAIGN_PROPERTIES,
      },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_marketing_creatives",
    description:
      "List Creative variants across Marketing, or inside one Campaign. Each row carries concept, copy, asset/destination URLs, review state, variant group and external id. Needs `read` Marketing access.",
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "create_marketing_creative",
    description:
      "Draft a Creative variant or submit it for review. Store the reusable concept and copy here; keep binary assets in a company-controlled Resource/URL and never put base64 or customer PII in the row. Approval/activation needs `operate` access and external publishing remains subject to its Connection or browser/MCP Approval. Needs `write` Marketing access.",
    inputSchema: {
      type: "object",
      properties: MARKETING_CREATIVE_PROPERTIES,
      required: ["campaignId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_marketing_creative",
    description:
      "Revise a Creative or move it through review. Approving, activating, rejecting or retiring needs `operate` Marketing access. This records the workspace decision; publish the Creative through the separately granted external channel and then store its external id.",
    inputSchema: {
      type: "object",
      properties: {
        creativeId: { type: "string" },
        ...MARKETING_CREATIVE_PROPERTIES,
      },
      required: ["creativeId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_marketing_experiments",
    description:
      "List falsifiable Marketing Experiments across the company or within one Campaign, including competing Creative ids, metric, sample threshold, winner and rationale. Needs `read` Marketing access.",
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "create_marketing_experiment",
    description:
      "Create an Experiment comparing at least two Creative variants from the same Campaign. State a falsifiable hypothesis, primary metric and minimum sample before running it. Starting immediately needs `operate`; creating a draft needs `write` Marketing access.",
    inputSchema: {
      type: "object",
      properties: MARKETING_EXPERIMENT_PROPERTIES,
      required: ["campaignId", "name", "creativeIds"],
      additionalProperties: false,
    },
  },
  {
    name: "update_marketing_experiment",
    description:
      "Edit, start, stop or decide a Marketing Experiment. A decision must name one of its Creative variants as winner and record the evidence-based rationale. Non-draft states need `operate` Marketing access.",
    inputSchema: {
      type: "object",
      properties: {
        experimentId: { type: "string" },
        ...MARKETING_EXPERIMENT_PROPERTIES,
      },
      required: ["experimentId"],
      additionalProperties: false,
    },
  },
  {
    name: "record_marketing_performance",
    description:
      "Append an immutable Campaign performance snapshot after reading the live ad platform: period, settled spend, impressions, clicks, conversions and conversion value. Currency must match the Campaign. Put the provider/report name in `source`; optional `raw` preserves bounded provider detail. Needs `operate` Marketing access.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        periodStart: { type: "string", description: "ISO datetime." },
        periodEnd: { type: "string", description: "ISO datetime." },
        spendMinor: { type: "number" },
        impressions: { type: "number" },
        clicks: { type: "number" },
        conversions: { type: "string" },
        conversionValue: { type: "string" },
        currency: { type: "string" },
        source: { type: "string" },
        raw: { type: "object", additionalProperties: true },
      },
      required: ["campaignId", "periodStart", "periodEnd", "spendMinor", "currency", "source"],
      additionalProperties: false,
    },
  },
];
