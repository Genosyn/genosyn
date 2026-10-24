import {
  RECRUITING_ACCESS_HINTS,
  RECRUITING_ACCESS_LABELS,
  RECRUITING_ACCESS_LEVELS,
} from "./recruiting.js";

/**
 * The Access page's catalogue: every kind of Grant an AI Employee can hold,
 * the levels each one has, and how the page groups them.
 *
 * A Grant is always made on the resource's own side — a mailbox's AI access, a
 * note's Share settings, Finance → AI access — and each of those surfaces keeps
 * its own rules: who may grant it, which levels exist, what is audited. The
 * Access page (`/employees/:slug/settings/access`) only gathers them in one
 * place for one AI Employee, and its bulk endpoint replays each change through
 * the kind's own route (`server/services/employeeAccess/`), so nothing here
 * decides who may do what. This file is the vocabulary both ends share: the
 * server's zod schemas take their level enums from it, and the page its words.
 *
 * Level lists mirror the entities (`EMPLOYEE_VAULT_ACCESS_LEVELS`,
 * `MAIL_ACCESS_LEVELS`, …); `services/employeeAccess/catalogue.test.ts` fails
 * when the two drift.
 */

export const ACCESS_KINDS = [
  "connection",
  "mail_account",
  "calendar",
  "repository",
  "notebook",
  "note",
  "base",
  "chart",
  "dashboard",
  "resource_library",
  "resource",
  "vault_item",
  "member_browser",
  "routines",
  "finance",
  "revenue",
  "marketing",
  "recruiting",
  "signing",
] as const;

export type AccessKind = (typeof ACCESS_KINDS)[number];

export function isAccessKind(value: unknown): value is AccessKind {
  return typeof value === "string" && (ACCESS_KINDS as readonly string[]).includes(value);
}

export type AccessLevelMeta = {
  value: string;
  /** What the level is called on the kind's own AI access surface. */
  label: string;
  /** Everything the level allows, in a sentence or two. */
  hint: string;
};

export type AccessKindMeta = {
  kind: AccessKind;
  group: AccessGroupKey;
  /** One of them: "Mailbox". */
  singular: string;
  /** Several: "Mailboxes". */
  plural: string;
  /**
   * `resource`: one Grant per AI Employee and resource (a mailbox, a note).
   * `section`: one per AI Employee for a whole part of the company (Finance).
   */
  scope: "resource" | "section";
  /** Narrowest first. Empty for a Grant that is simply held or not (a Base). */
  levels: readonly AccessLevelMeta[];
  /** The level a new Grant gets when nobody chose one — the kind's own default. */
  defaultLevel: string | null;
  /**
   * Set for the kinds every AI Employee holds whether or not anyone granted
   * them — Routines and the Resources library, which exist to *narrow* access.
   * Nothing to revoke there; only the level moves.
   */
  heldByDefault: string | null;
};

const READ_WRITE_PAGES: readonly AccessLevelMeta[] = [
  { value: "read", label: "Can view", hint: "List, search and read. Changes nothing." },
  {
    value: "write",
    label: "Can edit",
    hint: "Everything in Can view, plus create sub-pages, edit, archive and delete.",
  },
];

const READ_WRITE_EXPLORE: readonly AccessLevelMeta[] = [
  { value: "read", label: "Can view", hint: "List, open and run. Changes nothing." },
  {
    value: "write",
    label: "Can edit",
    hint: "Everything in Can view, plus rename, rewrite, rearrange and delete.",
  },
];

