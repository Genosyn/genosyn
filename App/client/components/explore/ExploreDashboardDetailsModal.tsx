import React from "react";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Modal } from "../ui/Modal";

type Props = {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (details: { title: string; description: string }) => void;
};

export function ExploreDashboardDetailsModal({
  open,
  title,
  description,
  submitLabel,
  saving,
  error,
  onClose,
  onSubmit,
}: Props) {
  const [nextTitle, setNextTitle] = React.useState(title);
  const [nextDescription, setNextDescription] = React.useState(description);

  React.useEffect(() => {
    if (!open) return;
    setNextTitle(title);
    setNextDescription(description);
  }, [description, open, title]);

  return (
    <Modal open={open} onClose={onClose} title={title ? "Dashboard details" : "New dashboard"}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedTitle = nextTitle.trim();
          if (!trimmedTitle || saving) return;
          onSubmit({ title: trimmedTitle, description: nextDescription.trim() });
        }}
      >
        <label className="block">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Title</span>
          <input
            autoFocus
            value={nextTitle}
            onChange={(event) => setNextTitle(event.target.value)}
            placeholder="Revenue overview"
            maxLength={200}
            className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Description <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <textarea
            value={nextDescription}
            onChange={(event) => setNextDescription(event.target.value)}
            placeholder="What should teammates use this dashboard for?"
            maxLength={2000}
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </label>
        <FormError message={error} />
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!nextTitle.trim() || saving}>
            {saving ? "Saving…" : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
