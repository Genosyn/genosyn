import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Bill } from "../db/entities/Bill.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { Deal } from "../db/entities/Deal.js";
import { Decision } from "../db/entities/Decision.js";
import { EmployeeFinanceGrant, FINANCE_ACCESS_RANK } from "../db/entities/EmployeeFinanceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import {
  EmployeeRevenueGrant,
  REVENUE_ACCESS_RANK,
} from "../db/entities/EmployeeRevenueGrant.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Meeting } from "../db/entities/Meeting.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SupportTicket } from "../db/entities/SupportTicket.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoLink } from "../db/entities/TodoLink.js";
import { User } from "../db/entities/User.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import {
  TODO_LINK_LABEL_CHARS,
  type LinkedTodoView,
  type TodoLinkKind,
  type TodoLinkView,
} from "../../shared/todoLinks.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { keysetPage, filterFingerprint, type Page, type PageRequest } from "./listPaging.js";
import { fullyDecodedHeaderText } from "./mail/mime.js";
import { hasCalendarAccess } from "./meetings/grants.js";
import { supportAccessAtLeast } from "./support/grants.js";
import { listAccessibleProjectIds, type ProjectActor } from "./projects.js";

/**
 * Links between Todos and the rest of the company.
 *
 * A link grants nothing. Having one on a Todo does not let anyone read what it
 * points at: every read checks the reader against the record itself and, when
 * they could not open it there, shows that a link exists without saying what
 * it is called. Going the other way, a record only lists the Todos in Projects
 * its reader can open, filtered inside the query.
 *
 * The label of an email link is its subject, which a stranger wrote. It is
 * always data to whoever reads it, and `get_todo` says so.
 */

export class TodoLinkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

/** Who is reading a link. An AI Employee's Finance read may be narrowed by a delegating Member. */
export type TodoLinkReader =
  | { kind: "member"; role: Role | undefined; financeAccess: FinanceAccess | undefined }
  | { kind: "employee"; employeeId: string; financeAccessLimit?: FinanceAccess };

function cleanLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, TODO_LINK_LABEL_CHARS);
}

/** The target's current name, or null when the company has no such record. */
async function targetLabel(
  companyId: string,
  kind: TodoLinkKind,
  targetId: string,
): Promise<string | null> {
  switch (kind) {
    case "mail_thread": {
      const row = await AppDataSource.getRepository(MailThread).findOne({
        where: { id: targetId, companyId },
        select: { id: true, subject: true },
      });
      return row ? cleanLabel(fullyDecodedHeaderText(row.subject) || "(no subject)") : null;
    }
    case "customer": {
      const row = await AppDataSource.getRepository(Customer).findOne({
        where: { id: targetId, companyId },
        select: { id: true, name: true },
      });
      return row ? cleanLabel(row.name) : null;
    }
    case "contact": {
      const row = await AppDataSource.getRepository(Contact).findOne({
        where: { id: targetId, companyId },
        select: { id: true, name: true },
      });
      return row ? cleanLabel(row.name) : null;
    }
    case "deal": {
      const row = await AppDataSource.getRepository(Deal).findOne({
        where: { id: targetId, companyId },
        select: { id: true, title: true },
      });
      return row ? cleanLabel(row.title) : null;
    }
    case "decision": {
      const row = await AppDataSource.getRepository(Decision).findOne({
        where: { id: targetId, companyId },
        select: { id: true, title: true },
      });
      return row ? cleanLabel(row.title) : null;
    }
    case "meeting": {
      const row = await AppDataSource.getRepository(Meeting).findOne({
        where: { id: targetId, companyId },
        select: { id: true, title: true },
      });
      return row ? cleanLabel(row.title || "Untitled meeting") : null;
    }
    case "run": {
      const run = await AppDataSource.getRepository(Run).findOne({
        where: { id: targetId },
        select: { id: true, routineId: true },
      });
      if (!run) return null;
      const routine = await AppDataSource.getRepository(Routine).findOne({
        where: { id: run.routineId },
        select: { id: true, name: true, employeeId: true },
      });
      if (!routine) return null;
      const owner = await AppDataSource.getRepository(AIEmployee).findOne({
        where: { id: routine.employeeId, companyId },
        select: { id: true },
      });
      return owner ? cleanLabel(routine.name) : null;
    }
    case "work_session": {
      const row = await AppDataSource.getRepository(RepositoryWorkSession).findOne({
        where: { id: targetId, companyId },
        select: { id: true, title: true },
      });
      return row ? cleanLabel(row.title || "Work session") : null;
    }
    case "estimate": {
      const row = await AppDataSource.getRepository(Estimate).findOne({
        where: { id: targetId, companyId },
        select: { id: true, number: true },
      });
      return row ? cleanLabel(row.number || "Draft") : null;
    }
    case "invoice": {
      const row = await AppDataSource.getRepository(Invoice).findOne({
        where: { id: targetId, companyId },
        select: { id: true, number: true },
      });
      return row ? cleanLabel(row.number || "Draft") : null;
    }
    case "bill": {
      const row = await AppDataSource.getRepository(Bill).findOne({
        where: { id: targetId, companyId },
        select: { id: true, number: true },
      });
      return row ? cleanLabel(row.number || "Draft") : null;
    }
    case "ticket": {
      const row = await AppDataSource.getRepository(SupportTicket).findOne({
        where: { id: targetId, companyId },
        select: { id: true, number: true, subject: true },
      });
      return row ? cleanLabel(`#${row.number} ${row.subject}`) : null;
    }
  }
}

