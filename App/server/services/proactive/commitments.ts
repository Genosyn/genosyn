import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Decision } from "../../db/entities/Decision.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { Goal } from "../../db/entities/Goal.js";
import { Handoff } from "../../db/entities/Handoff.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { Project } from "../../db/entities/Project.js";
import { Repository } from "../../db/entities/Repository.js";
import { RepositoryWorkSession } from "../../db/entities/RepositoryWorkSession.js";
import { Todo } from "../../db/entities/Todo.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import { UUID_RE } from "../bases.js";
import { listAccessibleProjectIds } from "../projects.js";
import {
  PROACTIVE_SECTION_LIMIT,
  type ProactiveOpportunity,
  type ProactiveOpportunitySection,
} from "./opportunities.js";

const DAY_MS = 86_400_000;
const take = PROACTIVE_SECTION_LIMIT + 1;
const title = (value: string) => redactSensitiveText(value).slice(0, 120);
const section = (items: ProactiveOpportunity[]): ProactiveOpportunitySection => ({
  items: items.slice(0, PROACTIVE_SECTION_LIMIT),
  truncated: items.length > PROACTIVE_SECTION_LIMIT,
});

/** Current responsibilities, not a second scheduler or an assertion that work is finished. */
export async function getCommitmentOpportunities(
  companyId: string,
  employeeId: string,
  now = new Date(),
): Promise<Record<string, ProactiveOpportunitySection>> {
  if (
    !UUID_RE.test(employeeId) ||
    !(await AppDataSource.getRepository(AIEmployee).existsBy({ id: employeeId, companyId }))
  ) {
    throw new Error("AI Employee not found");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid opportunity time");
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const soon = new Date(now.getTime() + 7 * DAY_MS);
  const tomorrow = new Date(now.getTime() + DAY_MS);
  const projectIds = [
    ...(await listAccessibleProjectIds(companyId, { kind: "ai", id: employeeId })),
  ];

  const [todos, handoffs, decisions, goals, meetings, repositoryWorkSessions] = await Promise.all([
    projectIds.length
      ? AppDataSource.getRepository(Todo)
          .createQueryBuilder("todo")
          .select([
            "todo.id",
            "todo.projectId",
            "todo.title",
            "todo.status",
            "todo.priority",
            "todo.assigneeEmployeeId",
            "todo.reviewerEmployeeId",
            "todo.dueAt",
            "todo.updatedAt",
          ])
          .where("todo.projectId IN (:...projectIds)", { projectIds })
          .andWhere(
            "((todo.assigneeEmployeeId = :employeeId AND todo.status IN (:...statuses)) OR (todo.reviewerEmployeeId = :employeeId AND todo.status = :review))",
            {
              employeeId,
              statuses: ["backlog", "todo", "in_progress"],
              review: "in_review",
            },
          )
          .orderBy(
            "CASE WHEN todo.priority = 'urgent' THEN 0 WHEN todo.priority = 'high' THEN 1 ELSE 2 END",
            "ASC",
          )
          .addOrderBy("CASE WHEN todo.dueAt IS NULL THEN 1 ELSE 0 END", "ASC")
          .addOrderBy("todo.dueAt", "ASC")
          .addOrderBy("todo.updatedAt", "ASC")
          .addOrderBy("todo.id", "ASC")
          .take(take)
          .getMany()
      : Promise.resolve([]),
    AppDataSource.getRepository(Handoff)
      .createQueryBuilder("handoff")
      .select([
        "handoff.id",
        "handoff.title",
        "handoff.status",
        "handoff.toEmployeeId",
        "handoff.dueAt",
        "handoff.updatedAt",
      ])
      .where("handoff.companyId = :companyId", { companyId })
      .andWhere(
        "((handoff.toEmployeeId = :employeeId AND handoff.status = :pending) OR (handoff.fromEmployeeId = :employeeId AND handoff.status IN (:...resolved) AND handoff.updatedAt BETWEEN :since AND :now))",
        {
          employeeId,
          pending: "pending",
          resolved: ["completed", "declined"],
          since,
          now,
        },
      )
      .orderBy("CASE WHEN handoff.status = 'pending' THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("CASE WHEN handoff.dueAt IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("handoff.dueAt", "ASC")
      .addOrderBy("handoff.updatedAt", "DESC")
      .addOrderBy("handoff.id", "ASC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(Decision)
      .createQueryBuilder("decision")
      .select([
        "decision.id",
        "decision.title",
        "decision.status",
        "decision.routedToEmployeeId",
        "decision.decidedAt",
        "decision.createdAt",
        "decision.expiresAt",
      ])
      .where("decision.companyId = :companyId", { companyId })
      .andWhere(
        "((decision.routedToEmployeeId = :employeeId AND decision.status = :pending AND (decision.expiresAt IS NULL OR decision.expiresAt > :now)) OR (decision.employeeId = :employeeId AND decision.status = :decided AND decision.pickupStatus IN (:...pickups) AND decision.decidedAt BETWEEN :since AND :now))",
        {
          employeeId,
          pending: "pending",
          decided: "decided",
          pickups: ["none", "skipped", "failed"],
          since,
          now,
        },
      )
      .orderBy("CASE WHEN decision.urgency = 'high' THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("decision.createdAt", "DESC")
      .addOrderBy("decision.id", "ASC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(Goal)
      .createQueryBuilder("goal")
      .select([
        "goal.id",
        "goal.title",
        "goal.slug",
        "goal.metricKind",
        "goal.currentValueUpdatedAt",
        "goal.dueAt",
        "goal.updatedAt",
      ])
      .where(
        "goal.companyId = :companyId AND goal.ownerEmployeeId = :employeeId AND goal.status = :active",
        { companyId, employeeId, active: "active" },
      )
      .andWhere(
        "(goal.dueAt <= :soon OR (goal.metricKind = :manual AND (goal.currentValueUpdatedAt IS NULL OR goal.currentValueUpdatedAt < :since)))",
        { soon, manual: "manual", since },
      )
      .orderBy("CASE WHEN goal.dueAt IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("goal.dueAt", "ASC")
      .addOrderBy("goal.updatedAt", "ASC")
      .addOrderBy("goal.id", "ASC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(Meeting)
      .createQueryBuilder("meeting")
      .select([
        "meeting.id",
        "meeting.title",
        "meeting.status",
        "meeting.scheduledStartAt",
        "meeting.updatedAt",
      ])
      .where("meeting.companyId = :companyId AND meeting.notetakerEmployeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere((query) => {
        const readableCalendar = query
          .subQuery()
          .select("1")
          .from(CalendarAccount, "calendar")
          .innerJoin(
            EmployeeCalendarGrant,
            "calendarGrant",
            "calendarGrant.accountId = CAST(calendar.id AS text)",
          )
          .where(
            "CAST(calendar.id AS text) = meeting.accountId AND calendar.companyId = :companyId",
          )
          .andWhere(
            "calendarGrant.employeeId = :employeeId AND calendarGrant.accessLevel IN (:...levels)",
          )
          .getQuery();
        return `(meeting.accountId IS NULL OR EXISTS ${readableCalendar})`;
      })
      .setParameter("levels", ["read", "record"])
      .andWhere(
        "((meeting.status = :scheduled AND meeting.scheduledStartAt BETWEEN :now AND :tomorrow) OR (meeting.status = :ready AND meeting.updatedAt BETWEEN :since AND :now))",
        { scheduled: "scheduled", ready: "ready", now, tomorrow, since },
      )
      .orderBy("CASE WHEN meeting.status = 'scheduled' THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("meeting.scheduledStartAt", "ASC")
      .addOrderBy("meeting.updatedAt", "DESC")
      .addOrderBy("meeting.id", "ASC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(RepositoryWorkSession)
      .createQueryBuilder("session")
      .select(["session.id", "session.title", "session.status", "session.updatedAt"])
      .innerJoin(
        Repository,
        "repository",
        "CAST(repository.id AS text) = session.repositoryId AND repository.companyId = :companyId",
        { companyId },
      )
      .innerJoin(
        EmployeeRepositoryGrant,
        "repositoryGrant",
        "repositoryGrant.repositoryId = CAST(repository.id AS text) AND repositoryGrant.employeeId = :employeeId AND repositoryGrant.accessLevel IN (:...levels)",
        { employeeId, levels: ["read", "write"] },
      )
      .where("session.companyId = :companyId AND session.employeeId = :employeeId", {
        companyId,
        employeeId,
      })
      .andWhere("session.status IN (:...statuses) AND session.updatedAt BETWEEN :since AND :now", {
        statuses: ["ready", "empty", "proposed", "published", "failed"],
        since,
        now,
      })
      .orderBy("session.updatedAt", "DESC")
      .addOrderBy("session.id", "ASC")
      .take(take)
      .getMany(),
  ]);
  const projects = todos.length
    ? await AppDataSource.getRepository(Project).find({
        where: { id: In(todos.map((todo) => todo.projectId)), companyId },
        select: ["id", "slug"],
      })
    : [];
  const projectSlugs = new Map(projects.map((project) => [project.id, project.slug]));

  return {
    todos: section(
      todos.map((todo) => ({
        id: todo.id,
        kind: "todo",
        title: title(todo.title),
        locator: projectSlugs.get(todo.projectId),
        reason:
          todo.status === "in_review"
            ? "Assigned to you for review; inspect the completed work before deciding its next state."
            : `Assigned to you; current status ${todo.status}, priority ${todo.priority}. Check existing work before advancing it.`,
        updatedAt: todo.updatedAt.toISOString(),
        dueAt: todo.dueAt?.toISOString() ?? null,
        tools: ["get_todo"],
      })),
    ),
    handoffs: section(
      handoffs.map((handoff) => ({
        id: handoff.id,
        kind: "handoff",
        title: title(handoff.title),
        reason:
          handoff.status === "pending"
            ? "Pending work delegated to you; check whether an existing session already started it."
            : `Your outgoing Handoff was ${handoff.status}; read the resolution and continue or reroute only when needed.`,
        updatedAt: handoff.updatedAt.toISOString(),
        dueAt: handoff.dueAt?.toISOString() ?? null,
        tools: ["list_handoffs"],
      })),
    ),
    decisions: section(
      decisions.map((decision) => ({
        id: decision.id,
        kind: "decision",
        title: title(decision.title),
        reason:
          decision.status === "pending"
            ? "A pending Decision is routed to you; inspect its choices before answering."
            : "Your Decision has an answer and no successful automatic pickup. Read it and preserve the originating work's authority limits.",
        updatedAt: (decision.decidedAt ?? decision.createdAt).toISOString(),
        dueAt: decision.expiresAt?.toISOString() ?? null,
        tools: ["list_decisions"],
      })),
    ),
    goals: section(
      goals.map((goal) => ({
        id: goal.id,
        kind: "goal",
        title: title(goal.title),
        locator: goal.slug,
        reason:
          goal.dueAt && goal.dueAt <= soon
            ? "Your active Goal is due within seven days or overdue; inspect evidence and its supporting work."
            : "Your manual Goal has no recent progress report; verify a current measurement before reporting any value.",
        updatedAt: goal.updatedAt.toISOString(),
        dueAt: goal.dueAt?.toISOString() ?? null,
        tools: ["get_goal"],
      })),
    ),
    meetings: section(
      meetings.map((meeting) => ({
        id: meeting.id,
        kind: "meeting",
        title: title(meeting.title || "Untitled meeting"),
        reason:
          meeting.status === "scheduled"
            ? "You are the assigned notetaker for a meeting in the next day; review context and existing preparation."
            : "A meeting assigned to you has a ready record; inspect its existing action items before creating any follow-up.",
        updatedAt: meeting.updatedAt.toISOString(),
        dueAt:
          meeting.status === "scheduled" ? (meeting.scheduledStartAt?.toISOString() ?? null) : null,
        tools: ["get_meeting"],
      })),
    ),
    repositoryWorkSessions: section(
      repositoryWorkSessions.map((session) => ({
        id: session.id,
        kind: "repository_work_session",
        title: title(session.title),
        reason:
          session.status === "ready"
            ? "Your Repository work is ready for inspection. Review changes and tests; publication still requires the Soul, current Grants and PR review path."
            : `Your Repository Work session is ${session.status}. Inspect its actual result and existing follow-up before continuing or claiming completion.`,
        updatedAt: session.updatedAt.toISOString(),
        tools: ["get_repository_work_session"],
      })),
    ),
  };
}
