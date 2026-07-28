import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  FileSpreadsheet,
  Paperclip,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { api, type Base, type BaseDetail, type BaseField } from "../lib/api";
import type { RevenueCustomField, RevenueImportBatch, RevenueResourceType } from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { RevenueOutletCtx } from "./RevenueLayout";

type ImportRow = { sourceId: string; values: Record<string, unknown> };
type ImportReport = {
  resourceType: RevenueResourceType;
  total: number;
  createCount: number;
  duplicateCount: number;
  skippedCount: number;
  decisions: Array<{
    sourceId: string;
    action: "create" | "duplicate" | "skip";
    reason: string | null;
    preview: Record<string, unknown>;
  }>;
};

type LinkedResourceType = "account" | "contact" | "deal";
type LinkedImportReport = {
  resourceType: "account_contact_deal";
  total: number;
  createCount: number;
  duplicateCount: number;
  skippedCount: number;
  resourceCounts: Record<LinkedResourceType, { create: number; duplicate: number; skip: number }>;
  decisions: Array<{
    sourceId: string;
    action: "create" | "duplicate" | "skip";
    reason: string | null;
    resources: Record<
      LinkedResourceType,
      {
        action: "create" | "duplicate" | "skip";
        reason: string | null;
        preview: Record<string, unknown>;
      }
    >;
  }>;
};

type ImportMode = RevenueResourceType | "account_contact_deal";
type AnyImportReport = ImportReport | LinkedImportReport;
type ImportDecisionRow = {
  id: string;
  resourceType: RevenueResourceType;
  sourceId: string;
  nativeId: string | null;
  action: string;
  status: "created" | "matched" | "skipped" | "failed" | "rolled_back";
  reason: string;
};
type ImportDecisionPage = {
  batch: Pick<
    RevenueImportBatch,
    "id" | "resourceType" | "sourceKind" | "sourceLabel" | "status" | "createdAt"
  >;
  rows: ImportDecisionRow[];
  total: number;
  offset: number;
};

const TARGET_FIELDS: Record<
  RevenueResourceType,
  Array<{ key: string; label: string; required?: boolean }>
> = {
  contact: [
    { key: "name", label: "Name", required: true },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "title", label: "Title" },
    { key: "companyName", label: "Company name" },
    { key: "source", label: "Source" },
    { key: "notes", label: "Notes" },
  ],
  account: [
    { key: "name", label: "Account name", required: true },
    { key: "domain", label: "Domain" },
    { key: "websiteUrl", label: "Website" },
    { key: "industry", label: "Industry" },
    { key: "employeeCount", label: "Employee count" },
    { key: "notes", label: "Notes" },
  ],
  deal: [
    { key: "title", label: "Deal title", required: true },
    { key: "description", label: "Description" },
    { key: "amountCents", label: "Amount in minor units" },
    { key: "currency", label: "Currency" },
    { key: "stage", label: "Deal Stage" },
    { key: "source", label: "Source" },
    { key: "nextStep", label: "Next step" },
    { key: "nextFollowUpAt", label: "Next follow-up" },
    { key: "expectedCloseDate", label: "Expected close" },
  ],
  partnership: [
    { key: "name", label: "Partner name", required: true },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "websiteUrl", label: "Website" },
    { key: "integrationContext", label: "Integration context" },
    { key: "channelContext", label: "Channel context" },
    { key: "notes", label: "Notes" },
    { key: "nextFollowUpAt", label: "Next follow-up" },
  ],
};

function importFileFormat(file: File): "csv" | "json" | "ndjson" {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ndjson") || name.endsWith(".jsonl")) return "ndjson";
  if (name.endsWith(".json")) return "json";
  return "csv";
}

