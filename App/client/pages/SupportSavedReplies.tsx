import React from "react";
import { useOutletContext } from "react-router-dom";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { errorMessage } from "@/lib/errors";
import { supportApi, type SupportSavedReply } from "@/lib/support";
import { SAVED_REPLY_VARIABLES } from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";

/** Replies your team writes once. They fill the composer; a person still presses Send. */
export default function SupportSavedReplies() {
  const { company } = useOutletContext<SupportOutletContext>();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [replies, setReplies] = React.useState<SupportSavedReply[] | null>(null);
  const [editing, setEditing] = React.useState<SupportSavedReply | "new" | null>(null);
  const [name, setName] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setReplies((await api.savedReplies()).savedReplies);
  }, [api]);

  React.useEffect(() => {
    load().catch((err: unknown) => {
      setError(errorMessage(err, "Could not load saved replies"));
      setReplies([]);
    });
  }, [load]);
  useLiveRefetch("support_saved_reply", () => void load().catch(() => undefined));

  function open(target: SupportSavedReply | "new") {
    setEditing(target);
    setName(target === "new" ? "" : target.name);
    setBody(target === "new" ? "" : target.body);
    setError("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editing === "new") await api.createSavedReply({ name: name.trim(), body });
      else if (editing) await api.updateSavedReply(editing.id, { name: name.trim(), body });
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not save this reply"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(reply: SupportSavedReply) {
    const yes = await dialog.confirm({
      title: `Delete "${reply.name}"?`,
      message: "Replies already sent are not affected.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!yes) return;
    try {
      await api.deleteSavedReply(reply.id);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete this reply" });
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        breadcrumbs={[
          { label: "Support", to: `/c/${company.slug}/support` },
          { label: "Saved replies" },
        ]}
        title="Saved replies"
        description="Answers your team writes once and inserts into the composer, with blanks filled in as they go."
        actions={
          <Button onClick={() => open("new")}>
            <Plus size={14} /> New saved reply
          </Button>
        }
      />
      {replies === null ? (
        <SkeletonList rows={3} />
      ) : replies.length === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No saved replies yet"
          description="Write the answers you give most often and insert them from any ticket."
        />
      ) : (
        <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {replies.map((reply) => (
            <div key={reply.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {reply.name}
                </div>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-slate-500 dark:text-slate-400">
                  {reply.body}
                </p>
                {reply.usageCount > 0 && (
                  <div className="mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    Used {reply.usageCount} {reply.usageCount === 1 ? "time" : "times"}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${reply.name}`}
                  onClick={() => open(reply)}
                >
                  <Pencil size={13} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${reply.name}`}
                  onClick={() => void remove(reply)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New saved reply" : "Edit saved reply"}
        onSubmit={save}
        footer={
          <>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim() || !body.trim()}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            label="Reply"
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            Blanks you can use:{" "}
            {SAVED_REPLY_VARIABLES.map((variable, index) => (
              <React.Fragment key={variable.token}>
                {index > 0 && ", "}
                <button
                  type="button"
                  title={variable.label}
                  className="font-mono text-slate-700 underline decoration-dotted dark:text-slate-300"
                  onClick={() => setBody((current) => `${current}{{${variable.token}}}`)}
                >
                  {`{{${variable.token}}}`}
                </button>
              </React.Fragment>
            ))}
          </div>
          <FormError message={error} />
        </div>
      </Modal>
    </div>
  );
}
