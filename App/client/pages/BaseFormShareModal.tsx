import React from "react";
import {
  ArchiveRestore,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  LockKeyhole,
  RefreshCw,
  Send,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api, type BaseField, type BaseForm, type BaseFormDetail } from "@/lib/api";
import { baseFormShareState } from "@/lib/baseForms";
import { copyToClipboard } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";

export function BaseFormShareModal({
  open,
  endpoint,
  form,
  fields,
  tableArchived,
  onClose,
  onUpdated,
}: {
  open: boolean;
  endpoint: string;
  form: BaseForm;
  fields: BaseField[];
  tableArchived: boolean;
  onClose: () => void;
  onUpdated: (detail: BaseFormDetail) => void;
}) {
  const dialog = useDialog();
  const [busy, setBusy] = React.useState<"publish" | "accepting" | "rotate" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setBusy(null);
    setError(null);
    setCopyNotice(null);
  }, [open]);

  async function patchForm(
    action: "publish" | "accepting",
    patch: { published?: boolean; acceptingResponses?: boolean },
  ) {
    setBusy(action);
    setError(null);
    try {
      const next = await api.patch<BaseFormDetail>(endpoint, patch);
      onUpdated(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the public form"));
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (!form.publicUrl) return;
    setError(null);
    setCopyNotice(null);
    if (await copyToClipboard(form.publicUrl)) {
      setCopyNotice("Link copied");
    } else {
      setError("Could not access the clipboard. Select and copy the link manually.");
    }
  }

  async function rotateLink() {
    const confirmed = await dialog.confirm({
      title: "Reset the public link?",
      message:
        "The current link will stop working immediately. Anyone who needs the form will need the new link.",
      confirmLabel: "Create new link",
      variant: "danger",
    });
    if (!confirmed) return;
    setBusy("rotate");
    setError(null);
    setCopyNotice(null);
    try {
      const next = await api.post<BaseFormDetail>(`${endpoint}/rotate-link`, {});
      onUpdated(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not reset the public link"));
    } finally {
      setBusy(null);
    }
  }

  const shareState = baseFormShareState(form, fields, tableArchived);
  const requiredChoiceQuestionWithoutOptions =
    shareState.publishBlocker?.kind === "required-choice-without-options"
      ? shareState.publishBlocker.question
      : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tableArchived ? "Form unavailable" : "Share form"}
      description={
        tableArchived
          ? "Restore the destination table before making this form available again."
          : "Anyone with the public link can submit a new row to this table."
      }
      size="lg"
    >
      <div className="space-y-5">
        <FormError message={error} />

        {tableArchived ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <ArchiveRestore size={18} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-amber-950 dark:text-amber-100">
              Form unavailable while the table is archived
            </h3>
            <p className="mt-1 text-sm leading-6 text-amber-800 dark:text-amber-200">
              The public link cannot accept responses. Restore the table from the Bases sidebar,
              then return here to publish or share the form.
            </p>
          </div>
        ) : !shareState.published ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-950">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Send size={18} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
              Publish when you are ready
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
              Publishing creates a shareable, unguessable link. Your form will start accepting
              responses immediately.
            </p>
            <Button
              className="mt-4"
              disabled={busy !== null || shareState.publishBlocked}
              onClick={() => void patchForm("publish", { published: true })}
            >
              {busy === "publish" ? <Spinner size={14} /> : <Send size={14} />}
              {busy === "publish" ? "Publishing…" : "Publish form"}
            </Button>
            {form.questions.length === 0 && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Add at least one question before publishing.
              </p>
            )}
            {form.questions.length > 0 && requiredChoiceQuestionWithoutOptions && (
              <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                Add at least one choice to “{requiredChoiceQuestionWithoutOptions.label}” before
                publishing. Use Edit choices on that question.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Link2 size={15} className="text-indigo-600 dark:text-indigo-400" /> Public link
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Only people with this link can open the form.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  readOnly
                  value={form.publicUrl ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Public form URL"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                />
                <Button
                  variant="secondary"
                  disabled={!form.publicUrl}
                  onClick={() => void copyLink()}
                >
                  <Copy size={14} /> Copy link
                </Button>
                {form.publicUrl && (
                  <a
                    href={form.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    <ExternalLink size={14} /> Open form
                  </a>
                )}
              </div>
              <FormSuccess message={copyNotice} className="mt-3" />
              {!form.publicUrl && (
                <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  The public link could not be loaded. Reset it below to create a working link.
                </p>
              )}
              {shareState.urlNotice && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="font-semibold">
                    {shareState.urlNotice === "local-only"
                      ? "Local-only link"
                      : shareState.urlNotice === "insecure-http"
                        ? "Not safe for internet sharing"
                        : "Public URL not configured"}
                  </div>
                  <div className="mt-0.5">
                    {shareState.urlNotice === "local-only"
                      ? "This link uses a loopback address and only works on the machine running Genosyn. Set the public HTTPS URL at Admin → General before sharing it."
                      : shareState.urlNotice === "insecure-http"
                        ? "This HTTP link can work on a trusted local network, but responses are not protected in transit. Configure HTTPS before sharing it over the internet."
                        : "Set the public HTTPS URL at Admin → General before sharing this form outside your network."}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {form.acceptingResponses ? (
                      <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <LockKeyhole size={15} className="text-amber-600 dark:text-amber-400" />
                    )}
                    {form.acceptingResponses ? "Accepting responses" : "Form closed"}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {form.acceptingResponses
                      ? "New submissions are being added to the table."
                      : "The link stays valid, but visitors cannot submit until you reopen it."}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void patchForm("accepting", {
                      acceptingResponses: !form.acceptingResponses,
                    })
                  }
                >
                  {busy === "accepting" && <Spinner size={14} />}
                  {form.acceptingResponses ? "Close form" : "Reopen form"}
                </Button>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Reset public link
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Revoke the current link and create a new one.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void rotateLink()}
                >
                  {busy === "rotate" ? <Spinner size={14} /> : <RefreshCw size={14} />}
                  Reset public link
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
