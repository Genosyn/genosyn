import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Project } from "../db/entities/Project.js";
import { Todo, TodoStatus } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { ChatTurn, chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";

/**
 * Kickoff seam.
 *
 * Assigning a todo to an AI employee is the "go" signal: the employee should
 * start working immediately, not wait for a routine or a chat message to
 * happen to look at its list. The flow mirrors the @-mention reply on a todo
 * thread (`respondAsEmployee` in routes/projects.ts):
 *
 *  1. Flip the todo to `in_progress` so the board shows the pickup at once.
 *  2. Create a pending TodoComment — the client already renders pending rows
 *     as a typing skeleton and polls until they resolve.
 *  3. Run a work session via the chat seam, briefing the employee to actually
 *     do the work with its tools and to move the todo itself via
 *     `update_todo` when it finishes.
 *  4. Post the employee's report as the comment body.
 *
 * Degradation: with no AI Model connected we skip quietly — a fresh
 * self-host uses the task manager long before anyone connects a model, and
 * spamming every assignment with a "can't work on this" comment would make
 * assigning to (placeholder) employees unusable. If the session errors, the
 * failure lands on the thread and the todo drops back to its prior status so
 * the work doesn't look in-flight forever.
 */

/**
 * Todos with a work session currently executing. Guards against a double
 * kickoff when an assignment is toggled back and forth while a session is
 * still running. In-process only — a restart clears it, which is correct
 * because the sessions it tracked died with the process.
 */
const inFlight = new Set<string>();

/** Statuses it makes sense to start work from. */
const KICKOFF_STATUSES: TodoStatus[] = ["backlog", "todo", "in_progress"];

/**
 * Start a background work session for a todo that was just assigned to an AI
 * employee. Resolves when the session ends; callers fire-and-forget. All
 * guards live here so the routes only have to say "assignee changed".
 */
export async function kickoffAssignedTodo(args: {
  companyId: string;
  todoId: string;
  employeeId: string;
}): Promise<void> {
  const { companyId, todoId, employeeId } = args;
  if (inFlight.has(todoId)) return;

  const todoRepo = AppDataSource.getRepository(Todo);
  const todo = await todoRepo.findOneBy({ id: todoId });
  if (!todo) return;
  if (todo.assigneeEmployeeId !== employeeId) return;
  if (!KICKOFF_STATUSES.includes(todo.status)) return;

  const project = await AppDataSource.getRepository(Project).findOneBy({
    id: todo.projectId,
    companyId,
  });
  if (!project) return;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!emp) return;

  // No model, no session — see the degradation note above.
  if (!(await getActiveModel(emp.id))) {
    console.log(
      `[todo-kickoff] ${project.key}-${todo.number} assigned to ${emp.slug}, ` +
        `but the employee has no AI Model connected — not starting.`,
    );
    return;
  }

  inFlight.add(todoId);
  const prevStatus = todo.status;
  try {
    todo.status = "in_progress";
    await todoRepo.save(todo);

    const commentRepo = AppDataSource.getRepository(TodoComment);
    const pending = await commentRepo.save(
      commentRepo.create({
        todoId: todo.id,
        authorUserId: null,
        authorEmployeeId: emp.id,
        body: "",
        pending: true,
      }),
    );

    const result = await chatWithEmployee(
      companyId,
      emp.id,
      composeKickoffBrief(project, todo),
      await threadHistory(todo.id, emp.id, pending.id),
    );

    // The employee's own update_todo calls may have moved the row while the
    // session ran — reload before deciding whether anything needs cleanup.
    const fresh = await todoRepo.findOneBy({ id: todoId });
    if (result.status !== "ok" && fresh) {
      // Nothing (or nothing trustworthy) happened. Drop the todo back to
      // where it was so it doesn't sit in `in_progress` with nobody working —
      // unless the employee already moved it itself, in which case its word
      // stands.
      if (fresh.status === "in_progress" && fresh.assigneeEmployeeId === emp.id) {
        fresh.status = prevStatus;
        await todoRepo.save(fresh);
      }
    }

    const row = await commentRepo.findOneBy({ id: pending.id });
    if (row) {
      row.body =
        result.status === "ok"
          ? result.reply || "(no reply)"
          : `I couldn't work on this — ${result.reply}`;
      row.pending = false;
      await commentRepo.save(row);
    }
  } finally {
    inFlight.delete(todoId);
  }
}

/**
 * The prior discussion on the todo, mapped to chat turns the same way the
 * @-mention flow does it: this employee's comments are `assistant`, everyone
 * else's are `user`. Pending rows (including our own placeholder) are noise.
 */
async function threadHistory(
  todoId: string,
  employeeId: string,
  pendingCommentId: string,
): Promise<ChatTurn[]> {
  const thread = await AppDataSource.getRepository(TodoComment).find({
    where: { todoId },
    order: { createdAt: "ASC" },
  });
  const history: ChatTurn[] = [];
  for (const c of thread) {
    if (c.id === pendingCommentId || c.pending) continue;
    history.push({
      role: c.authorEmployeeId === employeeId ? "assistant" : "user",
      content: c.body,
    });
  }
  return history;
}

function composeKickoffBrief(project: Project, todo: Todo): string {
  const ref = `${project.key}-${todo.number}`;
  const hasReviewer = !!(todo.reviewerEmployeeId || todo.reviewerUserId);
  const lines = [
    `You have just been assigned **${ref}: ${todo.title}** in project "${project.name}" (priority: ${todo.priority}${
      todo.dueAt ? `, due ${todo.dueAt.toISOString().slice(0, 10)}` : ""
    }).`,
  ];
  if (todo.description) lines.push("", "Description:", todo.description);
  lines.push(
    "",
    "---",
    "Work on this todo now. Actually do the work with your tools — don't just plan or acknowledge.",
    `- The todo is already in \`in_progress\`. When you finish, call \`update_todo\` with todoId "${todo.id}" and set status to ${
      hasReviewer
        ? '"in_review" — a reviewer is assigned and will sign it off'
        : '"done"'
    }.`,
    `- If you're blocked or the brief is too vague to act on, move the status back to "todo" via \`update_todo\` (todoId "${todo.id}") and say exactly what you need.`,
    "- Your reply is posted as a comment on the todo's thread for the team to read. Make it a crisp report: what you did, where the output lives, anything that needs a decision.",
  );
  return lines.join("\n");
}
