import React from "react";
import { ListPlus } from "lucide-react";
import { useLocation } from "react-router-dom";

import { type Command, useRegisterCommands } from "@/components/CommandRegistry";
import type { Company, Me } from "@/lib/api";
import { projectSlugFromPath } from "@/lib/createTask";
import { CREATE_TASK_SHORTCUT, isCreateTaskShortcut } from "@/lib/keyboard";
import { CreateTaskModal } from "./CreateTaskModal";

/**
 * Create a task from wherever you are: the keyboard shortcut, or the ⌘K
 * palette for a phone or anyone who has not learned it yet.
 *
 * Unlike the single-letter shortcuts it does not pause for a field or a modal,
 * because thinking of a task mid-sentence is the point. So it opens on the
 * `dialog` layer, over a drawer or a modal that is already open, and the shared
 * modal chrome hands focus back to wherever the cursor was.
 */
export function GlobalCreateTask({ company, me }: { company: Company; me: Me }) {
  const location = useLocation();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !isCreateTaskShortcut(event)) return;
      // Claimed on a repeat and while open too: on a Mac the key held down
      // would otherwise type † into the title it just focused.
      event.preventDefault();
      if (!event.repeat) setOpen(true);
    };
    // Capture, so a field that keeps its keys to itself is still "anywhere".
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const commands = React.useMemo<Command[]>(
    () => [
      {
        id: "tasks.create",
        label: "Create a task",
        hint: CREATE_TASK_SHORTCUT,
        icon: ListPlus,
        group: "Tasks",
        everywhere: true,
        keywords: ["new task", "add task", "todo", "new todo", "add todo"],
        run: () => setOpen(true),
      },
    ],
    [],
  );
  useRegisterCommands(commands);

  return (
    <CreateTaskModal
      open={open}
      onClose={() => setOpen(false)}
      companyId={company.id}
      companySlug={company.slug}
      // New todos default to whoever created them, as on a Project's own page.
      assignToUserId={me.id}
      preferredProjectSlug={projectSlugFromPath(location.pathname)}
      layer="dialog"
    />
  );
}
