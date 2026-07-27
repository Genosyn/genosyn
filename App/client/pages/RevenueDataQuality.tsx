import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  Archive,
  Check,
  DatabaseZap,
  Download,
  FileSearch,
  GitMerge,
  History,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

type ResourceType = "account" | "contact" | "deal" | "partnership";
type DuplicateCandidate = {
  id: string;
  resourceType: ResourceType;
  leftId: string;
  rightId: string;
  score: number;
  reasonsJson: string;
  status: "open" | "dismissed" | "merged";
};
type Evidence = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  fieldKey: string;
  sourceType: string;
  sourceLabel: string;
  extractedValueJson: string;
  confidence: number;
  status: "proposed" | "accepted" | "rejected" | "superseded";
};
type DocumentCandidate = {
  id: string;
  filename: string;
  proposedKind: string;
  proposedResourceType: ResourceType | null;
  proposedResourceId: string | null;
  confidence: number;
  status: "pending" | "accepted" | "rejected" | "duplicate";
  revenueDocumentId: string | null;
};
type Operation = {
  id: string;
  kind: "merge" | "bulk" | "history_import";
  resourceType: ResourceType | "follow_up";
  status: "completed" | "partial" | "failed" | "rolled_back";
  summaryJson: string;
  createdAt: string;
};
type MergePreview = {
  resourceType: ResourceType;
  source: { id: string; label: string };
  target: { id: string; label: string };
  fieldConflicts: Array<{
    field: string;
    label: string;
    sourceValue: unknown;
    targetValue: unknown;
    resolution: string;
  }>;
  relationshipCounts: Record<string, number>;
  customValuesCopied: number;
  customValueConflicts: number;
};
type BulkResult = {
  dryRun: boolean;
  matched: number;
  valid: number;
  applied: number;
  skipped: number;
  failed: number;
  operationId?: string;
  rows: Array<{
    resourceId: string;
    source?: string;
    label: string;
    status: string;
    error?: string;
  }>;
};
type HistoryImportSummary = {
  dryRun: boolean;
  operationId?: string;
  imported: number;
  accepted: number;
  rejected: number;
  reordered: number;
  conflicting: number;
  duplicates: number;
  rows: Array<{
    sourceId: string;
    status: string;
    decisions: Array<{
      sourceId: string;
      kind: string;
      status: string;
      reordered: boolean;
      reason?: string;
    }>;
  }>;
};

const EXPORTS = [
  "accounts",
  "contacts",
  "deals",
  "partnerships",
  "buying_committees",
  "follow_ups",
  "documents",
  "stage_definitions",
  "custom_fields",
  "import_reconciliation",
] as const;

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function actionBody(
  resourceType: ResourceType | "follow_up",
  action: string,
  value: string,
): Record<string, unknown> {
  if (action === "archive") return { type: "archive", archived: true };
  if (action === "restore") return { type: "archive", archived: false };
  if (action === "lifecycle") return { type: "set_contact_lifecycle", lifecycleStage: value };
  if (action === "account_status") return { type: "set_account_status", accountStatus: value };
  if (action === "cancel") return { type: "update_follow_up", taskStatus: "cancelled" };
  if (action === "complete") return { type: "update_follow_up", taskStatus: "completed" };
  if (action === "priority") return { type: "update_follow_up", priority: value };
  if (action === "reschedule") {
    return { type: "update_follow_up", dueAt: new Date(value).toISOString() };
  }
  if (action === "custom_fields") return { type: "set_custom_fields", values: parsedJson(value) };
  if (resourceType === "follow_up") {
    return {
      type: "update_follow_up",
      assignedUserId: value || null,
      assignedEmployeeId: null,
    };
  }
  return { type: "assign_owner", ownerId: value || null, ownerEmployeeId: null };
}

