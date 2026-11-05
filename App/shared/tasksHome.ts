import type { TodoWaitKind } from "./todoPickups.js";

/** One Todo on Tasks home. Its words may be an AI's or a stranger's, so it's plain text. */
export type TasksHomeItem = {
  todoId: string;
  /** `{Project.key}-{Todo.number}`. */
  ref: string;
  number: number;
  title: string;
  projectSlug: string;
  projectName: string;
  assignee: { kind: "ai" | "human"; name: string } | null;
  /** The line under the title: why it needs you, what it's waiting for, what it reported. */
  detail: string;
  waitingOn: TodoWaitKind | null;
  /** When it started, began waiting or finished, by section. */
  since: string | null;
  checkAt: string | null;
};

export type TasksHomeSection = {
  /** All of them, though only so many are shown. */
  count: number;
  items: TasksHomeItem[];
};

export type TasksHome = {
  needsYou: TasksHomeSection;
  working: TasksHomeSection & { queuedCount: number };
  waiting: TasksHomeSection;
  doneToday: TasksHomeSection;
};

/** How many of a section Tasks home shows. Its count stays truthful past this. */
export const TASKS_HOME_SECTION_LIMIT = 20;
