import { PipelineNodeKind } from "./types.js";

/**
 * Static catalog of every node type a Pipeline can use. Drives:
 *   - the editor's left-rail palette
 *   - the per-node config form (shapes the right-side panel)
 *   - validation hints in the executor
 *
 * Adding a node here is one of three steps; the other two are a runtime in
 * handlers.ts and (optionally) deriving more graph metadata onto the
 * Pipeline row in services/pipelines/index.ts.
 */

export type NodeFamily = "trigger" | "action" | "logic" | "integration";

export type NodeFieldType = "text" | "longtext" | "number" | "boolean" | "select" | "code";

export type NodeField = {
  key: string;
  label: string;
  type: NodeFieldType;
  /** When type is select. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Default value when the node is first dropped onto the canvas. */
  default?: unknown;
};

export type NodeCatalogEntry = {
  type: PipelineNodeKind;
  family: NodeFamily;
  label: string;
  /** lucide-react icon name; the client maps it back to a component. */
  icon: string;
  description: string;
  fields: NodeField[];
  /** Outgoing handle ids. Default `["out"]`. Branch nodes use `["true","false"]`. */
  outputs?: string[];
};

export const NODE_CATALOG: NodeCatalogEntry[] = [
  // ─────────────────────────── Triggers ───────────────────────────────────
  {
    type: "trigger.manual",
    family: "trigger",
    label: "Manual trigger",
    icon: "Play",
    description: "Start when a Member clicks Run now. Ideal for one-off work and testing.",
    fields: [],
  },
  {
    type: "trigger.webhook",
    family: "trigger",
    label: "Webhook",
    icon: "Webhook",
    description:
      "Start when another system sends data to a private URL. Use that data as `trigger.payload` in later steps.",
    fields: [
      {
        key: "token",
        label: "Webhook token",
        type: "text",
        hint: "Auto-generated when the pipeline is saved. Treat as a secret.",
        required: true,
      },
    ],
  },
  {
    type: "trigger.schedule",
    family: "trigger",
    label: "Schedule",
    icon: "CalendarClock",
    description: "Start automatically at the times you choose.",
    fields: [
      {
        key: "cronExpr",
        label: "Cron expression",
        type: "text",
        placeholder: "0 9 * * 1-5",
        hint: "Standard five-field cron, using the server timezone.",
        required: true,
        default: "0 9 * * *",
      },
    ],
  },
  {
    type: "trigger.emailReceived",
    family: "trigger",
    label: "Email received",
    icon: "Mail",
    description:
      "Start when a new inbound email reaches a connected Gmail inbox. Historical mail imported during setup is ignored.",
    fields: [
      {
        key: "fromContains",
        label: "Sender contains",
        type: "text",
        placeholder: "customer@example.com",
        hint: "Optional. Match all senders by leaving this empty.",
      },
      {
        key: "subjectContains",
        label: "Subject contains",
        type: "text",
        placeholder: "Invoice",
        hint: "Optional and not case-sensitive.",
      },
      {
        key: "hasAttachments",
        label: "Attachments",
        type: "select",
        default: "any",
        options: [
          { value: "any", label: "With or without attachments" },
          { value: "yes", label: "Has attachments" },
          { value: "no", label: "Has no attachments" },
        ],
      },
    ],
  },
  {
    type: "trigger.todoCreated",
    family: "trigger",
    label: "Task created",
    icon: "ListPlus",
    description:
      "Start when a new task is added to a Project by a Member, AI employee, recurrence, or another Pipeline.",
    fields: [
      {
        key: "projectSlug",
        label: "Project",
        type: "text",
        hint: "Optional. Choose one Project, or leave empty to watch every Project.",
      },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        default: "any",
        options: [
          { value: "any", label: "Any priority" },
          { value: "none", label: "None" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ],
      },
      {
        key: "titleContains",
        label: "Title contains",
        type: "text",
        placeholder: "Follow up",
        hint: "Optional and not case-sensitive.",
      },
    ],
  },
  // ──────────────────────── Genosyn actions ───────────────────────────────
  {
    type: "action.sendMessage",
    family: "action",
    label: "Send a message",
    icon: "MessageSquare",
    description: "Post a message to a workspace channel as 'system'.",
    fields: [
      {
        key: "channelIdOrSlug",
        label: "Channel",
        type: "text",
        placeholder: "general",
        hint: "Choose the workspace channel that should receive the message.",
        required: true,
      },
      {
        key: "content",
        label: "Message",
        type: "longtext",
        placeholder: "Hello {{trigger.payload.name}}!",
        required: true,
      },
    ],
  },
  {
    type: "action.createTodo",
    family: "action",
    label: "Add task",
    icon: "ListTodo",
    description: "Create a todo inside a Project. (In Genosyn, tasks live in Projects + Todos.)",
    fields: [
      {
        key: "projectSlug",
        label: "Project",
        type: "text",
        placeholder: "support",
        hint: "Choose the Project where the new task should live.",
        required: true,
      },
      { key: "title", label: "Title", type: "text", required: true },
      {
        key: "description",
        label: "Description",
        type: "longtext",
      },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ],
      },
    ],
  },
  {
    type: "action.createProject",
    family: "action",
    label: "Create project",
    icon: "FolderPlus",
    description: "Create a new Project. Skips silently if one with this name exists.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "description", label: "Description", type: "longtext" },
    ],
  },
  {
    type: "action.createBaseRecord",
    family: "action",
    label: "Add record (Base)",
    icon: "DatabasePlus",
    description: "Append a row to a Base table. Supply field id → value as JSON.",
    fields: [
      {
        key: "baseSlug",
        label: "Base",
        type: "text",
        required: true,
      },
      {
        key: "tableSlug",
        label: "Table",
        type: "text",
        required: true,
      },
      {
        key: "data",
        label: "Record fields (JSON, keyed by field id)",
        type: "code",
        placeholder: '{"<field-id>": "value"}',
        default: "{}",
      },
    ],
  },
  {
    type: "action.askEmployee",
    family: "action",
    label: "Ask AI employee",
    icon: "Bot",
    description: "Send a message to one of your AI employees and capture the reply as `reply`.",
    fields: [
      {
        key: "employeeSlug",
        label: "AI employee",
        type: "text",
        required: true,
      },
      {
        key: "message",
        label: "Message",
        type: "longtext",
        placeholder: "Summarize the payload: {{trigger.payload}}",
        required: true,
      },
    ],
  },
  {
    type: "action.journalNote",
    family: "action",
    label: "Journal note",
    icon: "BookOpen",
    description: "Write a note to an AI employee's journal.",
    fields: [
      { key: "employeeSlug", label: "AI employee", type: "text", required: true },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "body", label: "Body", type: "longtext" },
    ],
  },
  // ─────────────────────── Logic / IO ─────────────────────────────────────
  {
    type: "logic.http",
    family: "logic",
    label: "HTTP request",
    icon: "Globe",
    description: "Send an HTTP request and capture the response as `status`, `body`.",
    fields: [
      {
        key: "method",
        label: "Method",
        type: "select",
        default: "GET",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => ({
          value: v,
          label: v,
        })),
      },
      { key: "url", label: "URL", type: "text", required: true },
      {
        key: "headers",
        label: "Headers (JSON object)",
        type: "code",
        default: "{}",
      },
      { key: "body", label: "Body", type: "longtext" },
    ],
  },
  {
    type: "logic.set",
    family: "logic",
    label: "Set variables",
    icon: "Variable",
    description:
      "Compute named outputs from templates. Each entry resolves against upstream nodes.",
    fields: [
      {
        key: "values",
        label: "Output values (JSON: name → template)",
        type: "code",
        default: '{"value": "{{trigger.payload.name}}"}',
      },
    ],
  },
  {
    type: "logic.branch",
    family: "logic",
    label: "If / else",
    icon: "Split",
    description: "Route to the 'true' edge when both sides match, otherwise 'false'.",
    fields: [
      { key: "left", label: "Left", type: "text", required: true },
      {
        key: "operator",
        label: "Operator",
        type: "select",
        default: "eq",
        options: [
          { value: "eq", label: "equals" },
          { value: "ne", label: "not equals" },
          { value: "contains", label: "contains" },
          { value: "gt", label: "greater than" },
          { value: "lt", label: "less than" },
          { value: "truthy", label: "is truthy" },
        ],
      },
      { key: "right", label: "Right", type: "text" },
    ],
    outputs: ["true", "false"],
  },
  {
    type: "logic.delay",
    family: "logic",
    label: "Delay",
    icon: "Clock",
    description: "Pause for N seconds (capped at 60 to keep runs responsive).",
    fields: [
      {
        key: "seconds",
        label: "Seconds",
        type: "number",
        default: 5,
        required: true,
      },
    ],
  },
  // ─────────────────────── Integrations ───────────────────────────────────
  {
    type: "integration.invoke",
    family: "integration",
    label: "Call integration",
    icon: "Plug",
    description:
      "Invoke a tool on a connected Integration (Stripe, Gmail, …). Result captured as `result`.",
    fields: [
      {
        key: "connectionId",
        label: "Connection",
        type: "text",
        required: true,
      },
      {
        key: "toolName",
        label: "Action",
        type: "text",
        required: true,
        hint: "Choose an action available on this Connection.",
      },
      {
        key: "args",
        label: "Tool args (JSON)",
        type: "code",
        default: "{}",
      },
    ],
  },
];

export const CATALOG_BY_TYPE = new Map<PipelineNodeKind, NodeCatalogEntry>(
  NODE_CATALOG.map((entry) => [entry.type, entry]),
);

export function defaultsFor(type: PipelineNodeKind): Record<string, unknown> {
  const entry = CATALOG_BY_TYPE.get(type);
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  for (const f of entry.fields) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
