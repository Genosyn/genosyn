import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  MoreHorizontal,
  Plus,
  Rows3,
  Trash2,
} from "lucide-react";

import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import { api, type BaseFormDetail, type BaseFormSummary, type Company } from "@/lib/api";
import { baseFormStatus, formatResponseTime } from "@/lib/baseForms";
import { errorMessage } from "@/lib/errors";
import { useBases } from "./BasesLayout";

export default function BaseForms({ company }: { company: Company }) {
  const { baseSlug = "", tableSlug = "" } = useParams<{
    baseSlug: string;
    tableSlug: string;
  }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const { activeDetail } = useBases();
  const [forms, setForms] = React.useState<BaseFormSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const detail = activeDetail?.base.slug === baseSlug ? activeDetail : null;
  const table = detail?.tables.find((candidate) => candidate.slug === tableSlug) ?? null;
  const tablePath = `/c/${company.slug}/bases/${baseSlug}/${tableSlug}`;
  const endpoint = table
    ? `/api/companies/${company.id}/bases/${baseSlug}/tables/${table.id}/forms`
    : null;

  const load = React.useCallback(
    async (silent = false) => {
      if (!endpoint) return;
      try {
        setForms(await api.get<BaseFormSummary[]>(endpoint));
        setError(null);
      } catch (cause) {
        if (silent) return;
        setForms([]);
        setError(errorMessage(cause, "Could not load forms"));
      }
    },
    [endpoint],
  );

  React.useEffect(() => {
    setForms(null);
    void load();
  }, [load]);

  const liveReload = React.useCallback(() => void load(true), [load]);
  useLiveRefetch(["base", "baserecord"], liveReload, table?.id ?? null);

  async function create(title: string) {
    if (!endpoint) return;
    const created = await api.post<BaseFormDetail>(endpoint, { title });
    setCreating(false);
    navigate(`${tablePath}/forms/${created.form.slug}`);
  }

  async function deleteForm(form: BaseFormSummary) {
    if (!endpoint) return;
    const confirmed = await dialog.confirm({
      title: `Delete “${form.title}”?`,
      message:
        "The form and its public link will be permanently removed. Rows already collected in the table are not affected.",
      confirmLabel: "Delete form",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`${endpoint}/${form.slug}`);
      setForms((current) => current?.filter((candidate) => candidate.id !== form.id) ?? []);
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t delete the form" });
    }
  }

  if (!detail || !table) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6 dark:border-slate-700 dark:bg-slate-900">
        <Breadcrumbs
          items={[
            { label: "Bases", to: `/c/${company.slug}/bases` },
            { label: detail.base.name, to: `/c/${company.slug}/bases/${detail.base.slug}` },
            { label: table.name, to: tablePath },
            { label: "Forms" },
          ]}
        />
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardList size={20} className="text-indigo-600 dark:text-indigo-400" />
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Forms
              </h1>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Collect responses directly into {table.name}. Every submission becomes a new row.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate(tablePath)}>
              <ArrowLeft size={14} /> Back to table
            </Button>
            <Button onClick={() => setCreating(true)} disabled={!!table.archivedAt}>
              <Plus size={14} /> New form
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-6">
        <div className="page-shell">
          {table.archivedAt && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              This table is archived, so its public forms are unavailable and cannot accept
              responses. Restore the table to publish or share them again.
            </div>
          )}
          <FormError message={error} className="mb-4" />

          {forms === null ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : forms.length === 0 && !error ? (
            <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/60 p-8 text-center dark:border-slate-700 dark:bg-slate-900/50">
              <div className="max-w-md">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                  <ClipboardList size={22} />
                </span>
                <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  No forms yet
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  Create a polished public form and send every response straight to this table.
                </p>
                <Button
                  className="mt-5"
                  onClick={() => setCreating(true)}
                  disabled={!!table.archivedAt}
                >
                  <Plus size={14} /> New form
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {forms.map((form) => {
                const status = baseFormStatus(form, !!table.archivedAt);
                return (
                  <article
                    key={form.id}
                    className="group relative flex min-h-48 flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={
                          "inline-flex items-center rounded-full px-2 py-1 text-[11px] font-semibold " +
                          (status.tone === "emerald"
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                            : status.tone === "amber"
                              ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                        }
                      >
                        {status.label}
                      </span>
                      <Menu
                        align="right"
                        width={170}
                        trigger={({ ref, onClick, open }) => (
                          <button
                            ref={ref}
                            type="button"
                            aria-label="Form actions"
                            aria-expanded={open}
                            onClick={onClick}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                      >
                        {(close) => (
                          <>
                            <MenuItem
                              icon={<ArrowRight size={14} />}
                              label="Edit form"
                              onSelect={() => {
                                close();
                                navigate(`${tablePath}/forms/${form.slug}`);
                              }}
                            />
                            <MenuSeparator />
                            <MenuItem
                              icon={<Trash2 size={14} />}
                              label="Delete"
                              className="text-rose-600 dark:text-rose-400"
                              onSelect={() => {
                                close();
                                void deleteForm(form);
                              }}
                            />
                          </>
                        )}
                      </Menu>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate(`${tablePath}/forms/${form.slug}`)}
                      className="mt-4 flex flex-1 flex-col text-left focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                    >
                      <h2 className="line-clamp-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                        {form.title}
                      </h2>
                      <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-500 dark:text-slate-400">
                        {form.description || "No description"}
                      </p>
                      <div className="mt-auto flex w-full items-end justify-between gap-3 pt-6">
                        <div>
                          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                            <Rows3 size={14} className="text-slate-400" />
                            {form.responseCount}{" "}
                            {form.responseCount === 1 ? "response" : "responses"}
                          </div>
                          <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                            {formatResponseTime(form.lastResponseAt)}
                          </div>
                        </div>
                        <ArrowRight
                          size={16}
                          className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500 dark:text-slate-600"
                        />
                      </div>
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <CreateFormModal
        open={creating}
        tableName={table.name}
        onClose={() => setCreating(false)}
        onCreate={create}
      />
    </div>
  );
}

function CreateFormModal({
  open,
  tableName,
  onClose,
  onCreate,
}: {
  open: boolean;
  tableName: string;
  onClose: () => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setTitle(`${tableName} form`);
    setError(null);
    setBusy(false);
  }, [open, tableName]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the form"));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New form"
      description={`Responses will be added as rows in ${tableName}.`}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? <Spinner size={14} /> : <Plus size={14} />}
            {busy ? "Creating…" : "Create form"}
          </Button>
        </>
      }
    >
      <FormError message={error} className="mb-3" />
      <Input
        autoFocus
        label="Form title"
        value={title}
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Contact us"
      />
    </Modal>
  );
}
