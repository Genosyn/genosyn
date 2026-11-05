/**
 * What a Todo can be linked to, in one list the server, the AI tools and the
 * browser share. A kind is here only when the product has a page to open it on
 * and a rule for who may read it (`server/services/todoLinks.ts`).
 */
export const TODO_LINK_KINDS = [
  "mail_thread",
  "customer",
  "contact",
  "deal",
  "decision",
  "meeting",
  "run",
  "work_session",
  "estimate",
  "invoice",
  "bill",
  "ticket",
] as const;

export type TodoLinkKind = (typeof TODO_LINK_KINDS)[number];

export function isTodoLinkKind(value: string): value is TodoLinkKind {
  return (TODO_LINK_KINDS as readonly string[]).includes(value);
}

/** The longest display name a link keeps. */
export const TODO_LINK_LABEL_CHARS = 200;

/** How a link reads next to its label: "Email", "Customer", … */
export const TODO_LINK_KIND_LABEL: Record<TodoLinkKind, string> = {
  mail_thread: "Email",
  customer: "Customer",
  contact: "Contact",
  deal: "Deal",
  decision: "Decision",
  meeting: "Meeting",
  run: "Run",
  work_session: "Work session",
  estimate: "Estimate",
  invoice: "Invoice",
  bill: "Bill",
  ticket: "Ticket",
};

/** A link as a reader sees it. `label` is null when this reader may not read the target. */
export type TodoLinkView = {
  id: string;
  kind: TodoLinkKind;
  targetId: string;
  /** Where the Todo came from, as opposed to something related to it. */
  isSource: boolean;
  label: string | null;
  canRead: boolean;
  /**
   * Where the record opens, under the company's root, when this reader can open
   * it and it still exists. Null for an AI Employee, which reads by id.
   */
  path: string | null;
  createdAt: string;
};

/** A Todo seen from the record it is linked to. */
export type LinkedTodoView = {
  id: string;
  /** `{Project.key}-{Todo.number}`. */
  key: string;
  title: string;
  status: string;
  priority: string;
  isSource: boolean;
  project: { id: string; slug: string; name: string };
  assignee:
    | { kind: "ai"; id: string; name: string; slug: string }
    | { kind: "human"; id: string; name: string }
    | null;
};
