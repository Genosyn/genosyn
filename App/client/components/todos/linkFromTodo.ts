import { api } from "@/lib/api";
import type { TodoLinkKind } from "../../../shared/todoLinks";

/** A form opened from a Todo says so with this, and links what it saves. */
export const FROM_TODO_PARAM = "todoId";

/**
 * Link what a form just saved to the Todo it was opened from. The record stands either
 * way, and the Todo can link it by hand, so a failure here doesn't undo the save.
 */
export async function linkSavedToTodo(
  companyId: string,
  todoId: string | null,
  kind: TodoLinkKind,
  targetId: string,
): Promise<void> {
  if (!todoId) return;
  await api
    .post(`/api/companies/${companyId}/todos/${todoId}/links`, { kind, targetId })
    .catch(() => undefined);
}
