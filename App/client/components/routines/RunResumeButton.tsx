import React from "react";
import { Play } from "lucide-react";
import { api, type Company, type Run } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";

type ResumableRun = Pick<
  Run,
  "id" | "status" | "errorKind" | "hasUnfinishedWork" | "retryAt" | "continuationPending"
>;

type RunResumeButtonProps = {
  company: Company;
  run: ResumableRun;
  routineName: string;
  onResumed: (run: Run) => void | Promise<void>;
};

/** A saved checkpoint offers progress to resume; the server rechecks all authority. */
export function RunResumeButton(props: RunResumeButtonProps) {
  const { company, run } = props;
  if (
    (company.role !== "owner" && company.role !== "admin") ||
    !run.hasUnfinishedWork ||
    run.status !== "failed" ||
    run.errorKind ||
    run.retryAt ||
    run.continuationPending
  )
    return null;
  return <ResumeAction {...props} />;
}

function ResumeAction({ company, run, routineName, onResumed }: RunResumeButtonProps) {
  const dialog = useDialog();
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);

  async function resume() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const confirmed = await dialog.confirm({
        title: `Resume ${routineName}?`,
        message:
          "Continue saved progress in a new Run. The Routine’s configured time limit starts again, with no total model token limit. The AI Employee will verify earlier Effects and current records before repeating a write or send. Current Grants, approvals and Standdowns still apply.",
        confirmLabel: "Resume unfinished work",
      });
      if (!confirmed) return;
      setBusy(true);
      const resumed = await api.post<Run>(`/api/companies/${company.id}/runs/${run.id}/resume`, {
        acknowledgeNewAllowance: true,
      });
      await onResumed(resumed);
    } catch (error) {
      void dialog.error(error, { title: "Couldn’t resume unfinished work" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="shrink-0 self-center"
      disabled={busy}
      onClick={resume}
    >
      <Play size={13} /> {busy ? "Resuming…" : "Resume unfinished work"}
    </Button>
  );
}
