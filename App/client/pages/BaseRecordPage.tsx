import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Trash2 } from "lucide-react";
import { api, BaseTableContent, Company } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { useBases } from "./BasesLayout";
import {
  RecordCommentsSection,
  RecordFieldsGrid,
  RecordFilesSection,
  recordApiUrl,
  recordTitle,
} from "./BaseRecordDetail";

/**
 * Full-page view of a single Base record — every column viewable and
 * editable, plus the comment thread and attachments. Deep-linkable at
 * /c/<company>/bases/<base>/<table>/r/<recordId>; the grid's drawer links
 * here via its "Open full page" button.
 */
export default function BaseRecordPage({ company }: { company: Company }) {
  const { baseSlug, tableSlug, recordId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const { activeDetail } = useBases();

  const [content, setContent] = React.useState<BaseTableContent | null>(null);
  const [loading, setLoading] = React.useState(true);

  // `activeDetail` may belong to the previous base during nav — only trust it
  // once the slug matches the URL, same rule as BaseDetail.
  const detail =
    activeDetail && activeDetail.base.slug === baseSlug ? activeDetail : null;
  const table = detail
    ? detail.tables.find((t) => t.slug === tableSlug) ?? null
    : null;

  const loadContent = React.useCallback(
    async (silent = false) => {
      if (!detail || !table) {
        // Base resolved but the table slug doesn't exist — stop loading so
        // the not-found state below renders instead of an endless spinner.
        if (detail) setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const d = await api.get<BaseTableContent>(
          `/api/companies/${company.id}/bases/${detail.base.slug}/tables/${table.id}/rows`,
        );
        setContent(d);
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [company.id, detail, table, toast],
  );

  React.useEffect(() => {
    void loadContent();
  }, [loadContent]);

  // Refetch silently when this record's table changes under us (a comment or
  // field edit from elsewhere, an AI write). Scoped to the table.
  const liveReload = React.useCallback(() => void loadContent(true), [loadContent]);
  useLiveRefetch("baserecord", liveReload, table?.id ?? null);

  if (!detail || (loading && !content)) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { base } = detail;
  const tableUrl = table
    ? `/c/${company.slug}/bases/${base.slug}/${table.slug}`
    : `/c/${company.slug}/bases/${base.slug}`;
  const record = content?.records.find((r) => r.id === recordId) ?? null;

  if (!table || !content || !record) {
    return (
      <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {!table ? "Table not found." : "Record not found — it may have been deleted."}
        </p>
        <Link
          to={tableUrl}
          className="flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <ArrowLeft size={14} /> Back to {table?.name ?? base.name}
        </Link>
      </div>
    );
  }

  const baseUrl = recordApiUrl(company, base, table, record.id);
  const title = recordTitle(content.fields, record);

  async function patchCell(fieldId: string, value: unknown) {
    try {
      await api.patch(baseUrl, { fieldId, value });
      await loadContent(true);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteRecord() {
    const ok = await dialog.confirm({
      title: "Delete this record?",
      message:
        "It will be permanently removed along with its comments and attachments.",
      confirmLabel: "Delete record",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(baseUrl);
      toast("Record deleted", "success");
      navigate(tableUrl);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const created = new Date(record.createdAt);
  const updated = new Date(record.updatedAt);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-700 dark:bg-slate-900">
        <Breadcrumbs
          items={[
            { label: "Bases", to: `/c/${company.slug}/bases` },
            { label: base.name, to: `/c/${company.slug}/bases/${base.slug}` },
            { label: table.name, to: tableUrl },
            { label: title },
          ]}
        />
        <div className="mt-1 flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h1>
          <Button variant="ghost" size="sm" onClick={() => void deleteRecord()}>
            <Trash2 size={13} className="text-red-500" />
            <span className="text-red-600 dark:text-red-400">Delete</span>
          </Button>
        </div>
        <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          Created {created.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          {" · "}
          Updated {updated.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        </div>
      </div>

      {/* Body — fields on the left, files + comments on the right. */}
      <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Fields
          </div>
          <RecordFieldsGrid
            fields={content.fields}
            record={record}
            linkOptions={content.linkOptions}
            resourceOptions={content.resourceOptions}
            onPatchCell={patchCell}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <RecordFilesSection company={company} baseUrl={baseUrl} />
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <RecordCommentsSection company={company} baseUrl={baseUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}