export default function RevenueImports() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const dialog = useDialog();
  const baseUrl = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [bases, setBases] = React.useState<Base[]>([]);
  const [baseDetail, setBaseDetail] = React.useState<BaseDetail | null>(null);
  const [batches, setBatches] = React.useState<RevenueImportBatch[] | null>(null);
  const [historyTotal, setHistoryTotal] = React.useState(0);
  const [historyOffset, setHistoryOffset] = React.useState(0);
  const [historySource, setHistorySource] = React.useState("");
  const [historyStatus, setHistoryStatus] = React.useState("");
  const [historyResource, setHistoryResource] = React.useState("");
  const [customFields, setCustomFields] = React.useState<RevenueCustomField[]>([]);
  const [resourceType, setResourceType] = React.useState<ImportMode>("account_contact_deal");
  const [sourceKind, setSourceKind] = React.useState<"base" | "file">("base");
  const [baseId, setBaseId] = React.useState("");
  const [tableId, setTableId] = React.useState("");
  const [sourceLabel, setSourceLabel] = React.useState("");
  const [sourceFields, setSourceFields] = React.useState<Array<{ id: string; name: string }>>([]);
  const [sourceRowCount, setSourceRowCount] = React.useState(0);
  const [sourceFile, setSourceFile] = React.useState<File | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [linkedMapping, setLinkedMapping] = React.useState<
    Record<LinkedResourceType, Record<string, string>>
  >({ account: {}, contact: {}, deal: {} });
  const [preview, setPreview] = React.useState<AnyImportReport | null>(null);
  const [previewConfigurationKey, setPreviewConfigurationKey] = React.useState<string | null>(null);
  const [selectedDecisionPage, setSelectedDecisionPage] = React.useState<ImportDecisionPage | null>(
    null,
  );
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const importConfigurationKey = JSON.stringify({
    resourceType,
    sourceKind,
    baseId,
    tableId,
    sourceLabel,
    sourceFile: sourceFile
      ? {
          name: sourceFile.name,
          size: sourceFile.size,
          lastModified: sourceFile.lastModified,
        }
      : null,
    mapping,
    linkedMapping,
  });

  const reloadHistory = React.useCallback(async () => {
    const params = new URLSearchParams({
      summaryOnly: "true",
      limit: "25",
      offset: historyOffset.toString(),
    });
    if (historySource) params.set("sourceKind", historySource);
    if (historyStatus) params.set("status", historyStatus);
    if (historyResource) params.set("resourceType", historyResource);
    const result = await api.get<{ rows: RevenueImportBatch[]; total: number }>(
      `${baseUrl}/imports?${params.toString()}`,
    );
    setBatches(result.rows);
    setHistoryTotal(result.total);
  }, [baseUrl, historyOffset, historyResource, historySource, historyStatus]);

  React.useEffect(() => {
    void Promise.all([
      api.get<Base[]>(`/api/companies/${company.id}/bases`).catch(() => []),
      reloadHistory(),
    ])
      .then(([baseRows]) => setBases(baseRows))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [company.id, reloadHistory]);

  const reloadCustomFields = React.useCallback(async () => {
    const result = await api.get<{ rows: RevenueCustomField[] }>(`${baseUrl}/custom-fields`);
    setCustomFields(result.rows);
  }, [baseUrl]);

  React.useEffect(() => {
    void reloadCustomFields().catch(() => setCustomFields([]));
  }, [reloadCustomFields]);

  React.useEffect(() => {
    const selected = bases.find((row) => row.id === baseId);
    if (!selected) {
      setBaseDetail(null);
      return;
    }
    api
      .get<BaseDetail>(`/api/companies/${company.id}/bases/${selected.slug}`)
      .then((detail) => {
        setBaseDetail(detail);
        setTableId(detail.tables[0]?.id ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [baseId, bases, company.id]);

  async function loadBaseSource() {
    if (!baseId || !tableId) return;
    setBusy(true);
    setError(null);
    try {
      const source = await api.get<{
        sourceLabel: string;
        fields: BaseField[];
        rows: ImportRow[];
      }>(`${baseUrl}/imports/base-source?baseId=${baseId}&tableId=${tableId}`);
      setSourceLabel(source.sourceLabel);
      setSourceFields(source.fields.map((field) => ({ id: field.id, name: field.name })));
      setSourceRowCount(source.rows.length);
      setSourceFile(null);
      setMapping({});
      setLinkedMapping({ account: {}, contact: {}, deal: {} });
      setPreview(null);
      setPreviewConfigurationKey(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const inspected = await api.uploadFile<{
        format: "csv" | "json" | "ndjson";
        sourceLabel: string;
        fields: string[];
        rowCount: number;
      }>(`${baseUrl}/imports/file/inspect`, file, {
        format: importFileFormat(file),
        sourceLabel: file.name,
      });
      setSourceLabel(inspected.sourceLabel);
      setSourceFields(inspected.fields.map((name) => ({ id: name, name })));
      setSourceRowCount(inspected.rowCount);
      setSourceFile(file);
      setMapping({});
      setLinkedMapping({ account: {}, contact: {}, deal: {} });
      setPreview(null);
      setPreviewConfigurationKey(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function payload() {
    const source = {
      sourceKind: "base" as const,
      sourceLabel: sourceLabel || "Revenue import",
      sourceBaseId: baseId,
      sourceTableId: tableId,
    };
    return resourceType === "account_contact_deal"
      ? { ...source, mapping: linkedMapping }
      : { ...source, resourceType, mapping };
  }

  async function dryRun() {
    const configurationKey = importConfigurationKey;
    setBusy(true);
    setError(null);
    try {
      const report =
        sourceKind === "file"
          ? await api.uploadFile<AnyImportReport>(`${baseUrl}/imports/file/preview`, sourceFile!, {
              format: importFileFormat(sourceFile!),
              sourceLabel: sourceLabel || sourceFile!.name,
              resourceType,
              mapping: JSON.stringify(
                resourceType === "account_contact_deal" ? linkedMapping : mapping,
              ),
            })
          : await api.post<AnyImportReport>(
              resourceType === "account_contact_deal"
                ? `${baseUrl}/imports/linked/preview`
                : `${baseUrl}/imports/preview`,
              payload(),
            );
      setPreview(report);
      setPreviewConfigurationKey(configurationKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || previewConfigurationKey !== importConfigurationKey) {
      setError("The import settings changed after the preview. Preview the import again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (sourceKind === "file") {
        await api.uploadFile(`${baseUrl}/imports/file/commit`, sourceFile!, {
          format: importFileFormat(sourceFile!),
          sourceLabel: sourceLabel || sourceFile!.name,
          resourceType,
          mapping: JSON.stringify(
            resourceType === "account_contact_deal" ? linkedMapping : mapping,
          ),
        });
      } else {
        await api.post(
          resourceType === "account_contact_deal"
            ? `${baseUrl}/imports/linked`
            : `${baseUrl}/imports`,
          payload(),
        );
      }
      setPreview(null);
      setPreviewConfigurationKey(null);
      setSourceRowCount(0);
      setSourceFile(null);
      setSourceFields([]);
      setMapping({});
      setLinkedMapping({ account: {}, contact: {}, deal: {} });
      setNotice("Import committed. The reconciliation report is saved below.");
      await reloadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rollback(id: string) {
    const confirmed = await dialog.confirm({
      title: "Roll back this import?",
      message:
        "Created records are removed only when they have not gained newer links or activity. This action is recorded in the reconciliation report.",
      confirmLabel: "Roll back import",
      variant: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ deleted: number; blocked: string[] }>(
        `${baseUrl}/imports/${id}/rollback`,
        { confirm: "ROLLBACK" },
      );
      if (result.blocked.length) {
        setError(
          `${result.deleted} rows rolled back; ${result.blocked.length} changed rows were kept safely.`,
        );
      }
      await reloadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function installMigrationFields() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ created: RevenueCustomField[] }>(
        `${baseUrl}/custom-fields/base-migration-preset`,
      );
      await reloadCustomFields();
      setNotice(
        result.created.length > 0
          ? `${result.created.length} Base migration custom fields installed.`
          : "The Base migration custom fields are already installed.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function viewReport(id: string, offset = 0) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.get<Omit<ImportDecisionPage, "offset">>(
        `${baseUrl}/imports/${id}/rows?limit=100&offset=${offset}`,
      );
      setSelectedDecisionPage({ ...result, offset });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function migrateAttachments(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        migrated: number;
        skipped: number;
        failures: string[];
        targetResourceType: RevenueResourceType;
      }>(`${baseUrl}/imports/${id}/attachments`, {});
      setNotice(
        `${result.migrated} attachments linked to ${result.targetResourceType}s; ${result.skipped} already migrated.`,
      );
      if (result.failures.length > 0) {
        setError(`${result.failures.length} attachments could not be migrated.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const customTargetFields = (target: RevenueResourceType) =>
    customFields
      .filter((field) => field.resourceType === target)
      .map((field) => ({
        key: `custom:${field.key}`,
        label: `${field.name} · custom`,
        required: field.required,
      }));
  const targetFields =
    resourceType === "account_contact_deal"
      ? []
      : [...TARGET_FIELDS[resourceType], ...customTargetFields(resourceType)];
  const linkedTargetFields = Object.fromEntries(
    (["account", "contact", "deal"] as const).map((target) => [
      target,
      [...TARGET_FIELDS[target], ...customTargetFields(target)],
    ]),
  ) as Record<LinkedResourceType, Array<{ key: string; label: string; required?: boolean }>>;
  const mappingComplete =
    resourceType === "account_contact_deal"
      ? (["account", "contact", "deal"] as const).every((target) =>
          linkedTargetFields[target].every(
            (field) => !field.required || linkedMapping[target][field.key],
          ),
        )
      : targetFields.every((field) => !field.required || mapping[field.key]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Imports" }]} />
      <div className="mb-6 mt-5">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Revenue imports
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Split one Base, CSV, JSON, or NDJSON row into a linked Account, Contact, and Deal, or
          import one resource at a time. Every commit keeps a durable reconciliation report.
        </p>
      </div>
      {error && (
        <div className="mb-4">
          <FormError message={error} />
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
            <Select
              label="Import as"
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value as ImportMode);
                setPreview(null);
                setPreviewConfigurationKey(null);
              }}
            >
              <option value="account_contact_deal">Linked Account + Contact + Deal</option>
              <option value="contact">Contacts</option>
              <option value="account">Accounts</option>
              <option value="deal">Deals</option>
              <option value="partnership">Partnerships</option>
            </Select>
            <Select
              label="Source"
              value={sourceKind}
              onChange={(e) => {
                setSourceKind(e.target.value as "base" | "file");
                setSourceRowCount(0);
                setSourceFile(null);
                setSourceFields([]);
                setPreview(null);
                setPreviewConfigurationKey(null);
              }}
            >
              <option value="base">Genosyn Base</option>
              <option value="file">CSV, JSON, or NDJSON file</option>
            </Select>
          </div>
          <Button variant="secondary" onClick={() => void installMigrationFields()} disabled={busy}>
            <Sparkles size={14} /> Install Base migration fields
          </Button>
        </div>

        {sourceKind === "base" ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Select
              label="Base"
              value={baseId}
              onChange={(e) => {
                setBaseId(e.target.value);
                setSourceLabel("");
                setSourceFields([]);
                setSourceRowCount(0);
                setMapping({});
                setLinkedMapping({ account: {}, contact: {}, deal: {} });
                setPreview(null);
                setPreviewConfigurationKey(null);
              }}
            >
              <option value="">Choose a Base</option>
              {bases.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
            <Select
              label="Table"
              value={tableId}
              onChange={(e) => {
                setTableId(e.target.value);
                setSourceLabel("");
                setSourceFields([]);
                setSourceRowCount(0);
                setMapping({});
                setLinkedMapping({ account: {}, contact: {}, deal: {} });
                setPreview(null);
                setPreviewConfigurationKey(null);
              }}
              disabled={!baseDetail}
            >
              <option value="">Choose a table</option>
              {baseDetail?.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              onClick={() => void loadBaseSource()}
              disabled={!tableId || busy}
            >
              <Database size={14} /> Load rows
            </Button>
          </div>
        ) : (
          <div className="mt-4 max-w-md">
            <Input
              label="Import file"
              type="file"
              accept=".csv,.json,.jsonl,.ndjson,text/csv,application/json,application/x-ndjson"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
          </div>
        )}

        {sourceFields.length > 0 && (
          <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-900 dark:text-slate-100">Field mapping</h2>
                <p className="text-xs text-slate-500">
                  {sourceRowCount.toLocaleString()} source rows · {sourceLabel}
                </p>
              </div>
              <Button onClick={() => void dryRun()} disabled={busy || !mappingComplete}>
                {busy ? "Checking…" : "Preview import"}
              </Button>
            </div>
            {resourceType === "account_contact_deal" ? (
              <div className="mt-4 space-y-6">
                {(["account", "contact", "deal"] as const).map((target) => (
                  <div
                    key={target}
                    className="rounded-xl border border-slate-100 p-4 dark:border-slate-800"
                  >
                    <h3 className="text-sm font-semibold capitalize text-slate-800 dark:text-slate-200">
                      {target} fields
                    </h3>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {linkedTargetFields[target].map((field) => (
                        <Select
                          key={field.key}
                          label={`${field.label}${field.required ? " *" : ""}`}
                          value={linkedMapping[target][field.key] ?? ""}
                          onChange={(event) => {
                            setLinkedMapping((current) => ({
                              ...current,
                              [target]: {
                                ...current[target],
                                [field.key]: event.target.value,
                              },
                            }));
                            setPreview(null);
                            setPreviewConfigurationKey(null);
                          }}
                        >
                          <option value="">Do not import</option>
                          {sourceFields.map((sourceField) => (
                            <option key={sourceField.id} value={sourceField.id}>
                              {sourceField.name}
                            </option>
                          ))}
                        </Select>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {targetFields.map((target) => (
                  <Select
                    key={target.key}
                    label={`${target.label}${target.required ? " *" : ""}`}
                    value={mapping[target.key] ?? ""}
                    onChange={(event) => {
                      setMapping((current) => ({
                        ...current,
                        [target.key]: event.target.value,
                      }));
                      setPreview(null);
                      setPreviewConfigurationKey(null);
                    }}
                  >
                    <option value="">Do not import</option>
                    {sourceFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {preview && previewConfigurationKey === importConfigurationKey && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">Dry-run result</h2>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                <span className="text-emerald-600">{preview.createCount} rows ready</span>
                <span className="text-amber-600">{preview.duplicateCount} duplicates</span>
                <span className="text-slate-500">{preview.skippedCount} skipped</span>
              </div>
              {preview.resourceType === "account_contact_deal" && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                  {(["account", "contact", "deal"] as const).map((target) => (
                    <span key={target} className="capitalize">
                      {target}: {preview.resourceCounts[target].create} create ·{" "}
                      {preview.resourceCounts[target].duplicate} match
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Button onClick={() => void commit()} disabled={busy || preview.createCount === 0}>
              <CheckCircle2 size={14} /> Import {preview.createCount} rows
            </Button>
          </div>
          <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-slate-100 dark:border-slate-800">
            {preview.decisions.slice(0, 200).map((decision) => {
              const dealPreview =
                "resources" in decision
                  ? decision.resources.deal.preview
                  : preview.resourceType === "deal"
                    ? decision.preview
                    : null;
              return (
                <div
                  key={decision.sourceId}
                  className="flex gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-0 dark:border-slate-800"
                >
                  <span
                    className={`w-20 shrink-0 font-medium capitalize ${decision.action === "create" ? "text-emerald-600" : decision.action === "duplicate" ? "text-amber-600" : "text-slate-500"}`}
                  >
                    {decision.action}
                  </span>
                  <div className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
                    <p className="truncate">
                      {"resources" in decision
                        ? String(
                            decision.resources.account.preview.name ||
                              decision.resources.contact.preview.name ||
                              decision.sourceId,
                          )
                        : String(
                            decision.preview.name || decision.preview.title || decision.sourceId,
                          )}
                    </p>
                    {dealPreview && (
                      <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                        Deal Stage: {String(dealPreview.stage || "Not imported")} · Source:{" "}
                        {String(dealPreview.sourceLabel || dealPreview.source || "Not imported")}
                      </p>
                    )}
                  </div>
                  {decision.reason && <span className="text-slate-500">{decision.reason}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Reconciliation history
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Every committed import keeps paginated source-row-to-native-ID decisions.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Select
            value={historySource}
            onChange={(event) => {
              setHistorySource(event.target.value);
              setHistoryOffset(0);
            }}
          >
            <option value="">Any source</option>
            <option value="base">Base</option>
            <option value="csv">CSV</option>
            <option value="json">JSON / NDJSON</option>
            <option value="connection">Connection</option>
          </Select>
          <Select
            value={historyStatus}
            onChange={(event) => {
              setHistoryStatus(event.target.value);
              setHistoryOffset(0);
            }}
          >
            <option value="">Any status</option>
            <option value="completed">Completed</option>
            <option value="rolled_back">Rolled back</option>
            <option value="failed">Failed</option>
          </Select>
          <Select
            value={historyResource}
            onChange={(event) => {
              setHistoryResource(event.target.value);
              setHistoryOffset(0);
            }}
          >
            <option value="">Any resource</option>
            <option value="account">Accounts</option>
            <option value="contact">Contacts</option>
            <option value="deal">Deals</option>
            <option value="partnership">Partnerships</option>
            <option value="account_contact_deal">Linked rows</option>
          </Select>
        </div>
        {batches === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : batches.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700">
            <FileSpreadsheet className="mx-auto mb-2" size={24} />
            No imports yet.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            {batches.map((batch) => {
              return (
                <div
                  key={batch.id}
                  className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                      {batch.sourceLabel}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {batch.resourceType === "account_contact_deal"
                        ? "linked Account + Contact + Deal"
                        : batch.resourceType}{" "}
                      · summary-only listing · {new Date(batch.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs font-medium capitalize text-slate-500">
                    {batch.status.replace("_", " ")}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void viewReport(batch.id)}
                    disabled={busy}
                  >
                    <Eye size={13} /> Report
                  </Button>
                  {batch.sourceKind === "base" && batch.status === "completed" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void migrateAttachments(batch.id)}
                      disabled={busy}
                    >
                      <Paperclip size={13} /> Migrate attachments
                    </Button>
                  )}
                  {batch.status === "completed" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void rollback(batch.id)}
                      disabled={busy}
                    >
                      <RotateCcw size={13} /> Roll back
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {historyTotal > 25 && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>
              {historyOffset + 1}–{Math.min(historyOffset + (batches?.length ?? 0), historyTotal)}{" "}
              of {historyTotal}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={historyOffset === 0}
                onClick={() => setHistoryOffset(Math.max(0, historyOffset - 25))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={historyOffset + 25 >= historyTotal}
                onClick={() => setHistoryOffset(historyOffset + 25)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
        <div className="mt-3 flex items-start gap-2 text-xs text-slate-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Rollback never deletes a record that has gained linked activity, contacts, deals,
          documents, or finance history.
        </div>
      </section>

      {selectedDecisionPage && (
        <ImportDecisionPanel
          page={selectedDecisionPage}
          baseUrl={baseUrl}
          onPage={(offset) => void viewReport(selectedDecisionPage.batch.id, offset)}
          onClose={() => setSelectedDecisionPage(null)}
        />
      )}
    </div>
  );
}

function ImportDecisionPanel({
  page,
  baseUrl,
  onPage,
  onClose,
}: {
  page: ImportDecisionPage;
  baseUrl: string;
  onPage: (offset: number) => void;
  onClose: () => void;
}) {
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            Import report · {page.batch.sourceLabel}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Import ID {page.batch.id} · {page.total} reconciled resource decisions
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X size={14} /> Close
        </Button>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-950">
            <tr>
              <th className="px-3 py-2">Source ID</th>
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">Decision</th>
              <th className="px-3 py-2">Native ID</th>
              <th className="px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2">{row.sourceId}</td>
                <td className="px-3 py-2 capitalize">{row.resourceType}</td>
                <td className="px-3 py-2 capitalize">{row.status.replace("_", " ")}</td>
                <td className="px-3 py-2 font-mono">{row.nativeId ?? "—"}</td>
                <td className="px-3 py-2">{row.reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <a
          href={`${baseUrl}/imports/${page.batch.id}/reconciliation?format=csv&limit=500&offset=0`}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
        >
          Download reconciliation CSV
        </a>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page.offset === 0}
            onClick={() => onPage(Math.max(0, page.offset - 100))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={page.offset + page.rows.length >= page.total}
            onClick={() => onPage(page.offset + 100)}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