/** Every kind, in the order the page lists them. */
export const ACCESS_KIND_META: Readonly<Record<AccessKind, AccessKindMeta>> = {
  connection: {
    kind: "connection",
    group: "connections",
    singular: "Connection",
    plural: "Connections",
    scope: "resource",
    levels: [],
    defaultLevel: null,
    heldByDefault: null,
  },
  mail_account: {
    kind: "mail_account",
    group: "mail",
    singular: "Mailbox",
    plural: "Mailboxes",
    scope: "resource",
    levels: [
      { value: "read", label: "Read", hint: "Browse and search threads and labels. Writes nothing." },
      {
        value: "draft",
        label: "Draft",
        hint: "Everything in Read, plus write drafts, label, archive and star. A human presses Send.",
      },
      {
        value: "send",
        label: "Send",
        hint: "Everything in Draft, plus send mail from this mailbox without asking first.",
      },
    ],
    defaultLevel: "draft",
    heldByDefault: null,
  },
  calendar: {
    kind: "calendar",
    group: "calendars",
    singular: "Calendar",
    plural: "Calendars",
    scope: "resource",
    levels: [
      { value: "read", label: "Read", hint: "See the agenda, the meetings and their transcripts." },
      {
        value: "record",
        label: "Record",
        hint: "Everything in Read, plus start the notetaker on a call.",
      },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
  repository: {
    kind: "repository",
    group: "repositories",
    singular: "Repository",
    plural: "Repositories",
    scope: "resource",
    levels: [
      {
        value: "read",
        label: "Read",
        hint: "Cloned into the employee's workspace to read and commit locally. Pushing is blocked.",
      },
      {
        value: "write",
        label: "Write",
        hint: "Everything in Read, plus push its own Work session branches. Merging stays with a Member.",
      },
    ],
    defaultLevel: "write",
    heldByDefault: null,
  },
  notebook: {
    kind: "notebook",
    group: "notes",
    singular: "Notebook",
    plural: "Notebooks",
    scope: "resource",
    levels: READ_WRITE_PAGES,
    defaultLevel: "write",
    heldByDefault: null,
  },
  note: {
    kind: "note",
    group: "notes",
    singular: "Note",
    plural: "Notes",
    scope: "resource",
    levels: READ_WRITE_PAGES,
    defaultLevel: "write",
    heldByDefault: null,
  },
  base: {
    kind: "base",
    group: "bases",
    singular: "Base",
    plural: "Bases",
    scope: "resource",
    levels: [],
    defaultLevel: null,
    heldByDefault: null,
  },
  chart: {
    kind: "chart",
    group: "explore",
    singular: "Chart",
    plural: "Charts",
    scope: "resource",
    levels: READ_WRITE_EXPLORE,
    defaultLevel: "read",
    heldByDefault: null,
  },
  dashboard: {
    kind: "dashboard",
    group: "explore",
    singular: "Dashboard",
    plural: "Dashboards",
    scope: "resource",
    levels: READ_WRITE_EXPLORE,
    defaultLevel: "read",
    heldByDefault: null,
  },
  resource_library: {
    kind: "resource_library",
    group: "resources",
    singular: "Resources library",
    plural: "Resources library",
    scope: "section",
    levels: [
      {
        value: "read",
        label: "Read only",
        hint: "Read, search and export the Resources shared with it. Files, edits and deletes nothing, whatever a Resource's own Share settings say.",
      },
      {
        value: "write",
        label: "Read + write",
        hint: "File new Resources, and edit or delete the ones its Share settings allow.",
      },
    ],
    defaultLevel: "write",
    heldByDefault: "write",
  },
  resource: {
    kind: "resource",
    group: "resources",
    singular: "Resource",
    plural: "Resources",
    scope: "resource",
    levels: [
      { value: "read", label: "Read", hint: "List, search and read. Changes nothing." },
      {
        value: "edit",
        label: "Edit",
        hint: "Everything in Read, plus update its title, summary, tags and text.",
      },
      { value: "delete", label: "Delete", hint: "Everything in Edit, plus delete it for good." },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
  vault_item: {
    kind: "vault_item",
    group: "vault",
    singular: "Vault item",
    plural: "Vault items",
    scope: "resource",
    levels: [
      {
        value: "use",
        label: "Use",
        hint: "Sign in with it through governed tools. The secret never reaches the model.",
      },
      {
        value: "manage",
        label: "Manage",
        hint: "Everything in Use, plus maintain the item through the AI-native Vault tools.",
      },
    ],
    defaultLevel: "use",
    heldByDefault: null,
  },
  member_browser: {
    kind: "member_browser",
    group: "member_browsers",
    singular: "Member browser",
    plural: "Member browsers",
    scope: "resource",
    levels: [],
    defaultLevel: null,
    heldByDefault: null,
  },
  routines: {
    kind: "routines",
    group: "routines",
    singular: "Routines",
    plural: "Routines",
    scope: "section",
    levels: [
      {
        value: "run",
        label: "Read + run",
        hint: "Reads every Routine and its Runs, and its own Routines keep running. Changes no Routine.",
      },
      {
        value: "write",
        label: "Read + write",
        hint: "Everything in Read + run, plus create, edit, re-schedule, pause and delete Routines.",
      },
    ],
    defaultLevel: "write",
    heldByDefault: "write",
  },
  finance: {
    kind: "finance",
    group: "sections",
    singular: "Finance",
    plural: "Finance",
    scope: "section",
    levels: [
      {
        value: "read",
        label: "Read only",
        hint: "Open estimates, invoices, customers, statements, reports and posted transactions. Changes nothing.",
      },
      {
        value: "invoice",
        label: "Invoicing",
        hint: "Everything in Read only, plus run accounts receivable: estimates, invoices, customers and payments.",
      },
      {
        value: "full",
        label: "Full accounting",
        hint: "Everything in Invoicing, plus stage ledger re-categorizations for a human to approve.",
      },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
  revenue: {
    kind: "revenue",
    group: "sections",
    singular: "Revenue",
    plural: "Revenue",
    scope: "section",
    levels: [
      {
        value: "read",
        label: "Read only",
        hint: "See contacts, deals, activities, sequences, signals and revenue reports. Changes nothing.",
      },
      {
        value: "write",
        label: "Write",
        hint: "Everything in Read only, plus work contacts and deals, log activities and run sequences.",
      },
      {
        value: "send",
        label: "Send",
        hint: "Everything in Write, plus let auto-send sequence drafts go out with nobody pressing Send.",
      },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
  marketing: {
    kind: "marketing",
    group: "sections",
    singular: "Marketing",
    plural: "Marketing",
    scope: "section",
    levels: [
      {
        value: "read",
        label: "Read",
        hint: "Read Campaign briefs, Creative, Experiments and performance. Changes nothing.",
      },
      {
        value: "write",
        label: "Write",
        hint: "Everything in Read, plus write Campaign strategy, draft Creative and design Experiments.",
      },
      {
        value: "operate",
        label: "Operate",
        hint: "Everything in Write, plus Campaign status, Creative approval and Experiment decisions. Ad accounts still need their own Connection Grant.",
      },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
  recruiting: {
    kind: "recruiting",
    group: "sections",
    singular: "Recruiting",
    plural: "Recruiting",
    scope: "section",
    levels: RECRUITING_ACCESS_LEVELS.map((value) => ({
      value,
      label: RECRUITING_ACCESS_LABELS[value],
      hint: RECRUITING_ACCESS_HINTS[value],
    })),
    defaultLevel: "read",
    heldByDefault: null,
  },
  signing: {
    kind: "signing",
    group: "sections",
    singular: "Document signing",
    plural: "Document signing",
    scope: "section",
    levels: [
      {
        value: "read",
        label: "Read only",
        hint: "View requests, recipients, delivery status and evidence. Changes nothing.",
      },
      {
        value: "draft",
        label: "Prepare drafts",
        hint: "Everything in Read only, plus prepare drafts from PDF Resources shared with it. Sends nothing.",
      },
      {
        value: "send",
        label: "Send to customers",
        hint: "Everything in Prepare drafts, plus send invitations and reminders and void requests.",
      },
    ],
    defaultLevel: "read",
    heldByDefault: null,
  },
};

export type AccessGroupKey =
  | "connections"
  | "mail"
  | "calendars"
  | "repositories"
  | "notes"
  | "bases"
  | "explore"
  | "resources"
  | "vault"
  | "member_browsers"
  | "routines"
  | "sections";

export type AccessGroupMeta = {
  key: AccessGroupKey;
  label: string;
  /** One line under the heading: what a Grant here gives. */
  description: string;
  kinds: readonly AccessKind[];
};

/** The page's groups, in the order it lists them. */
export const ACCESS_GROUPS: readonly AccessGroupMeta[] = [
  {
    key: "connections",
    label: "Connections",
    description: "Accounts the company connected in Integrations. A Grant hands over every tool the account has.",
    kinds: ["connection"],
  },
  {
    key: "mail",
    label: "Mailboxes",
    description: "The company's own inboxes.",
    kinds: ["mail_account"],
  },
  {
    key: "calendars",
    label: "Calendars",
    description: "Connected calendars, their meetings and transcripts.",
    kinds: ["calendar"],
  },
  {
    key: "repositories",
    label: "Repositories",
    description: "Version-controlled workspaces the employee can clone and work in.",
    kinds: ["repository"],
  },
  {
    key: "notes",
    label: "Notes and notebooks",
    description: "A notebook's Grant covers every page inside it, and a page's covers its sub-pages.",
    kinds: ["notebook", "note"],
  },
  {
    key: "bases",
    label: "Bases",
    description: "A Grant reads and writes every table in the Base.",
    kinds: ["base"],
  },
  {
    key: "explore",
    label: "Charts and dashboards",
    description: "A dashboard's Grant does not reach the charts on it; grant those too.",
    kinds: ["chart", "dashboard"],
  },
  {
    key: "resources",
    label: "Resources",
    description: "The library-wide level caps what each Resource's own Grant allows.",
    kinds: ["resource_library", "resource"],
  },
  {
    key: "vault",
    label: "Vault items",
    description: "Item by item. The secret is used on the server and never reaches the model.",
    kinds: ["vault_item"],
  },
  {
    key: "member_browsers",
    label: "Member browsers",
    description: "A browser runs on a Member's own computer, so only that Member can grant it.",
    kinds: ["member_browser"],
  },
  {
    key: "routines",
    label: "Routines",
    description: "Every AI Employee reads Routines and runs its own; this decides whether it may change them.",
    kinds: ["routines"],
  },
  {
    key: "sections",
    label: "Company sections",
    description: "One level for a whole part of the company.",
    kinds: ["finance", "revenue", "marketing", "recruiting", "signing"],
  },
];

export const ACCESS_GROUP_BY_KEY: Readonly<Record<AccessGroupKey, AccessGroupMeta>> =
  Object.fromEntries(ACCESS_GROUPS.map((group) => [group.key, group])) as Record<
    AccessGroupKey,
    AccessGroupMeta
  >;

/** The values of a kind's levels, narrowest first. */
export function accessLevelValues(kind: AccessKind): string[] {
  return ACCESS_KIND_META[kind].levels.map((level) => level.value);
}

export function isAccessLevel(kind: AccessKind, value: unknown): value is string {
  return typeof value === "string" && accessLevelValues(kind).includes(value);
}

/** The level's name on its kind's own surface; the raw value when unknown. */
export function accessLevelLabel(kind: AccessKind, value: string | null | undefined): string {
  if (!value) return "";
  return ACCESS_KIND_META[kind].levels.find((level) => level.value === value)?.label ?? value;
}

/** Whether a Grant of this kind can be taken away, or only moved between levels. */
export function isRevocableKind(kind: AccessKind): boolean {
  return ACCESS_KIND_META[kind].heldByDefault === null;
}

/** One row's stable key: `note:<id>`, or the kind alone for a section. */
export function accessItemKey(kind: AccessKind, resourceId: string | null | undefined): string {
  return resourceId ? `${kind}:${resourceId}` : kind;
}

// ─────────────────────────────── the listing ───────────────────────────────

/** The most rows one kind lists. Search reaches the rest. */
export const ACCESS_LIST_LIMIT = 250;

export type AccessGrantState = {
  /** The level held; null for a kind without levels (a Base, a Connection). */
  level: string | null;
  /** Held without anyone granting it — the default every AI Employee has. */
  byDefault: boolean;
};

/** Access that reaches a row through something else: a notebook, a parent page. */
export type AccessInherited = {
  level: string;
  fromKind: AccessKind;
  fromId: string;
  fromLabel: string;
};

export type AccessItem = {
  /** `accessItemKey(kind, resourceId)`. */
  key: string;
  kind: AccessKind;
  /** The resource's id; null for a section. */
  resourceId: string | null;
  label: string;
  /** A second line: the account, the notebook, whose browser. */
  detail: string | null;
  /** Where the resource lives, under `/c/<company-slug>`. */
  href: string | null;
  /** The Grant this employee holds right now; null when it holds none. */
  grant: AccessGrantState | null;
  inherited: AccessInherited | null;
  /**
   * The viewer may not see who holds this one — Finance without Finance access,
   * a Vault item they cannot share, another Member's browser. `grant` is then
   * null whatever is true.
   */
  hidden: boolean;
  /** Whether the viewer may grant, change or revoke it. */
  canChange: boolean;
  /** Why not, in the words of the kind's own rule. */
  reason: string | null;
};

export type AccessKindStatus = {
  kind: AccessKind;
  /** More exist than were listed; search to reach them. */
  truncated: boolean;
  /** Why this viewer cannot list the kind at all, or null. */
  unavailable: string | null;
};

export type EmployeeAccessListing = {
  employee: { id: string; name: string; slug: string };
  items: AccessItem[];
  kinds: AccessKindStatus[];
  /** `ACCESS_LIST_LIMIT`, so the page can say how many it shows. */
  limit: number;
};

// ──────────────────────────────── bulk changes ────────────────────────────────

export const ACCESS_BULK_ACTIONS = ["grant", "set_level", "revoke"] as const;
export type AccessBulkAction = (typeof ACCESS_BULK_ACTIONS)[number];

/** As many as one request takes; the page sends a longer selection in parts. */
export const ACCESS_BULK_MAX_ITEMS = 200;

export type AccessBulkItem = {
  kind: AccessKind;
  /** Required for a resource kind, absent for a section. */
  resourceId?: string | null;
  /** For a kind with levels; its default level when left out. */
  level?: string;
};

export const ACCESS_BULK_OUTCOMES = [
  "granted",
  "updated",
  "revoked",
  "unchanged",
  "skipped",
  "failed",
] as const;
export type AccessBulkOutcome = (typeof ACCESS_BULK_OUTCOMES)[number];

export type AccessBulkResult = {
  key: string;
  kind: AccessKind;
  resourceId: string | null;
  outcome: AccessBulkOutcome;
  /** The level held afterwards, when there is one. */
  level: string | null;
  /** Why it was unchanged, skipped or failed. */
  message: string | null;
  /** The status the kind's own route answered with, for a failure. */
  status: number | null;
};

export type AccessBulkResponse = {
  action: AccessBulkAction;
  results: AccessBulkResult[];
  summary: Record<AccessBulkOutcome, number>;
};