/** What takes Finance access to read, for a Member and an AI Employee alike. */
const FINANCE_KINDS = ["customer", "estimate", "invoice", "bill"] as const;

/** Whether a Member could open this kind of record at all. */
function memberMayRead(
  kind: TodoLinkKind,
  reader: Extract<TodoLinkReader, { kind: "member" }>,
): boolean {
  if (!(FINANCE_KINDS as readonly TodoLinkKind[]).includes(kind)) return true;
  return financeAccessFor(reader.role, reader.financeAccess) !== "none";
}

/**
 * Whether an AI Employee could open each of these records through its own
 * tools. Each kind asks the Grant its reader asks; anything unrecognized reads
 * as no.
 */
async function employeeReadableKeys(
  companyId: string,
  reader: Extract<TodoLinkReader, { kind: "employee" }>,
  links: Array<Pick<TodoLink, "kind" | "targetId">>,
): Promise<Set<string>> {
  const readable = new Set<string>();
  const kinds = new Set(links.map((link) => link.kind));
  const idsOf = (kind: TodoLinkKind) =>
    links.filter((link) => link.kind === kind).map((link) => link.targetId);

  if (FINANCE_KINDS.some((kind) => kinds.has(kind)) && reader.financeAccessLimit !== "none") {
    const grant = await AppDataSource.getRepository(EmployeeFinanceGrant).findOneBy({
      companyId,
      employeeId: reader.employeeId,
    });
    if (grant && typeof FINANCE_ACCESS_RANK[grant.accessLevel] === "number") {
      for (const kind of FINANCE_KINDS) {
        for (const id of idsOf(kind)) readable.add(`${kind}:${id}`);
      }
    }
  }
  if (
    kinds.has("ticket") &&
    (await supportAccessAtLeast(companyId, reader.employeeId, "read")) !== null
  ) {
    for (const id of idsOf("ticket")) readable.add(`ticket:${id}`);
  }
  if (kinds.has("contact") || kinds.has("deal")) {
    const grant = await AppDataSource.getRepository(EmployeeRevenueGrant).findOneBy({
      employeeId: reader.employeeId,
    });
    if (grant && typeof REVENUE_ACCESS_RANK[grant.accessLevel] === "number") {
      for (const id of idsOf("contact")) readable.add(`contact:${id}`);
      for (const id of idsOf("deal")) readable.add(`deal:${id}`);
    }
  }
  if (kinds.has("mail_thread")) {
    const threads = await AppDataSource.getRepository(MailThread).find({
      where: { id: In(idsOf("mail_thread")), companyId },
      select: { id: true, accountId: true },
    });
    const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
      where: { employeeId: reader.employeeId },
      select: { id: true, accountId: true },
    });
    const accounts = new Set(grants.map((grant) => grant.accountId));
    for (const thread of threads) {
      if (accounts.has(thread.accountId)) readable.add(`mail_thread:${thread.id}`);
    }
  }
  if (kinds.has("decision")) {
    const decisions = await AppDataSource.getRepository(Decision).find({
      where: { id: In(idsOf("decision")), companyId },
      select: { id: true, employeeId: true, routedToEmployeeId: true, status: true },
    });
    for (const decision of decisions) {
      if (
        decision.employeeId === reader.employeeId ||
        (decision.routedToEmployeeId === reader.employeeId && decision.status === "pending")
      ) {
        readable.add(`decision:${decision.id}`);
      }
    }
  }
  if (kinds.has("meeting")) {
    const meetings = await AppDataSource.getRepository(Meeting).find({
      where: { id: In(idsOf("meeting")), companyId },
      select: { id: true, accountId: true },
    });
    for (const meeting of meetings) {
      if (
        !meeting.accountId ||
        (await hasCalendarAccess(reader.employeeId, meeting.accountId, "read"))
      ) {
        readable.add(`meeting:${meeting.id}`);
      }
    }
  }
  if (kinds.has("work_session")) {
    const [sessions, grants] = await Promise.all([
      AppDataSource.getRepository(RepositoryWorkSession).find({
        where: { id: In(idsOf("work_session")), companyId },
        select: { id: true, repositoryId: true, employeeId: true },
      }),
      AppDataSource.getRepository(EmployeeRepositoryGrant).find({
        where: { employeeId: reader.employeeId },
        select: { id: true, repositoryId: true },
      }),
    ]);
    const granted = new Set(grants.map((grant) => grant.repositoryId));
    // As `get_repository_work_session` has it: an employee reads its own sessions.
    for (const session of sessions) {
      if (session.employeeId === reader.employeeId && granted.has(session.repositoryId)) {
        readable.add(`work_session:${session.id}`);
      }
    }
  }
  // Any AI Employee in the company may read a Run's report (`get_run_report`).
  for (const id of idsOf("run")) readable.add(`run:${id}`);
  return readable;
}

