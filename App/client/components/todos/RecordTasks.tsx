import React from "react";
import { ListPlus } from "lucide-react";

import { CreateTaskModal } from "@/components/todos/CreateTaskModal";
import { LinkedTodosCard } from "@/components/todos/TodoLinks";
import { Button } from "@/components/ui/Button";
import type { TodoLinkKind } from "../../../shared/todoLinks";

/**
 * The Tasks a record has, and the way to file another from it, for a record's page.
 * Filing one links it to the record, so it can always be found from either side.
 */
export function RecordTasks({
  companyId,
  companySlug,
  kind,
  targetId,
  what,
  suggestedTitle,
  className,
}: {
  companyId: string;
  companySlug: string;
  kind: TodoLinkKind;
  targetId: string;
  /** What it's filed from, for the heading: "this estimate". */
  what: string;
  suggestedTitle: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  return (
    <div className={className}>
      <div className="space-y-2">
        <LinkedTodosCard
          companyId={companyId}
          companySlug={companySlug}
          kind={kind}
          targetId={targetId}
          reloadKey={reloadKey}
        />
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <ListPlus size={14} className="mr-1.5" /> Create task
        </Button>
      </div>
      <CreateTaskModal
        open={open}
        onClose={() => setOpen(false)}
        companyId={companyId}
        companySlug={companySlug}
        link={{ kind, targetId }}
        what={what}
        suggestedTitle={suggestedTitle}
        onCreated={() => setReloadKey((key) => key + 1)}
      />
    </div>
  );
}
