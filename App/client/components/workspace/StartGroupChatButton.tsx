import React from "react";
import { useNavigate } from "react-router-dom";
import { Users } from "lucide-react";

import { StartGroupChatModal } from "@/components/workspace/StartGroupChatModal";
import type { Company } from "@/lib/api";
import { workspaceChannelHref } from "@/lib/workspace";

/**
 * "Group chat" on an AI Employee's own page: opens the start dialog with that
 * employee already picked to lead, and lands in the new group chat in
 * Workspace — two clicks from wherever you were talking to them.
 */
export function StartGroupChatButton({
  company,
  meId,
  employeeId,
}: {
  company: Company;
  meId: string;
  employeeId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Start a group chat with this AI Employee and others"
        aria-label="Start a group chat"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Users size={13} />
        <span className="hidden sm:inline">Group chat</span>
      </button>
      <StartGroupChatModal
        open={open}
        onClose={() => setOpen(false)}
        company={company}
        meId={meId}
        mode={{ kind: "new" }}
        initialEmployeeIds={[employeeId]}
        onStarted={(started) => {
          setOpen(false);
          navigate(workspaceChannelHref(company.slug, started.channelId));
        }}
      />
    </>
  );
}
