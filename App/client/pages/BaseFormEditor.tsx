import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  ListPlus,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";

import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { FormQuestionInput } from "@/components/forms/FormQuestionInput";
import { useNavigationGuard } from "@/components/NavigationGuard";
import { SelectOptionsEditor } from "@/pages/BaseGridCells";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  api,
  type BaseField,
  type BaseForm,
  type BaseFormDetail,
  type BaseFormQuestion,
  type Company,
  type PublicBaseFormFieldType,
  type PublicBaseFormQuestion,
  type SelectOption,
} from "@/lib/api";
import {
  PUBLIC_FORM_FIELD_TYPES,
  baseFormStatus,
  createBaseFormQuestion,
  createClientUuid,
  editableBaseForm,
  equivalentEditableBaseForms,
  formFieldTypeLabel,
  isPublicFormFieldType,
  moveBaseFormQuestion,
  publicFormFields,
  removeBaseFormQuestion,
  selectOptionsForField,
  updateBaseFormQuestion,
} from "@/lib/baseForms";
import { errorMessage } from "@/lib/errors";
import { useBases } from "./BasesLayout";
import { BaseFormShareModal } from "./BaseFormShareModal";

type EditableFormPatch = ReturnType<typeof editableBaseForm>;

export default function BaseFormEditor({ company }: { company: Company }) {
  const {
    baseSlug = "",
    tableSlug = "",
    formSlug = "",
  } = useParams<{
    baseSlug: string;
    tableSlug: string;
    formSlug: string;
  }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const navigationGuard = useNavigationGuard();
  const { activeDetail } = useBases();
  const [persisted, setPersisted] = React.useState<BaseFormDetail | null>(null);
  const [draft, setDraft] = React.useState<BaseForm | null>(null);
  const [fields, setFields] = React.useState<BaseField[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [choiceField, setChoiceField] = React.useState<BaseField | null>(null);
  const bypassGuardRef = React.useRef(false);

  const baseDetail = activeDetail?.base.slug === baseSlug ? activeDetail : null;
  const table = baseDetail?.tables.find((candidate) => candidate.slug === tableSlug) ?? null;
  const tablePath = `/c/${company.slug}/bases/${baseSlug}/${tableSlug}`;
  const formsPath = `${tablePath}/forms`;
  const endpoint = table
    ? `/api/companies/${company.id}/bases/${baseSlug}/tables/${table.id}/forms/${formSlug}`
    : null;
  const fieldsEndpoint = table
    ? `/api/companies/${company.id}/bases/${baseSlug}/tables/${table.id}/fields`
    : null;

  React.useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api
      .get<BaseFormDetail>(endpoint)
      .then((next) => {
        if (cancelled) return;
        setPersisted(next);
        setDraft(next.form);
        setFields(next.fields);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(errorMessage(cause, "Could not load this form"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const dirty = !equivalentEditableBaseForms(persisted?.form ?? null, draft);
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;

  const liveReloadCleanForm = React.useCallback(() => {
    if (!endpoint || dirtyRef.current) return;
    void api
      .get<BaseFormDetail>(endpoint)
      .then((next) => {
        // A Member may begin typing while the background request is in
        // flight. Never replace a draft that became dirty in the meantime.
        if (dirtyRef.current) return;
        setPersisted(next);
        setDraft(next.form);
        setFields(next.fields);
      })
      .catch(() => undefined);
  }, [endpoint]);
  useLiveRefetch("baserecord", liveReloadCleanForm, table?.id ?? null);

  const confirmLeaving = React.useCallback(async () => {
    if (!dirtyRef.current) return true;
    return dialog.confirm({
      title: "Leave without saving?",
      message: "Your latest form changes will be lost.",
      confirmLabel: "Leave without saving",
      variant: "danger",
    });
  }, [dialog]);
  const confirmLeavingRef = React.useRef(confirmLeaving);
  confirmLeavingRef.current = confirmLeaving;

  React.useLayoutEffect(
    () =>
      navigationGuard.register(
        (destination, onAllowed, request) => {
          if (!dirtyRef.current || bypassGuardRef.current) return false;
          if (request?.source === "history") {
            if (!window.confirm("Leave this form? Changes you have not saved will be lost.")) {
              request.cancel();
              return true;
            }
            onAllowed?.();
            return true;
          }
          void confirmLeavingRef.current().then((ok) => {
            if (!ok) return;
            bypassGuardRef.current = true;
            if (onAllowed) onAllowed();
            else navigate(destination);
          });
          return true;
        },
        () => dirtyRef.current && !bypassGuardRef.current,
      ),
    [navigate, navigationGuard],
  );

  React.useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  React.useEffect(() => {
    function interceptLink(event: MouseEvent) {
      if (!dirtyRef.current || bypassGuardRef.current) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void confirmLeavingRef.current().then((ok) => {
        if (!ok) return;
        bypassGuardRef.current = true;
        navigate(`${destination.pathname}${destination.search}${destination.hash}`);
      });
    }
    document.addEventListener("click", interceptLink, true);
    return () => document.removeEventListener("click", interceptLink, true);
  }, [navigate]);

  function editForm(patch: Partial<EditableFormPatch>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
    setSaveError(null);
  }

  function acceptDetail(next: BaseFormDetail) {
    setPersisted(next);
    setDraft(next.form);
    setFields(next.fields);
    setSaveError(null);
  }

  async function save(): Promise<boolean> {
    if (!endpoint || !draft || !dirty) return true;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.patch<BaseFormDetail>(endpoint, editableBaseForm(draft));
      acceptDetail(next);
      setSaved(true);
      return true;
    } catch (cause) {
      setSaveError(errorMessage(cause, "Could not save the form"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function navigateAway(destination: string) {
    if (!(await confirmLeaving())) return;
    bypassGuardRef.current = true;
    navigate(destination);
  }

  function updateQuestion(id: string, patch: Partial<BaseFormQuestion>) {
    if (!draft) return;
    editForm({ questions: updateBaseFormQuestion(draft.questions, id, patch) });
  }

  function addQuestion(field: BaseField) {
    if (!draft) return;
    const question = createBaseFormQuestion(field, createClientUuid());
    if (!question) return;
    editForm({
      questions: [...draft.questions, question],
    });
    setAddOpen(false);
  }

  function moveQuestion(id: string, direction: -1 | 1) {
    if (!draft) return;
    const questions = moveBaseFormQuestion(draft.questions, id, direction);
    if (questions === draft.questions) return;
    editForm({ questions });
  }

  async function createField(name: string, type: PublicBaseFormFieldType): Promise<BaseField> {
    if (!fieldsEndpoint) throw new Error("This table is unavailable");
    if (table?.archivedAt) throw new Error("Restore this table before creating a field");
    const created = await api.post<BaseField>(fieldsEndpoint, {
      name,
      type,
      config: type === "select" || type === "multiselect" ? { options: [] } : {},
    });
    setFields((current) => [...current, created]);
    addQuestion(created);
    return created;
  }

  async function saveChoices(field: BaseField, options: SelectOption[]) {
    if (!fieldsEndpoint) throw new Error("This table is unavailable");
    if (table?.archivedAt) throw new Error("Restore this table before changing its choices");
    const requiredByPublishedForm =
      !!draft?.publishedAt &&
      draft.questions.some((question) => question.required && question.fieldId === field.id);
    const usableOptions = selectOptionsForField({
      ...field,
      config: { ...field.config, options },
    });
    if (requiredByPublishedForm && usableOptions.length === 0) {
      throw new Error("Keep at least one named choice while this required question is published");
    }
    const updated = await api.patch<BaseField>(`${fieldsEndpoint}/${field.id}`, {
      config: { ...field.config, options },
    });
    setFields((current) =>
      current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    setChoiceField(null);
  }

  async function deleteForm() {
    if (!endpoint || !draft) return;
    const confirmed = await dialog.confirm({
      title: `Delete “${draft.title}”?`,
      message:
        "The form and its public link will be permanently removed. Rows already collected in the table are not affected.",
      confirmLabel: "Delete form",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(endpoint);
      bypassGuardRef.current = true;
      navigate(formsPath, { replace: true });
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t delete the form" });
    }
  }

  async function openShare() {
    if (table?.archivedAt) {
      setShareOpen(true);
      return;
    }
    if (!(await save())) return;
    setShareOpen(true);
  }

  if (loading || !baseDetail || !table) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (loadError || !draft || !persisted || !endpoint) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-5 text-center">
        <FormError message={loadError ?? "This form is unavailable."} className="w-full" />
        <Button variant="secondary" className="mt-4" onClick={() => navigate(formsPath)}>
          <ArrowLeft size={14} /> Back to forms
        </Button>
      </div>
    );
  }

  const status = baseFormStatus(draft, !!table.archivedAt);
  const availableFields = publicFormFields(fields).filter(
    (field) => !draft.questions.some((question) => question.fieldId === field.id),
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 dark:border-slate-700 dark:bg-slate-900/95">
        <Breadcrumbs
          items={[
            { label: "Bases", to: `/c/${company.slug}/bases` },
            { label: baseDetail.base.name, to: `/c/${company.slug}/bases/${baseSlug}` },
            { label: table.name, to: tablePath },
            { label: "Forms", to: formsPath },
            { label: draft.title },
          ]}
        />
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => void navigateAway(formsPath)}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Back to forms"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                  {draft.title}
                </h1>
                <span
                  className={clsx(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    status.tone === "emerald"
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : status.tone === "amber"
                        ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                  )}
                >
                  {status.label}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                {saving
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : saved
                      ? "Saved"
                      : "All changes saved"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>
              <Eye size={14} /> Preview
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void openShare()}>
              {table.archivedAt ? <ArchiveRestore size={14} /> : <Send size={14} />}
              {table.archivedAt ? "Unavailable" : "Share"}
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <Spinner size={14} /> : <Save size={14} />}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </header>

      <FormError message={saveError} className="mx-4 mt-4 sm:mx-6" />

      {table.archivedAt && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 sm:mx-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This form is unavailable while {table.name} is archived. Restore the table from the Bases
          sidebar before publishing or sharing it again.
        </div>
      )}

      <div className="grid flex-1 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <main className="min-w-0 px-4 py-6 sm:px-6 lg:py-8">
          <div className="mx-auto max-w-3xl space-y-4">
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="h-2 bg-indigo-500" />
              <div className="space-y-4 p-5 sm:p-7">
                <Input
                  label="Form title"
                  value={draft.title}
                  maxLength={160}
                  onChange={(event) => editForm({ title: event.target.value })}
                  className="h-12 text-base font-semibold"
                />
                <div>
                  <label
                    htmlFor="base-form-description"
                    className="text-sm font-medium text-slate-700 dark:text-slate-300"
                  >
                    Description
                  </label>
                  <textarea
                    id="base-form-description"
                    value={draft.description}
                    maxLength={2_000}
                    rows={3}
                    onChange={(event) => editForm({ description: event.target.value })}
                    placeholder="Tell people what this form is for and what happens next."
                    className="mt-1 min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
              </div>
            </section>

            {draft.questions.map((question, index) => {
              const field = fields.find((candidate) => candidate.id === question.fieldId) ?? null;
              return (
                <QuestionCard
                  key={question.id}
                  question={question}
                  field={field}
                  index={index}
                  count={draft.questions.length}
                  onChange={(patch) => updateQuestion(question.id, patch)}
                  onMove={(direction) => moveQuestion(question.id, direction)}
                  onRemove={() =>
                    editForm({
                      questions: removeBaseFormQuestion(draft.questions, question.id),
                    })
                  }
                  onEditChoices={() => field && setChoiceField(field)}
                  choicesEditable={!table.archivedAt}
                />
              );
            })}

            {draft.questions.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/50">
                <ListPlus size={22} className="mx-auto text-slate-400" />
                <h2 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Add your first question
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Every question writes directly to one field in {table.name}.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/50 px-4 py-4 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5 dark:hover:text-indigo-300"
            >
              <Plus size={15} /> Add question
            </button>
          </div>
        </main>

        <aside className="border-t border-slate-200 bg-white p-5 xl:border-l xl:border-t-0 dark:border-slate-700 dark:bg-slate-900">
          <div className="xl:sticky xl:top-28">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <Settings2 size={15} className="text-slate-400" /> Submission
            </div>
            <div className="mt-4 space-y-4">
              <Input
                label="Submit button label"
                value={draft.submitLabel}
                maxLength={80}
                onChange={(event) => editForm({ submitLabel: event.target.value })}
                placeholder="Submit"
              />
              <Input
                label="Success title"
                value={draft.successTitle}
                maxLength={160}
                onChange={(event) => editForm({ successTitle: event.target.value })}
                placeholder="Thanks — response received"
              />
              <div>
                <label
                  htmlFor="base-form-success-message"
                  className="text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Success message
                </label>
                <textarea
                  id="base-form-success-message"
                  value={draft.successMessage}
                  maxLength={1_000}
                  rows={4}
                  onChange={(event) => editForm({ successMessage: event.target.value })}
                  className="mt-1 min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <input
                  type="checkbox"
                  checked={draft.allowAnotherResponse}
                  onChange={(event) => editForm({ allowAnotherResponse: event.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    Allow another response
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">
                    Show a fresh-form button after a successful submission.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-6 rounded-xl bg-slate-50 p-4 dark:bg-slate-950">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Responses
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {draft.responseCount}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => void navigateAway(tablePath)}
              >
                Open table
              </Button>
            </div>

            <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void deleteForm()}
                className="flex items-center gap-2 text-sm font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
              >
                <Trash2 size={14} /> Delete form
              </button>
            </div>
          </div>
        </aside>
      </div>

      <AddQuestionModal
        open={addOpen}
        availableFields={availableFields}
        onClose={() => setAddOpen(false)}
        onAdd={addQuestion}
        onCreateField={createField}
        canCreateField={!table.archivedAt}
      />
      <ChoiceOptionsModal
        field={choiceField}
        fieldMutationDisabled={!!table.archivedAt}
        requireUsableOption={
          !!draft.publishedAt &&
          !!choiceField &&
          draft.questions.some(
            (question) => question.required && question.fieldId === choiceField.id,
          )
        }
        onClose={() => setChoiceField(null)}
        onSave={saveChoices}
      />
      <FormPreviewModal
        open={previewOpen}
        form={draft}
        fields={fields}
        onClose={() => setPreviewOpen(false)}
      />
      <BaseFormShareModal
        open={shareOpen}
        endpoint={endpoint}
        form={draft}
        fields={fields}
        tableArchived={!!table.archivedAt}
        onClose={() => setShareOpen(false)}
        onUpdated={(next) => {
          acceptDetail(next);
          setSaved(true);
        }}
      />
    </div>
  );
}

function QuestionCard({
  question,
  field,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  onEditChoices,
  choicesEditable,
}: {
  question: BaseFormQuestion;
  field: BaseField | null;
  index: number;
  count: number;
  onChange: (patch: Partial<BaseFormQuestion>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onEditChoices: () => void;
  choicesEditable: boolean;
}) {
  const preview =
    field && isPublicFormFieldType(field.type) ? internalPreviewQuestion(question, field) : null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-500/10 sm:p-6 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-indigo-700">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tabular-nums text-slate-400">{index + 1}</span>
          {field ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {isPublicFormFieldType(field.type) ? formFieldTypeLabel(field.type) : field.type}
            </span>
          ) : (
            <span className="rounded-md bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              Missing table field
            </span>
          )}
          <span className="min-w-0 truncate text-xs text-slate-400 dark:text-slate-500">
            Writes to {field?.name ?? "a field that no longer exists"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="Move question up"
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="Move question down"
            >
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
              aria-label="Remove question"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input
            label="Question"
            value={question.label}
            maxLength={160}
            onChange={(event) => onChange({ label: event.target.value })}
          />
          <Input
            label="Help text"
            value={question.description}
            maxLength={500}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="Optional guidance"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={question.required}
              onChange={(event) => onChange({ required: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
            />
            Required
          </label>
          {field && (field.type === "select" || field.type === "multiselect") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onEditChoices}
              disabled={!choicesEditable}
              title={choicesEditable ? undefined : "Restore the table before editing choices"}
            >
              Edit choices
            </Button>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-xl bg-slate-50 p-3 dark:bg-slate-950">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Preview
            </div>
            <FormQuestionInput
              question={preview}
              value={undefined}
              onChange={() => undefined}
              disabled
            />
          </div>
        )}
      </div>
    </section>
  );
}

function internalPreviewQuestion(
  question: BaseFormQuestion,
  field: BaseField,
): PublicBaseFormQuestion {
  if (!isPublicFormFieldType(field.type)) {
    throw new Error("Unsupported Form field type");
  }
  return {
    id: question.id,
    label: question.label,
    description: question.description,
    required: question.required,
    type: field.type,
    options: selectOptionsForField(field),
  };
}

function AddQuestionModal({
  open,
  availableFields,
  onClose,
  onAdd,
  onCreateField,
  canCreateField,
}: {
  open: boolean;
  availableFields: BaseField[];
  onClose: () => void;
  onAdd: (field: BaseField) => void;
  onCreateField: (name: string, type: PublicBaseFormFieldType) => Promise<BaseField>;
  canCreateField: boolean;
}) {
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<PublicBaseFormFieldType>("text");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setCreating(false);
    setName("");
    setType("text");
    setBusy(false);
    setError(null);
  }, [open]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreateField(name.trim(), type);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the table field"));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a question" size="lg">
      {creating ? (
        <form onSubmit={create}>
          <FormError message={error} className="mb-3" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              autoFocus
              label="Question and field name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Email address"
            />
            <Select
              label="Answer type"
              value={type}
              onChange={(event) => setType(event.target.value as PublicBaseFormFieldType)}
            >
              {PUBLIC_FORM_FIELD_TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {formFieldTypeLabel(candidate)}
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
            This creates a new column in the table and adds it to the form.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
              Back
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !canCreateField}>
              {busy ? <Spinner size={14} /> : <Plus size={14} />}
              {busy ? "Creating…" : "Create field"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
            Pick an existing table field, or create a new one without leaving the form.
          </p>
          <div className="mt-4 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-700">
            {availableFields.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                Every compatible field is already on this form.
              </div>
            ) : (
              availableFields.map((field) => (
                <button
                  key={field.id}
                  type="button"
                  onClick={() => onAdd(field)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                    <Check size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {field.name}
                    </span>
                    <span className="block text-xs text-slate-400 dark:text-slate-500">
                      {isPublicFormFieldType(field.type)
                        ? formFieldTypeLabel(field.type)
                        : field.type}
                    </span>
                  </span>
                  <Plus size={14} className="text-slate-400" />
                </button>
              ))
            )}
          </div>
          <Button
            variant="secondary"
            className="mt-4 w-full"
            onClick={() => setCreating(true)}
            disabled={!canCreateField}
          >
            <Plus size={14} /> Create a table field
          </Button>
          {!canCreateField && (
            <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
              Restore the table before creating new fields. Existing fields can still be added as
              questions.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function ChoiceOptionsModal({
  field,
  fieldMutationDisabled,
  requireUsableOption,
  onClose,
  onSave,
}: {
  field: BaseField | null;
  fieldMutationDisabled: boolean;
  requireUsableOption: boolean;
  onClose: () => void;
  onSave: (field: BaseField, options: SelectOption[]) => Promise<void>;
}) {
  const [options, setOptions] = React.useState<SelectOption[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hasUsableOption =
    !field || selectOptionsForField({ ...field, config: { ...field.config, options } }).length > 0;
  const saveBlocked = fieldMutationDisabled || (requireUsableOption && !hasUsableOption);

  React.useEffect(() => {
    if (!field) return;
    setOptions(selectOptionsForField(field));
    setBusy(false);
    setError(null);
  }, [field]);

  async function save() {
    if (!field) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(field, options);
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the choices"));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={field !== null}
      onClose={onClose}
      title={`Edit choices${field ? ` — ${field.name}` : ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || saveBlocked}>
            {busy ? <Spinner size={14} /> : <Save size={14} />}
            {busy ? "Saving…" : "Save choices"}
          </Button>
        </>
      }
    >
      <FormError message={error} className="mb-3" />
      {fieldMutationDisabled && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Restore the table before changing its choices.
        </p>
      )}
      {!fieldMutationDisabled && requireUsableOption && !hasUsableOption && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Keep at least one named choice while this required question is published.
        </p>
      )}
      <SelectOptionsEditor options={options} onChange={setOptions} />
    </Modal>
  );
}

function FormPreviewModal({
  open,
  form,
  fields,
  onClose,
}: {
  open: boolean;
  form: BaseForm;
  fields: BaseField[];
  onClose: () => void;
}) {
  const questions = form.questions.flatMap((question) => {
    const field = fields.find((candidate) => candidate.id === question.fieldId);
    return field && isPublicFormFieldType(field.type)
      ? [internalPreviewQuestion(question, field)]
      : [];
  });

  return (
    <Modal open={open} onClose={onClose} title="Form preview" size="xl" padded={false}>
      <div className="bg-slate-100 px-4 py-8 sm:px-8 dark:bg-slate-950">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="h-2 bg-indigo-500" />
            <div className="p-6 sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {form.title || "Untitled form"}
              </h2>
              {form.description && (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {form.description}
                </p>
              )}
              <p className="mt-4 text-xs text-slate-400">Fields marked * are required.</p>
            </div>
          </div>
          {questions.map((question) => (
            <div
              key={question.id}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {question.label || "Untitled question"}
                {question.required && <span className="ml-1 text-rose-500">*</span>}
              </div>
              {question.description && (
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {question.description}
                </p>
              )}
              <div className="mt-4">
                <FormQuestionInput
                  question={question}
                  value={undefined}
                  onChange={() => undefined}
                  disabled
                />
              </div>
            </div>
          ))}
          <Button disabled>{form.submitLabel || "Submit"}</Button>
        </div>
      </div>
    </Modal>
  );
}