/** The refusal an AI Employee gets when it cannot read what it tries to link. */
export async function employeeLinkAccessError(
  companyId: string,
  reader: Extract<TodoLinkReader, { kind: "employee" }>,
  kind: TodoLinkKind,
  targetId: string,
): Promise<string | null> {
  const readable = await employeeReadableKeys(companyId, reader, [{ kind, targetId }]);
  return readable.has(`${kind}:${targetId}`)
    ? null
    : `No grant: you can't read that ${kind.replace("_", " ")}, so you can't link it to a Todo.`;
}

function viewOf(link: TodoLink, canRead: boolean, path: string | null): TodoLinkView {
  return {
    id: link.id,
    kind: link.kind,
    targetId: link.targetId,
    isSource: link.isSource,
    label: canRead ? redactSensitiveText(link.label) : null,
    canRead,
    path: canRead ? path : null,
    createdAt: link.createdAt.toISOString(),
  };
}

/**
 * Where each record still standing opens, by `kind:targetId`. One query per
 * kind in use, and only for the Todos on screen that have links at all. A
 * record that is gone has no entry, so its link shows the name with nowhere to
 * go.
 */
async function targetPaths(companyId: string, links: TodoLink[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const idsOf = (kind: TodoLinkKind) => [
    ...new Set(links.filter((link) => link.kind === kind).map((link) => link.targetId)),
  ];
  const ids = {
    mail_thread: idsOf("mail_thread"),
    customer: idsOf("customer"),
    contact: idsOf("contact"),
    deal: idsOf("deal"),
    decision: idsOf("decision"),
    meeting: idsOf("meeting"),
    run: idsOf("run"),
    work_session: idsOf("work_session"),
  };
  const bySlug = async (
    entity: typeof Estimate | typeof Invoice | typeof Bill,
    kind: "estimate" | "invoice" | "bill",
    folder: string,
  ) => {
    const wanted = idsOf(kind);
    if (wanted.length === 0) return;
    const rows = await AppDataSource.getRepository(entity).find({
      where: { id: In(wanted), companyId },
      select: { id: true, slug: true },
    });
    for (const row of rows) paths.set(`${kind}:${row.id}`, `/finance/${folder}/${row.slug}`);
  };
  await bySlug(Estimate, "estimate", "estimates");
  await bySlug(Invoice, "invoice", "invoices");
  await bySlug(Bill, "bill", "bills");
  const tickets = idsOf("ticket");
  if (tickets.length) {
    const rows = await AppDataSource.getRepository(SupportTicket).find({
      where: { id: In(tickets), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`ticket:${row.id}`, `/support/tickets/${row.id}`);
  }
  if (ids.mail_thread.length) {
    const rows = await AppDataSource.getRepository(MailThread).find({
      where: { id: In(ids.mail_thread), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`mail_thread:${row.id}`, `/mail/t/${row.id}`);
  }
  if (ids.customer.length) {
    const rows = await AppDataSource.getRepository(Customer).find({
      where: { id: In(ids.customer), companyId },
      select: { id: true, slug: true },
    });
    for (const row of rows) paths.set(`customer:${row.id}`, `/customers/${row.slug}`);
  }
  if (ids.contact.length) {
    const rows = await AppDataSource.getRepository(Contact).find({
      where: { id: In(ids.contact), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`contact:${row.id}`, `/revenue/contacts/${row.id}`);
  }
  if (ids.deal.length) {
    const rows = await AppDataSource.getRepository(Deal).find({
      where: { id: In(ids.deal), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`deal:${row.id}`, `/revenue/deals/${row.id}`);
  }
  if (ids.decision.length) {
    const rows = await AppDataSource.getRepository(Decision).find({
      where: { id: In(ids.decision), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`decision:${row.id}`, `/decisions#decision-${row.id}`);
  }
  if (ids.meeting.length) {
    const rows = await AppDataSource.getRepository(Meeting).find({
      where: { id: In(ids.meeting), companyId },
      select: { id: true },
    });
    for (const row of rows) paths.set(`meeting:${row.id}`, `/meetings/${row.id}`);
  }
  if (ids.run.length) {
    const runs = await AppDataSource.getRepository(Run).find({
      where: { id: In(ids.run) },
      select: { id: true, routineId: true },
    });
    const routines = runs.length
      ? await AppDataSource.getRepository(Routine).find({
          where: { id: In(runs.map((run) => run.routineId)) },
          select: { id: true, slug: true, employeeId: true },
        })
      : [];
    const employees = routines.length
      ? await AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(routines.map((routine) => routine.employeeId)), companyId },
          select: { id: true, slug: true },
        })
      : [];
    const routineById = new Map(routines.map((routine) => [routine.id, routine]));
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    for (const run of runs) {
      const routine = routineById.get(run.routineId);
      const employee = routine ? employeeById.get(routine.employeeId) : undefined;
      if (routine && employee) {
        paths.set(`run:${run.id}`, `/routines/${employee.slug}/${routine.slug}?run=${run.id}`);
      }
    }
  }
  if (ids.work_session.length) {
    const sessions = await AppDataSource.getRepository(RepositoryWorkSession).find({
      where: { id: In(ids.work_session), companyId },
      select: { id: true, repositoryId: true },
    });
    const repositories = sessions.length
      ? await AppDataSource.getRepository(Repository).find({
          where: { id: In(sessions.map((session) => session.repositoryId)), companyId },
          select: { id: true, slug: true },
        })
      : [];
    const slugOf = new Map(repositories.map((repository) => [repository.id, repository.slug]));
    for (const session of sessions) {
      const slug = slugOf.get(session.repositoryId);
      if (slug) paths.set(`work_session:${session.id}`, `/repositories/${slug}/ai/${session.id}`);
    }
  }
  return paths;
}

/** Links on many Todos as this reader may see them, source first. */
export async function presentTodoLinks(
  companyId: string,
  todoIds: readonly string[],
  reader: TodoLinkReader,
): Promise<Map<string, TodoLinkView[]>> {
  const byTodo = new Map<string, TodoLinkView[]>();
  if (todoIds.length === 0) return byTodo;
  const repo = AppDataSource.getRepository(TodoLink);
  const rows: TodoLink[] = [];
  // A board can hold thousands of Todos; keep each IN list well under the
  // bound-parameter limits of both databases.
  for (let start = 0; start < todoIds.length; start += 500) {
    const part = await repo.find({
      where: { companyId, todoId: In(todoIds.slice(start, start + 500)) },
      order: { isSource: "DESC", createdAt: "ASC", id: "ASC" },
    });
    rows.push(...part);
  }
  if (rows.length === 0) return byTodo;
  const employeeKeys =
    reader.kind === "employee" ? await employeeReadableKeys(companyId, reader, rows) : null;
  const paths = reader.kind === "member" ? await targetPaths(companyId, rows) : null;
  for (const row of rows) {
    const key = `${row.kind}:${row.targetId}`;
    const canRead =
      reader.kind === "member"
        ? memberMayRead(row.kind, reader)
        : (employeeKeys?.has(key) ?? false);
    const list = byTodo.get(row.todoId) ?? [];
    list.push(viewOf(row, canRead, paths?.get(key) ?? null));
    byTodo.set(row.todoId, list);
  }
  return byTodo;
}

/** Whether a Member could open this record. Exposed so a route can refuse before linking. */
export function memberLinkAccessError(
  kind: TodoLinkKind,
  reader: Extract<TodoLinkReader, { kind: "member" }>,
): string | null {
  return memberMayRead(kind, reader)
    ? null
    : "You don't have Finance access, so you can't link that.";
}

/**
 * Link a Todo to a record, once. Linking something already linked changes
 * nothing except that a request to make it the source is honored when the Todo
 * has none yet. The target must be in this company; who may link it is the
 * caller's to check.
 */
export async function addTodoLink(args: {
  companyId: string;
  todoId: string;
  kind: TodoLinkKind;
  targetId: string;
  isSource?: boolean;
  createdByUserId?: string | null;
  createdByEmployeeId?: string | null;
}): Promise<TodoLink> {
  const label = await targetLabel(args.companyId, args.kind, args.targetId);
  if (label === null) throw new TodoLinkError("That record was not found", 404);

  const repo = AppDataSource.getRepository(TodoLink);
  const existing = await repo.findOneBy({
    todoId: args.todoId,
    kind: args.kind,
    targetId: args.targetId,
  });
  const hasSource = args.isSource
    ? await repo.existsBy({ todoId: args.todoId, isSource: true })
    : false;
  if (existing) {
    if (args.isSource && !existing.isSource && !hasSource) {
      existing.isSource = true;
      await repo.save(existing);
    }
    return existing;
  }
  return repo.save(
    repo.create({
      companyId: args.companyId,
      todoId: args.todoId,
      kind: args.kind,
      targetId: args.targetId,
      isSource: Boolean(args.isSource) && !hasSource,
      label,
      createdByUserId: args.createdByUserId ?? null,
      createdByEmployeeId: args.createdByEmployeeId ?? null,
    }),
  );
}

/** Remove a link. Reports whether there was one. */
export async function removeTodoLink(args: {
  companyId: string;
  todoId: string;
  kind: TodoLinkKind;
  targetId: string;
}): Promise<boolean> {
  const result = await AppDataSource.getRepository(TodoLink).delete({
    companyId: args.companyId,
    todoId: args.todoId,
    kind: args.kind,
    targetId: args.targetId,
  });
  return (result.affected ?? 0) > 0;
}

/** Delete every link on these Todos, for when the Todos themselves go. */
export async function deleteTodoLinks(todoIds: readonly string[]): Promise<void> {
  if (todoIds.length === 0) return;
  await AppDataSource.getRepository(TodoLink).delete({ todoId: In([...todoIds]) });
}

export const LINKED_TODO_PAGE = { defaultLimit: 25, maxLimit: 100 };

/**
 * The Todos linked to one record, newest link first, limited to the Projects
 * this actor can open. Not an error to find none: a Todo you can't open is one
 * you are not told about.
 */
export async function pageLinkedTodos(
  companyId: string,
  actors: readonly ProjectActor[],
  kind: TodoLinkKind,
  targetId: string,
  page: PageRequest & { budgetChars?: number },
): Promise<Page<LinkedTodoView>> {
  const sets = await Promise.all(actors.map((actor) => listAccessibleProjectIds(companyId, actor)));
  const [first, ...rest] = sets;
  const projectIds = [...(first ?? [])].filter((id) => rest.every((set) => set.has(id)));
  return keysetPage({
    query: () => {
      const qb = AppDataSource.getRepository(TodoLink)
        .createQueryBuilder("link")
        .innerJoin(Todo, "todo", "CAST(todo.id AS text) = link.todoId")
        .where("link.companyId = :companyId AND link.kind = :kind AND link.targetId = :targetId", {
          companyId,
          kind,
          targetId,
        });
      if (projectIds.length === 0) return qb.andWhere("1 = 0");
      return qb.andWhere("todo.projectId IN (:...projectIds)", { projectIds });
    },
    keys: [
      { column: "link.createdAt", direction: "DESC", type: "timestamp" },
      { column: "link.id", direction: "DESC", type: "string" },
    ],
    scope: "todo-links",
    fingerprint: filterFingerprint(companyId, { kind, targetId, actors: actors.map((a) => a.id) }),
    noun: "Todos",
    limits: LINKED_TODO_PAGE,
    page,
    present: (rows) => presentLinkedTodos(companyId, rows),
  });
}

async function presentLinkedTodos(
  companyId: string,
  links: TodoLink[],
): Promise<LinkedTodoView[]> {
  if (links.length === 0) return [];
  const todos = await AppDataSource.getRepository(Todo).findBy({
    id: In(links.map((link) => link.todoId)),
  });
  const todoById = new Map(todos.map((todo) => [todo.id, todo]));
  const projects = await AppDataSource.getRepository(Project).findBy({
    id: In(todos.map((todo) => todo.projectId)),
    companyId,
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const employeeIds = todos.flatMap((todo) =>
    todo.assigneeEmployeeId ? [todo.assigneeEmployeeId] : [],
  );
  const userIds = todos.flatMap((todo) => (todo.assigneeUserId ? [todo.assigneeUserId] : []));
  const [employees, users] = await Promise.all([
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).findBy({ id: In(employeeIds), companyId })
      : Promise.resolve([]),
    userIds.length
      ? AppDataSource.getRepository(User).findBy({ id: In(userIds) })
      : Promise.resolve([]),
  ]);
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const userById = new Map(users.map((user) => [user.id, user]));

  return links.map((link): LinkedTodoView => {
    const todo = todoById.get(link.todoId)!;
    const project = projectById.get(todo.projectId)!;
    const employee = todo.assigneeEmployeeId ? employeeById.get(todo.assigneeEmployeeId) : null;
    const user = todo.assigneeUserId ? userById.get(todo.assigneeUserId) : null;
    return {
      id: todo.id,
      key: `${project.key}-${todo.number}`,
      title: todo.title,
      status: todo.status,
      priority: todo.priority,
      isSource: link.isSource,
      project: { id: project.id, slug: project.slug, name: project.name },
      assignee: employee
        ? { kind: "ai", id: employee.id, name: employee.name, slug: employee.slug }
        : user
          ? { kind: "human", id: user.id, name: user.name }
          : null,
    };
  });
}