export default function RevenueDataQuality() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { toast, background } = useToast();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [duplicates, setDuplicates] = React.useState<DuplicateCandidate[] | null>(null);
  const [evidence, setEvidence] = React.useState<Evidence[] | null>(null);
  const [documents, setDocuments] = React.useState<DocumentCandidate[] | null>(null);
  const [operations, setOperations] = React.useState<Operation[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mergeCandidate, setMergeCandidate] = React.useState<DuplicateCandidate | null>(null);
  const [survivorId, setSurvivorId] = React.useState("");
  const [mergePreview, setMergePreview] = React.useState<MergePreview | null>(null);
  const [mergeConfirm, setMergeConfirm] = React.useState("");
  const [bulkResource, setBulkResource] = React.useState<ResourceType | "follow_up">("account");
  const [bulkAction, setBulkAction] = React.useState("archive");
  const [bulkValue, setBulkValue] = React.useState("");
  const [bulkIds, setBulkIds] = React.useState("");
  const [bulkFilter, setBulkFilter] = React.useState("");
  const [bulkResult, setBulkResult] = React.useState<BulkResult | null>(null);
  const [historyJson, setHistoryJson] = React.useState("");
  const [historyPreview, setHistoryPreview] = React.useState<HistoryImportSummary | null>(null);
  const [historyPreviewPayload, setHistoryPreviewPayload] = React.useState("");
  const [documentLinks, setDocumentLinks] = React.useState<
    Record<string, { resourceType: ResourceType; resourceId: string }>
  >({});
  const [exporting, setExporting] = React.useState<(typeof EXPORTS)[number] | null>(null);

  const reload = React.useCallback(async () => {
    const [duplicatePage, evidencePage, documentPage, operationPage] = await Promise.all([
      api.get<{ rows: DuplicateCandidate[] }>(`${base}/duplicates?status=open`),
      api.get<{ rows: Evidence[] }>(`${base}/enrichment/evidence?status=proposed`),
      api.get<{ rows: DocumentCandidate[] }>(`${base}/document-capture/candidates?status=pending`),
      api.get<{ rows: Operation[] }>(`${base}/operations?limit=25`),
    ]);
    setDuplicates(duplicatePage.rows);
    setEvidence(evidencePage.rows);
    setDocuments(documentPage.rows);
    setOperations(operationPage.rows);
  }, [base]);

  React.useEffect(() => {
    void reload().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [reload]);

  function runMaintenance(label: string, action: () => Promise<unknown>, success: string) {
    background(action, {
      loading: label,
      success,
      onSuccess: () => void reload(),
    });
  }

  async function previewMerge(candidate: DuplicateCandidate, targetId: string) {
    const sourceId = targetId === candidate.leftId ? candidate.rightId : candidate.leftId;
    setMergeCandidate(candidate);
    setSurvivorId(targetId);
    setMergePreview(null);
    setMergeConfirm("");
    try {
      const result = await api.get<MergePreview>(
        `${base}/records/${candidate.resourceType}/${sourceId}/merge-preview?targetId=${targetId}`,
      );
      setMergePreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function downloadSnapshot(resource: (typeof EXPORTS)[number]) {
    setExporting(resource);
    setError(null);
    try {
      let offset: number | null = 0;
      const rows: Array<Record<string, unknown>> = [];
      while (offset !== null) {
        const snapshotPage: {
          rows: Array<Record<string, unknown>>;
          nextOffset: number | null;
        } = await api.get(`${base}/exports/${resource}?format=json&limit=500&offset=${offset}`);
        rows.push(...snapshotPage.rows);
        offset = snapshotPage.nextOffset;
      }
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const csv =
        columns.length === 0
          ? ""
          : [
              columns.map(csvCell).join(","),
              ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
            ].join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `revenue-${resource}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast(`Exported ${rows.length} ${resource.replaceAll("_", " ")} rows.`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(null);
    }
  }

  async function commitMerge() {
    if (!mergeCandidate || !mergePreview) return;
    try {
      await api.post(
        `${base}/records/${mergeCandidate.resourceType}/${mergePreview.source.id}/merge`,
        {
          targetId: survivorId,
          confirmSourceLabel: mergeConfirm,
        },
      );
      toast(`${mergePreview.source.label} was merged and archived.`, "success");
      setMergeCandidate(null);
      setMergePreview(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function bulkTarget() {
    if (bulkFilter.trim()) return { filter: parsedJson(bulkFilter) };
    const lines = bulkIds
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (bulkResource === "follow_up") {
      return {
        followUpIds: lines.map((line) => {
          const [source, id] = line.split(":", 2);
          return { source, id };
        }),
      };
    }
    return { ids: lines };
  }

  async function runBulk(dryRun: boolean) {
    setError(null);
    try {
      const result = await api.post<BulkResult>(`${base}/bulk`, {
        resourceType: bulkResource,
        target: bulkTarget(),
        action: actionBody(bulkResource, bulkAction, bulkValue),
        dryRun,
        idempotencyKey: dryRun ? undefined : crypto.randomUUID(),
      });
      setBulkResult(result);
      if (!dryRun) {
        toast(`Applied ${result.applied} changes; ${result.failed} failed.`, "success");
        await reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function importHistory(dryRun: boolean) {
    try {
      const payload = parsedJson(historyJson) as Record<string, unknown>;
      const result = await api.post<HistoryImportSummary>(`${base}/deal-history/import`, {
        ...payload,
        dryRun,
        confirm: dryRun ? undefined : "IMPORT",
      });
      setHistoryPreview(result);
      if (dryRun) {
        setHistoryPreviewPayload(historyJson);
        toast(
          `Previewed ${result.accepted} accepted and ${result.rejected + result.conflicting} rejected or conflicting events.`,
          "success",
        );
      } else {
        toast(`Imported ${result.imported} historical Deal events.`, "success");
        await reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!duplicates || !evidence || !documents || !operations) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Data quality" }]} />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-950 dark:text-white">
          <ShieldCheck size={24} /> Revenue data quality
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Preview and reconcile duplicates, enrichment evidence, historical truth, and bulk cleanup.
          No proposal changes a verified record until a Member accepts it.
        </p>
      </div>
      {error && <FormError message={error} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MaintenanceButton
          icon={<ScanSearch size={16} />}
          label="Scan duplicates"
          onClick={() =>
            runMaintenance(
              "Scanning Revenue records…",
              () => api.post(`${base}/duplicates/scan`, { confirm: "SCAN" }),
              "Duplicate candidates refreshed.",
            )
          }
        />
        <MaintenanceButton
          icon={<ShieldCheck size={16} />}
          label="Propose Account domains"
          onClick={() =>
            runMaintenance(
              "Checking verified domains…",
              () =>
                api.post(`${base}/enrichment/domains/propose`, {
                  followWebsiteRedirects: true,
                }),
              "Canonical-domain proposals refreshed.",
            )
          }
        />
        <MaintenanceButton
          icon={<DatabaseZap size={16} />}
          label="Propose Deal values"
          onClick={() =>
            runMaintenance(
              "Checking verified Finance evidence…",
              () =>
                api.post(`${base}/enrichment/commercial-values/propose-from-finance`, {
                  confirm: "PROPOSE",
                }),
              "Commercial-value proposals refreshed.",
            )
          }
        />
        <MaintenanceButton
          icon={<DatabaseZap size={16} />}
          label="Propose Stripe values"
          onClick={() =>
            runMaintenance(
              "Checking verified Stripe subscriptions…",
              () =>
                api.post(`${base}/enrichment/commercial-values/propose-from-stripe`, {
                  confirm: "PROPOSE",
                }),
              "Stripe commercial-value proposals refreshed.",
            )
          }
        />
        <MaintenanceButton
          icon={<FileSearch size={16} />}
          label="Scan mail attachments"
          onClick={() =>
            runMaintenance(
              "Scanning captured mail…",
              () => api.post(`${base}/document-capture/scan`, { limit: 500, offset: 0 }),
              "Revenue document candidates refreshed.",
            )
          }
        />
        <MaintenanceButton
          icon={<History size={16} />}
          label="Backfill Deal activities"
          onClick={() =>
            runMaintenance(
              "Backfilling historical events…",
              () =>
                api.post(`${base}/deal-history/backfill-activities`, {
                  confirm: "BACKFILL",
                }),
              "Historical Deal events backfilled.",
            )
          }
        />
      </div>

      <Section
        title="Duplicate candidates"
        description="Detection proposes pairs. Choose the surviving record, inspect every conflict, then type the duplicate label to retire it."
        icon={<GitMerge size={18} />}
      >
        {duplicates.length === 0 ? (
          <Empty text="No open duplicate candidates." />
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {duplicates.map((candidate) => (
              <div key={candidate.id} className="grid gap-3 py-3 lg:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-sm font-medium capitalize text-slate-900 dark:text-slate-100">
                    {candidate.resourceType} · {candidate.score}% match
                  </p>
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {candidate.leftId} ↔ {candidate.rightId}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {(parsedJson(candidate.reasonsJson) as Array<{ kind: string }>)
                      .map((reason) => reason.kind.replaceAll("_", " "))
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void previewMerge(candidate, candidate.leftId)}
                  >
                    Keep left
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void previewMerge(candidate, candidate.rightId)}
                  >
                    Keep right
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      runMaintenance(
                        "Dismissing candidate…",
                        () =>
                          api.post(`${base}/duplicates/${candidate.id}/dismiss`, {
                            confirm: "DISMISS",
                          }),
                        "Candidate dismissed.",
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {mergeCandidate && mergePreview && (
          <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
            <h3 className="font-medium text-slate-950 dark:text-white">
              Merge {mergePreview.source.label} into {mergePreview.target.label}
            </h3>
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Duplicate</th>
                    <th className="px-3 py-2">Survivor</th>
                    <th className="px-3 py-2">Resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {mergePreview.fieldConflicts.map((conflict) => (
                    <tr
                      key={conflict.field}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="px-3 py-2 font-medium">{conflict.label}</td>
                      <td className="px-3 py-2">{displayValue(conflict.sourceValue)}</td>
                      <td className="px-3 py-2">{displayValue(conflict.targetValue)}</td>
                      <td className="px-3 py-2 text-slate-500">
                        {conflict.resolution.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
              Moves:{" "}
              {Object.entries(mergePreview.relationshipCounts)
                .filter(([, count]) => count > 0)
                .map(([key, count]) => `${count} ${key}`)
                .join(", ") || "no linked records"}
              . Custom fields: {mergePreview.customValuesCopied} copied,{" "}
              {mergePreview.customValueConflicts} kept on the tombstone as conflicts.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={mergeConfirm}
                onChange={(event) => setMergeConfirm(event.target.value)}
                placeholder={`Type “${mergePreview.source.label}”`}
              />
              <Button
                variant="danger"
                disabled={mergeConfirm !== mergePreview.source.label}
                onClick={() => void commitMerge()}
              >
                <GitMerge size={15} /> Merge and archive
              </Button>
              <Button variant="ghost" onClick={() => setMergeCandidate(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title="Enrichment evidence"
          description="Review provenance and confidence before a proposed field is accepted."
          icon={<ShieldCheck size={18} />}
        >
          {evidence.length === 0 ? (
            <Empty text="No evidence awaiting review." />
          ) : (
            <ReviewList
              rows={evidence.map((row) => ({
                id: row.id,
                title: `${row.resourceType} · ${row.fieldKey.replaceAll("_", " ")}`,
                detail: `${displayValue(parsedJson(row.extractedValueJson))} · ${row.confidence}% · ${row.sourceType}: ${row.sourceLabel || row.resourceId}`,
              }))}
              onDecision={(id, decision) =>
                runMaintenance(
                  `${decision === "accept" ? "Accepting" : "Rejecting"} evidence…`,
                  () => api.post(`${base}/enrichment/evidence/${id}/review`, { decision }),
                  `Evidence ${decision === "accept" ? "accepted" : "rejected"}.`,
                )
              }
            />
          )}
        </Section>

        <Section
          title="Revenue document capture"
          description="Ambiguous attachments require an explicit record before they can be saved."
          icon={<FileSearch size={18} />}
        >
          {documents.length === 0 ? (
            <Empty text="No attachment candidates awaiting review." />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {documents.map((row) => {
                const selected = documentLinks[row.id] ?? {
                  resourceType: row.proposedResourceType ?? "account",
                  resourceId: row.proposedResourceId ?? "",
                };
                return (
                  <div key={row.id} className="space-y-2 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {row.filename}
                      </p>
                      <p className="text-xs text-slate-500">
                        {row.proposedKind.replaceAll("_", " ")} · {row.confidence}% ·{" "}
                        {row.proposedResourceType
                          ? `${row.proposedResourceType}:${row.proposedResourceId}`
                          : "no confident link"}
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[9rem_1fr_auto_auto]">
                      <Select
                        value={selected.resourceType}
                        onChange={(event) =>
                          setDocumentLinks((current) => ({
                            ...current,
                            [row.id]: {
                              ...selected,
                              resourceType: event.target.value as ResourceType,
                            },
                          }))
                        }
                      >
                        <option value="account">Account</option>
                        <option value="contact">Contact</option>
                        <option value="deal">Deal</option>
                        <option value="partnership">Partnership</option>
                      </Select>
                      <Input
                        value={selected.resourceId}
                        onChange={(event) =>
                          setDocumentLinks((current) => ({
                            ...current,
                            [row.id]: { ...selected, resourceId: event.target.value },
                          }))
                        }
                        placeholder="Record UUID"
                      />
                      <Button
                        size="sm"
                        disabled={!selected.resourceId}
                        onClick={() =>
                          runMaintenance(
                            "Capturing attachment…",
                            () =>
                              api.post(`${base}/document-capture/candidates/${row.id}/review`, {
                                decision: "accept",
                                resourceType: selected.resourceType,
                                resourceId: selected.resourceId,
                              }),
                            "Attachment captured.",
                          )
                        }
                      >
                        <Check size={14} /> Capture
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          runMaintenance(
                            "Rejecting attachment…",
                            () =>
                              api.post(`${base}/document-capture/candidates/${row.id}/review`, {
                                decision: "reject",
                              }),
                            "Attachment rejected.",
                          )
                        }
                      >
                        <X size={14} /> Reject
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>

      <Section
        title="Bulk operations"
        description="Target selected IDs or a JSON filter. Dry-run validation never writes; committed changes use an idempotency key and can be undone."
        icon={<Archive size={18} />}
      >
        <div className="grid gap-3 lg:grid-cols-4">
          <Select
            value={bulkResource}
            onChange={(event) => setBulkResource(event.target.value as ResourceType | "follow_up")}
          >
            <option value="account">Accounts</option>
            <option value="contact">Contacts</option>
            <option value="deal">Deals</option>
            <option value="partnership">Partnerships</option>
            <option value="follow_up">Follow-ups</option>
          </Select>
          <Select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)}>
            {bulkResource === "follow_up" ? (
              <>
                <option value="cancel">Cancel</option>
                <option value="complete">Complete</option>
                <option value="priority">Set priority</option>
                <option value="reschedule">Reschedule</option>
                <option value="owner">Reassign Member</option>
              </>
            ) : (
              <>
                <option value="archive">Archive</option>
                <option value="restore">Restore</option>
                <option value="owner">Assign Member owner</option>
                {bulkResource === "contact" && <option value="lifecycle">Set lifecycle</option>}
                {bulkResource === "account" && (
                  <option value="account_status">Set Account status</option>
                )}
                <option value="custom_fields">Set custom fields (JSON)</option>
              </>
            )}
          </Select>
          <Input
            value={bulkValue}
            onChange={(event) => setBulkValue(event.target.value)}
            placeholder="Action value (when required)"
          />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void runBulk(true)}>
              Preview
            </Button>
            <Button onClick={() => void runBulk(false)}>Apply</Button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <textarea
            value={bulkIds}
            onChange={(event) => setBulkIds(event.target.value)}
            placeholder={
              bulkResource === "follow_up"
                ? "Selected follow-ups, one per line: task:uuid or deal:uuid"
                : "Selected record UUIDs, one per line"
            }
            className="min-h-28 rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <textarea
            value={bulkFilter}
            onChange={(event) => setBulkFilter(event.target.value)}
            placeholder='Or a filter, for example {"closedDeals":"only","staleBefore":"2026-01-01T00:00:00.000Z"}'
            className="min-h-28 rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>
        {bulkResult && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
            <p>
              {bulkResult.dryRun ? "Preview" : "Committed"}: {bulkResult.matched} matched,{" "}
              {bulkResult.valid || bulkResult.applied} valid/applied, {bulkResult.skipped} skipped,{" "}
              {bulkResult.failed} failed.
            </p>
            <div className="mt-2 max-h-40 overflow-y-auto text-xs text-slate-500">
              {bulkResult.rows.map((row) => (
                <p key={`${row.source ?? ""}:${row.resourceId}`}>
                  {row.status} · {row.label}
                  {row.error ? ` · ${row.error}` : ""}
                </p>
              ))}
            </div>
          </div>
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title="Historical Deal import"
          description="Import original creation, stage, outcome, amount, and owner timestamps without rewriting them as today."
          icon={<History size={18} />}
        >
          <textarea
            value={historyJson}
            onChange={(event) => {
              setHistoryJson(event.target.value);
              setHistoryPreview(null);
              setHistoryPreviewPayload("");
            }}
            placeholder='{"batchKey":"legacy-2026-07","sourceSystem":"legacy-crm","rows":[{"sourceRecordId":"deal-1","dealId":"…","historyCompleteness":"complete","originalCreatedAt":"2024-01-01T00:00:00.000Z","initialStageId":"…","events":[{"sourceEventId":"stage-1","eventType":"stage_changed","effectiveAt":"2024-01-10T00:00:00.000Z","fromStageId":"…","toStageId":"…"}]}]}'
            className="min-h-40 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              disabled={!historyJson.trim()}
              onClick={() => void importHistory(true)}
            >
              Preview import
            </Button>
            <Button
              disabled={
                !historyJson.trim() ||
                historyPreviewPayload !== historyJson ||
                !historyPreview ||
                historyPreview.accepted === 0
              }
              onClick={() => void importHistory(false)}
            >
              Import accepted events
            </Button>
          </div>
          {historyPreview && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">
              <p className="font-medium text-slate-700 dark:text-slate-200">
                {historyPreview.dryRun ? "Preview" : "Committed"}: {historyPreview.accepted}{" "}
                accepted · {historyPreview.rejected} rejected · {historyPreview.conflicting}{" "}
                conflicting · {historyPreview.duplicates} duplicate · {historyPreview.reordered}{" "}
                reordered
              </p>
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-slate-500">
                {historyPreview.rows.flatMap((row) =>
                  row.decisions.map((decision) => (
                    <p key={`${row.sourceId}:${decision.sourceId}`}>
                      {row.sourceId}/{decision.sourceId} · {decision.kind} · {decision.status}
                      {decision.reordered ? " · reordered" : ""}
                      {decision.reason ? ` · ${decision.reason}` : ""}
                    </p>
                  )),
                )}
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Snapshot exports"
          description="Every endpoint is paginated; use nextOffset to continue a complete JSON or CSV snapshot."
          icon={<Download size={18} />}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {EXPORTS.map((resource) => (
              <button
                type="button"
                key={resource}
                onClick={() => void downloadSnapshot(resource)}
                disabled={exporting !== null}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {exporting === resource ? "Exporting all pages…" : resource.replaceAll("_", " ")}
                {exporting === resource ? <Spinner size={14} /> : <Download size={14} />}
              </button>
            ))}
          </div>
        </Section>
      </div>

      <Section
        title="Audit and undo"
        description="Undo is guarded: if a record changed after the operation, rollback stops instead of overwriting newer work."
        icon={<RotateCcw size={18} />}
      >
        {operations.length === 0 ? (
          <Empty text="No reversible Revenue operations yet." />
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {operations.map((operation) => (
              <div key={operation.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium capitalize">
                    {operation.kind} · {operation.resourceType.replace("_", " ")}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(operation.createdAt).toLocaleString()} · {operation.status}
                  </p>
                </div>
                {operation.status !== "rolled_back" && operation.status !== "failed" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      runMaintenance(
                        "Checking and undoing operation…",
                        () =>
                          api.post(`${base}/operations/${operation.id}/undo`, {
                            confirm: "UNDO",
                          }),
                        "Revenue operation undone.",
                      )
                    }
                  >
                    <RotateCcw size={14} /> Undo
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function MaintenanceButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="secondary" className="justify-start" onClick={onClick}>
      {icon}
      {label}
      <RefreshCw size={13} className="ml-auto text-slate-400" />
    </Button>
  );
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-indigo-600 dark:text-indigo-400">{icon}</span>
        <div>
          <h2 className="font-semibold text-slate-950 dark:text-white">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-slate-500">{text}</p>;
}

function ReviewList({
  rows,
  onDecision,
}: {
  rows: Array<{ id: string; title: string; detail: string; acceptDisabled?: boolean }>;
  onDecision: (id: string, decision: "accept" | "reject") => void;
}) {
  return (
    <div className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{row.title}</p>
            <p className="mt-1 break-words text-xs text-slate-500">{row.detail}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={row.acceptDisabled}
              title={row.acceptDisabled ? "Choose an explicit record through the API" : undefined}
              onClick={() => onDecision(row.id, "accept")}
            >
              <Check size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecision(row.id, "reject")}>
              <X size={14} />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
