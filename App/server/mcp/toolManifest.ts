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
      },
      required: ["name", "cronExpr"],
      additionalProperties: false,
    },
  },
  {
    name: "update_routine",
    description:
      "Update an existing Routine's name, cron schedule, brief, or enabled state. Use this to edit or pause a routine in place — never create a duplicate routine to work around an outdated one. Pass the `routineId` UUID from `list_routines`; only the fields you pass change.",
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
      "Return the full schema of a Base you have access to — its tables, fields, and field types. Pass `baseSlug` from `list_bases`. Use this before reading or writing rows so you know the field ids.",
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
      "Delete a table from a Base, along with all of its fields and rows. Irreversible — confirm with a human first when uncertain.",
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
      "Write a Gmail draft — the human-in-the-loop way to answer email: the draft lands in the thread (and the owner's Gmail Drafts) for a human to review and send. Pass `threadId` to draft a reply (recipients and subject are inferred from the thread when omitted); omit it for a fresh compose, which requires `to` and an `accountId` when you hold more than one grant. Requires the `draft` access level.",
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
      "Send email from a granted mailbox — this goes out immediately under the company's address, so only use it when the instruction explicitly allows sending; otherwise prefer `create_mail_draft`. Three forms: pass `draftMessageId` to send an existing draft; pass `threadId` (+ `bodyText`) to compose and send a reply; or pass `to` + `subject` + `bodyText` for a fresh message. Requires the `send` access level.",
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
];
