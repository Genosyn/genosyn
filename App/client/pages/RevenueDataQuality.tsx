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
import { api, type IntegrationConnection } from "../lib/api";
import type {
  RevenueCommercialValueBacklogPage,
  RevenueDealHistoryActivityBackfillSummary,
  RevenueDealHistoryCoveragePage,
} from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
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
  sourceId: string;
  sourceLabel: string;
  extractedValueJson: string;
  confidence: number;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  verificationState: "unverified" | "verified" | "rejected" | "superseded";
  extractionMethod: string;
  observedAt: string | null;
  lastVerifiedAt: string | null;
  verifyingActorType: "member" | "ai_employee" | "system" | null;
  verifyingActorId: string | null;
};
type DocumentCandidate = {
  id: string;
  filename: string;
  proposedKind: string;
  proposedResourceType: ResourceType | null;
  proposedResourceId: string | null;
  confidence: number;
  gmailMessageId: string;
  gmailThreadId: string;
  gmailAttachmentId: string;
  status: "pending" | "processing" | "accepted" | "rejected" | "duplicate";
  revenueDocumentId: string | null;
};
type Operation = {
  id: string;
  kind: "merge" | "bulk" | "history_import";
  resourceType: ResourceType | "follow_up";
  status: "queued" | "running" | "completed" | "partial" | "failed" | "rolled_back";
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
    resolution: "source" | "target";
  }>;
  customFieldConflicts: Array<{
    field: string;
    fieldId: string;
    fieldKey: string;
    label: string;
    sourceValue: unknown;
    targetValue: unknown;
    resolution: "source" | "target";
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
type BulkJobDetail = {
  operation: Operation;
  summary: {
    progress?: {
      total: number;
      processed: number;
      valid: number;
      failedValidation: number;
    };
    result?: BulkResult;
    error?: string;
  };
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
  "partnership_contacts",
  "buying_committees",
  "follow_ups",
  "documents",
  "stage_definitions",
  "custom_fields",
  "custom_values",
  "import_reconciliation",
  "deal_history",
  "field_evidence",
  "duplicate_candidates",
  "operation_audit",
  "document_candidates",
] as const;

const INVENTORY_PAGE_SIZE = 500;
const INVENTORY_MAX_ROWS = 5_000;
const INVENTORY_MAX_PAGES = INVENTORY_MAX_ROWS / INVENTORY_PAGE_SIZE;

type OffsetInventoryPage<Row> = {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Load one stable, bounded inventory into the operator UI. The services use a
 * deterministic createdAt/id order; refusing a changing total or duplicate ID
 * keeps a multi-page selection from silently mixing two populations.
 */
async function loadFrozenInventory<Row>(
  url: string,
  rowId: (row: Row) => string,
): Promise<OffsetInventoryPage<Row>> {
  const rows: Row[] = [];
  const seenIds = new Set<string>();
  let frozenTotal: number | null = null;

  for (let pageNumber = 0; pageNumber < INVENTORY_MAX_PAGES; pageNumber += 1) {
    const offset = rows.length;
    const separator = url.includes("?") ? "&" : "?";
    const page = await api.get<OffsetInventoryPage<Row>>(
      `${url}${separator}limit=${INVENTORY_PAGE_SIZE}&offset=${offset}`,
    );
    if (frozenTotal === null) {
      frozenTotal = page.total;
      if (frozenTotal > INVENTORY_MAX_ROWS) {
        throw new Error(
          `This inventory has more than ${INVENTORY_MAX_ROWS.toLocaleString()} rows. Narrow it through the API before selecting records.`,
        );
      }
    } else if (page.total !== frozenTotal) {
      throw new Error("This inventory changed while it was loading. Refresh and try again.");
    }
    if (page.offset !== offset) {
      throw new Error("The inventory returned an unexpected page boundary. Refresh and try again.");
    }
    for (const row of page.rows) {
      const id = rowId(row);
      if (seenIds.has(id)) {
        throw new Error("This inventory changed while it was loading. Refresh and try again.");
      }
      seenIds.add(id);
      rows.push(row);
    }
    if (rows.length >= frozenTotal) {
      if (rows.length !== frozenTotal) {
        throw new Error("This inventory changed while it was loading. Refresh and try again.");
      }
      return { rows, total: frozenTotal, limit: INVENTORY_PAGE_SIZE, offset: 0 };
    }
    if (page.rows.length === 0) {
      throw new Error("The inventory ended before every row was loaded. Refresh and try again.");
    }
  }

  throw new Error(
    `This inventory exceeds the ${INVENTORY_MAX_ROWS.toLocaleString()}-row operator limit.`,
  );
}

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

function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(amountCents / 100);
  } catch {
    return `${currency || "USD"} ${(amountCents / 100).toLocaleString()}`;
  }
}

function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (typeof value === "string") {
    let firstVisible = 0;
    while (firstVisible < text.length && text.charCodeAt(firstVisible) <= 0x20) {
      firstVisible += 1;
    }
    if (["=", "+", "-", "@"].includes(text[firstVisible] ?? "")) text = `'${text}`;
  }
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
  if (action === "standard_fields") {
    const parsed = parsedJson(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Standard fields must be a JSON object");
    }
    const input = parsed as Record<string, unknown>;
    return {
      type: "update_standard_fields",
      confirm: "UPDATE_STANDARD_FIELDS",
      ...(input.values || input.rows
        ? {
            values: input.values,
            rows: input.rows,
            notesMode: input.notesMode,
          }
        : { values: input }),
    };
  }
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
  const background = useBackgroundAction();
  const dialog = useDialog();
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
  const [mergeResolutions, setMergeResolutions] = React.useState<
    Record<string, "source" | "target">
  >({});
  const [bulkResource, setBulkResource] = React.useState<ResourceType | "follow_up">("account");
  const [bulkAction, setBulkAction] = React.useState("archive");
  const [bulkValue, setBulkValue] = React.useState("");
  const [bulkIds, setBulkIds] = React.useState("");
  const [bulkFilter, setBulkFilter] = React.useState("");
  const [bulkMode, setBulkMode] = React.useState<"atomic" | "partial">("partial");
  const [bulkResult, setBulkResult] = React.useState<BulkResult | null>(null);
  const [bulkJob, setBulkJob] = React.useState<BulkJobDetail | null>(null);
  const [bulkPreviewConfigurationKey, setBulkPreviewConfigurationKey] = React.useState<
    string | null
  >(null);
  const [bulkSubmitting, setBulkSubmitting] = React.useState(false);
  const [historyJson, setHistoryJson] = React.useState("");
  const [historyPreview, setHistoryPreview] = React.useState<HistoryImportSummary | null>(null);
  const [historyPreviewPayload, setHistoryPreviewPayload] = React.useState("");
  const [documentLinks, setDocumentLinks] = React.useState<
    Record<string, { resourceType: ResourceType; resourceId: string }>
  >({});
  const [exporting, setExporting] = React.useState<(typeof EXPORTS)[number] | null>(null);
  const [exportNotice, setExportNotice] = React.useState<string | null>(null);
  const [historyCoverage, setHistoryCoverage] =
    React.useState<RevenueDealHistoryCoveragePage | null>(null);
  const [selectedHistoryDealIds, setSelectedHistoryDealIds] = React.useState<string[]>([]);
  const [activityBackfillPreview, setActivityBackfillPreview] =
    React.useState<RevenueDealHistoryActivityBackfillSummary | null>(null);
  const [activityBackfillPreviewSelection, setActivityBackfillPreviewSelection] =
    React.useState("");
  const [commercialBacklog, setCommercialBacklog] =
    React.useState<RevenueCommercialValueBacklogPage | null>(null);
  const [commercialBacklogUnavailable, setCommercialBacklogUnavailable] = React.useState(false);
  const [selectedCommercialDealIds, setSelectedCommercialDealIds] = React.useState<string[]>([]);
  const [stripeConnections, setStripeConnections] = React.useState<IntegrationConnection[]>([]);
  const [stripeConnectionId, setStripeConnectionId] = React.useState("");
  const [commercialSubmitting, setCommercialSubmitting] = React.useState(false);

  const reload = React.useCallback(async () => {
    const [
      duplicatePage,
      evidencePage,
      documentPage,
      operationPage,
      connections,
      historyCoveragePage,
      commercialBacklogPage,
    ] = await Promise.all([
      api.get<{ rows: DuplicateCandidate[] }>(`${base}/duplicates?status=open`),
      api.get<{ rows: Evidence[] }>(`${base}/enrichment/evidence?status=proposed`),
      api.get<{ rows: DocumentCandidate[] }>(`${base}/document-capture/candidates?status=pending`),
      api.get<{ rows: Operation[] }>(`${base}/operations?limit=25`),
      api
        .get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`)
        .catch(() => []),
      loadFrozenInventory<RevenueDealHistoryCoveragePage["rows"][number]>(
        `${base}/deal-history/coverage?includeArchived=false`,
        (row) => row.dealId,
      ).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return { rows: [], total: 0, limit: INVENTORY_PAGE_SIZE, offset: 0 };
      }),
      loadFrozenInventory<RevenueCommercialValueBacklogPage["rows"][number]>(
        `${base}/enrichment/commercial-values/backlog`,
        (row) => row.dealId,
      )
        .then((page) => {
          setCommercialBacklogUnavailable(false);
          return page;
        })
        .catch((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          const financeDenied = message.includes(
            "You don't have access to this company's finances.",
          );
          setCommercialBacklogUnavailable(financeDenied);
          if (!financeDenied) setError(message);
          return { rows: [], total: 0, limit: INVENTORY_PAGE_SIZE, offset: 0 };
        }),
    ]);
    setDuplicates(duplicatePage.rows);
    setEvidence(evidencePage.rows);
    setDocuments(documentPage.rows);
    setOperations(operationPage.rows);
    setHistoryCoverage(historyCoveragePage);
    setCommercialBacklog(commercialBacklogPage);
    setActivityBackfillPreview(null);
    setActivityBackfillPreviewSelection("");
    setSelectedHistoryDealIds((current) =>
      current.filter((dealId) =>
        historyCoveragePage.rows.some(
          (row) => row.dealId === dealId && row.recommendation === "activity_backfill",
        ),
      ),
    );
    setSelectedCommercialDealIds((current) =>
      current.filter((dealId) =>
        commercialBacklogPage.rows.some(
          (row) =>
            row.dealId === dealId &&
            ["finance_candidate", "stripe_candidate"].includes(row.disposition),
        ),
      ),
    );
    const connectedStripe = connections.filter(
      (connection) => connection.provider === "stripe" && connection.status === "connected",
    );
    setStripeConnections(connectedStripe);
    setStripeConnectionId((current) =>
      connectedStripe.some((connection) => connection.id === current)
        ? current
        : (connectedStripe[0]?.id ?? ""),
    );
  }, [base, company.id]);

  React.useEffect(() => {
    void reload().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [reload]);

  function runMaintenance(title: string, action: () => Promise<unknown>) {
    background(action, {
      title,
      onSuccess: () => void reload(),
    });
  }

  async function previewMerge(candidate: DuplicateCandidate, targetId: string) {
    const sourceId = targetId === candidate.leftId ? candidate.rightId : candidate.leftId;
    setMergeCandidate(candidate);
    setSurvivorId(targetId);
    setMergePreview(null);
    setMergeConfirm("");
    setMergeResolutions({});
    try {
      const result = await api.get<MergePreview>(
        `${base}/records/${candidate.resourceType}/${sourceId}/merge-preview?targetId=${targetId}`,
      );
      setMergePreview(result);
      setMergeResolutions(
        Object.fromEntries(
          [...result.fieldConflicts, ...result.customFieldConflicts].map((conflict) => [
            conflict.field,
            conflict.resolution,
          ]),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function downloadSnapshot(resource: (typeof EXPORTS)[number]) {
    setExporting(resource);
    setError(null);
    setExportNotice(null);
    try {
      let cursor: string | null = null;
      const rows: Array<Record<string, unknown>> = [];
      do {
        const query = new URLSearchParams({ format: "json", limit: "500" });
        if (cursor) query.set("cursor", cursor);
        const snapshotPage: {
          rows: Array<Record<string, unknown>>;
          nextCursor: string | null;
        } = await api.get(`${base}/exports/${resource}?${query.toString()}`);
        rows.push(...snapshotPage.rows);
        cursor = snapshotPage.nextCursor;
      } while (cursor !== null);
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
      // The file leaves the page silently, so this is the only confirmation.
      setExportNotice(`Exported ${rows.length} ${resource.replaceAll("_", " ")} rows.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(null);
    }
  }

  async function scanAllMailAttachments() {
    let offset: number | null = 0;
    let scannedMessages = 0;
    let createdCandidates = 0;
    while (offset !== null) {
      const page: {
        scannedMessages: number;
        createdCandidates: number;
        nextOffset: number | null;
      } = await api.post(`${base}/document-capture/scan`, {
        limit: 500,
        offset,
      });
      scannedMessages += page.scannedMessages;
      createdCandidates += page.createdCandidates;
      offset = page.nextOffset;
    }
    return { scannedMessages, createdCandidates };
  }

  async function reviewEvidence(id: string, decision: "accept" | "reject") {
    try {
      return await api.post(`${base}/enrichment/evidence/${id}/review`, { decision });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (decision === "accept" && message.includes("verified value already exists")) {
        const confirmed = await dialog.confirm({
          title: "Replace the verified value?",
          message:
            "A different verified value already exists. The current value will remain in provenance history.",
          confirmLabel: "Replace value",
          variant: "danger",
        });
        if (!confirmed) throw cause;
        return api.post(`${base}/enrichment/evidence/${id}/review`, {
          decision,
          supersedeExisting: true,
        });
      }
      throw cause;
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
          resolutions: mergeResolutions,
        },
      );
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

  function bulkConfigurationKey(): string {
    return JSON.stringify({
      resourceType: bulkResource,
      action: bulkAction,
      value: bulkValue,
      ids: bulkIds,
      filter: bulkFilter,
      mode: bulkMode,
    });
  }

  async function runBulk(dryRun: boolean) {
    const configurationKey = bulkConfigurationKey();
    if (!dryRun && (!bulkResult?.dryRun || bulkPreviewConfigurationKey !== configurationKey)) {
      setError("Preview the current bulk settings before applying them.");
      return;
    }
    setBulkSubmitting(true);
    setError(null);
    setBulkJob(null);
    if (dryRun) setBulkPreviewConfigurationKey(null);
    try {
      const body = {
        resourceType: bulkResource,
        target: bulkTarget(),
        action: actionBody(bulkResource, bulkAction, bulkValue),
        dryRun,
        idempotencyKey: dryRun ? undefined : crypto.randomUUID(),
        mode: bulkMode,
      };
      if (dryRun) {
        setBulkResult(await api.post<BulkResult>(`${base}/bulk`, body));
        setBulkPreviewConfigurationKey(configurationKey);
        return;
      }
      setBulkPreviewConfigurationKey(null);
      const queued = await api.post<{
        job: Operation;
        preview: BulkResult;
      }>(`${base}/bulk/jobs`, body);
      setBulkResult(queued.preview);
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const detail = await api.get<BulkJobDetail>(`${base}/bulk/jobs/${queued.job.id}`);
        setBulkJob(detail);
        if (["completed", "partial", "failed", "rolled_back"].includes(detail.operation.status)) {
          if (detail.summary.result) setBulkResult(detail.summary.result);
          if (detail.operation.status === "failed") {
            throw new Error(detail.summary.error || "The bulk job failed");
          }
          await reload();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error("The bulk job is still running; its status remains in Audit and undo.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function undoOperation(operation: Operation) {
    const confirmed = await dialog.confirm({
      title: "Undo this Revenue operation?",
      message:
        "This can restore or remove many records. Genosyn will stop safely if any affected record has changed since the operation.",
      confirmLabel: "Undo operation",
      variant: "danger",
    });
    if (!confirmed) return;
    runMaintenance("Couldn’t undo the Revenue operation", () =>
      api.post(`${base}/operations/${operation.id}/undo`, {
        confirm: "UNDO",
      }),
    );
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
      } else {
        await reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function historySelectionKey(dealIds: string[]): string {
    return [...dealIds].sort().join(",");
  }

  function toggleHistoryDeal(dealId: string, checked: boolean) {
    setSelectedHistoryDealIds((current) =>
      checked
        ? [...new Set([...current, dealId])]
        : current.filter((selectedId) => selectedId !== dealId),
    );
    setActivityBackfillPreview(null);
    setActivityBackfillPreviewSelection("");
  }

  async function previewActivityBackfill() {
    setError(null);
    setActivityBackfillPreview(null);
    setActivityBackfillPreviewSelection("");
    try {
      const dealIds = [...selectedHistoryDealIds].sort();
      const result = await api.post<RevenueDealHistoryActivityBackfillSummary>(
        `${base}/deal-history/activity-backfill/preview`,
        { dealIds },
      );
      setActivityBackfillPreview(result);
      setActivityBackfillPreviewSelection(historySelectionKey(dealIds));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function commitActivityBackfill() {
    if (
      !activityBackfillPreview ||
      activityBackfillPreviewSelection !== historySelectionKey(selectedHistoryDealIds)
    ) {
      return;
    }
    setError(null);
    try {
      await api.post<RevenueDealHistoryActivityBackfillSummary>(
        `${base}/deal-history/activity-backfill`,
        {
          dealIds: [...selectedHistoryDealIds].sort(),
          idempotencyKey: crypto.randomUUID(),
          confirm: "BACKFILL",
        },
      );
      setSelectedHistoryDealIds([]);
      setActivityBackfillPreview(null);
      setActivityBackfillPreviewSelection("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function toggleCommercialDeal(dealId: string, checked: boolean) {
    setSelectedCommercialDealIds((current) =>
      checked
        ? [...new Set([...current, dealId])]
        : current.filter((selectedId) => selectedId !== dealId),
    );
  }

  function selectedCommercialDeals(source: "finance" | "stripe"): string[] {
    if (!commercialBacklog) return [];
    const selected = new Set(selectedCommercialDealIds);
    return commercialBacklog.rows
      .filter(
        (row) =>
          selected.has(row.dealId) &&
          ["finance_candidate", "stripe_candidate"].includes(row.disposition) &&
          (source === "finance" ? Boolean(row.financeCandidate) : Boolean(row.stripeCandidate)),
      )
      .map((row) => row.dealId)
      .sort();
  }

  async function proposeSelectedFinanceValues() {
    const dealIds = selectedCommercialDeals("finance");
    if (dealIds.length === 0 || commercialSubmitting) return;
    setCommercialSubmitting(true);
    setError(null);
    try {
      await api.post<{ proposed: number; ambiguousAccounts: number }>(
        `${base}/enrichment/commercial-values/propose-from-finance`,
        {
          dealIds,
          confirm: "PROPOSE",
        },
      );
      setSelectedCommercialDealIds([]);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCommercialSubmitting(false);
    }
  }

  async function proposeSelectedStripeValues() {
    const dealIds = selectedCommercialDeals("stripe");
    if (!stripeConnectionId || dealIds.length === 0 || commercialSubmitting) return;
    setCommercialSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{
        proposed: number;
        reviewedCustomers: number;
        ambiguousAccounts: number;
        errors: Array<{ connectionId: string; customerId?: string; error: string }>;
      }>(`${base}/enrichment/commercial-values/propose-from-stripe`, {
        connectionId: stripeConnectionId,
        dealIds,
        confirm: "PROPOSE",
      });
      if (result.errors.length > 0) {
        setError(
          `${result.errors.length} Stripe lookup${result.errors.length === 1 ? "" : "s"} failed. Successful proposals remain available for review.`,
        );
      }
      setSelectedCommercialDealIds([]);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCommercialSubmitting(false);
    }
  }

  if (
    !duplicates ||
    !evidence ||
    !documents ||
    !operations ||
    !historyCoverage ||
    !commercialBacklog
  ) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="page-shell space-y-6 p-4 sm:p-6 lg:p-8">
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
            runMaintenance("Couldn’t scan for duplicates", () =>
              api.post(`${base}/duplicates/scan`, { confirm: "SCAN" }),
            )
          }
        />
        <MaintenanceButton
          icon={<ShieldCheck size={16} />}
          label="Propose Account domains"
          onClick={() =>
            runMaintenance("Couldn’t propose Account domains", () =>
              api.post(`${base}/enrichment/domains/propose`, {
                followWebsiteRedirects: true,
              }),
            )
          }
        />
        <MaintenanceButton
          icon={<FileSearch size={16} />}
          label="Scan mail attachments"
          onClick={() => runMaintenance("Couldn’t scan mail attachments", scanAllMailAttachments)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title="Deal history coverage"
          description="Select only the Deals whose native Activities should become historical events. Preview is required before backfill."
          icon={<History size={18} />}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{historyCoverage.total} Deals checked</span>
            <span>·</span>
            <span>
              {historyCoverage.rows.filter((row) => row.completeness === "missing").length} missing
              history
            </span>
            <span>·</span>
            <span>
              {
                historyCoverage.rows.filter((row) => row.recommendation === "activity_backfill")
                  .length
              }{" "}
              ready for Activity backfill
            </span>
            <span>·</span>
            <span>
              {
                historyCoverage.rows.filter(
                  (row) => row.recommendation === "historical_import_first",
                ).length
              }{" "}
              need historical import first
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSelectedHistoryDealIds(
                  historyCoverage.rows
                    .filter(
                      (row) =>
                        row.recommendation === "activity_backfill" && row.pendingActivityCount > 0,
                    )
                    .map((row) => row.dealId),
                );
                setActivityBackfillPreview(null);
                setActivityBackfillPreviewSelection("");
              }}
            >
              Select recommended
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedHistoryDealIds.length === 0}
              onClick={() => {
                setSelectedHistoryDealIds([]);
                setActivityBackfillPreview(null);
                setActivityBackfillPreviewSelection("");
              }}
            >
              Clear
            </Button>
            <span className="self-center text-xs text-slate-500">
              {selectedHistoryDealIds.length} selected
            </span>
          </div>
          {historyCoverage.rows.length === 0 ? (
            <Empty text="No Deals need history reconciliation." />
          ) : (
            <div className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 px-3 dark:divide-slate-800 dark:border-slate-700">
              {historyCoverage.rows.map((row) => {
                const selectable =
                  row.recommendation === "activity_backfill" && row.pendingActivityCount > 0;
                const recommendation =
                  row.recommendation === "activity_backfill"
                    ? `Backfill ${row.pendingActivityCount} Activities`
                    : row.recommendation === "historical_import_first"
                      ? "Historical import first"
                      : row.recommendation === "historical_import"
                        ? "Historical import recommended"
                        : "No repair recommended";
                return (
                  <label
                    key={row.dealId}
                    className={`flex gap-3 py-3 ${selectable ? "cursor-pointer" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      checked={selectedHistoryDealIds.includes(row.dealId)}
                      disabled={!selectable}
                      onChange={(event) => toggleHistoryDeal(row.dealId, event.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {row.title}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {row.stageName ?? "Unknown stage"} · {row.completeness.replaceAll("_", " ")}
                        {" · "}
                        {row.historyEventCount} events · {recommendation}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={selectedHistoryDealIds.length === 0}
              onClick={() => void previewActivityBackfill()}
            >
              Preview backfill
            </Button>
            <Button
              disabled={
                !activityBackfillPreview ||
                activityBackfillPreviewSelection !== historySelectionKey(selectedHistoryDealIds) ||
                !activityBackfillPreview.rows.some((row) => row.status === "ready")
              }
              onClick={() => void commitActivityBackfill()}
            >
              Backfill previewed Activities
            </Button>
          </div>
          {activityBackfillPreview && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">
              <p className="font-medium text-slate-700 dark:text-slate-200">
                Preview: {activityBackfillPreview.selectedDeals} Deals ·{" "}
                {activityBackfillPreview.reviewedActivities} Activities ·{" "}
                {activityBackfillPreview.rows.filter((row) => row.status === "ready").length} ready
                · {activityBackfillPreview.skipped} already covered ·{" "}
                {activityBackfillPreview.failed} failed validation
              </p>
              {activityBackfillPreview.migrationSnapshots > 0 && (
                <p className="mt-1 text-slate-500">
                  {activityBackfillPreview.migrationSnapshots} migration-time creation Activities
                  will be preserved as snapshots, not original creation dates.
                </p>
              )}
              {activityBackfillPreview.rows.some(
                (row) => row.status === "failed" && row.reason,
              ) && (
                <div className="mt-2 max-h-24 space-y-1 overflow-y-auto text-red-600 dark:text-red-400">
                  {activityBackfillPreview.rows
                    .filter((row) => row.status === "failed" && row.reason)
                    .map((row) => (
                      <p key={row.activityId}>
                        {row.dealId} · {row.reason}
                      </p>
                    ))}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section
          title="Commercial-value backlog"
          description="Members with Finance access can select unambiguous zero-value Deals and propose values from verified Finance or Stripe evidence. Proposals still require review and never change Deal values directly."
          icon={<DatabaseZap size={18} />}
        >
          {commercialBacklogUnavailable ? (
            <Empty text="Finance access is required to inspect commercial-value evidence." />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{commercialBacklog.total} open zero-value Deals</span>
                <span>·</span>
                <span>
                  {
                    commercialBacklog.rows.filter((row) => row.disposition === "finance_candidate")
                      .length
                  }{" "}
                  Finance candidates
                </span>
                <span>·</span>
                <span>
                  {
                    commercialBacklog.rows.filter(
                      (row) =>
                        Boolean(row.stripeCandidate) &&
                        ["finance_candidate", "stripe_candidate"].includes(row.disposition),
                    ).length
                  }{" "}
                  Stripe candidates
                </span>
                <span>·</span>
                <span>
                  {
                    commercialBacklog.rows.filter((row) => row.disposition === "ambiguous_account")
                      .length
                  }{" "}
                  ambiguous
                </span>
                <span>·</span>
                <span>
                  {
                    commercialBacklog.rows.filter((row) => row.disposition === "pending_review")
                      .length
                  }{" "}
                  awaiting review
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={commercialSubmitting}
                  onClick={() =>
                    setSelectedCommercialDealIds(
                      commercialBacklog.rows
                        .filter((row) => row.disposition === "finance_candidate")
                        .map((row) => row.dealId),
                    )
                  }
                >
                  Select Finance candidates
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    commercialSubmitting ||
                    !commercialBacklog.rows.some(
                      (row) =>
                        Boolean(row.stripeCandidate) &&
                        ["finance_candidate", "stripe_candidate"].includes(row.disposition),
                    )
                  }
                  onClick={() =>
                    setSelectedCommercialDealIds(
                      commercialBacklog.rows
                        .filter(
                          (row) =>
                            Boolean(row.stripeCandidate) &&
                            ["finance_candidate", "stripe_candidate"].includes(row.disposition),
                        )
                        .map((row) => row.dealId),
                    )
                  }
                >
                  Select Stripe candidates
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={commercialSubmitting || selectedCommercialDealIds.length === 0}
                  onClick={() => setSelectedCommercialDealIds([])}
                >
                  Clear
                </Button>
                <span className="self-center text-xs text-slate-500">
                  {selectedCommercialDealIds.length} selected
                </span>
              </div>
              {commercialBacklog.rows.length === 0 ? (
                <Empty text="No open zero-value Deals need reconciliation." />
              ) : (
                <div className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 px-3 dark:divide-slate-800 dark:border-slate-700">
                  {commercialBacklog.rows.map((row) => {
                    const selectable = ["finance_candidate", "stripe_candidate"].includes(
                      row.disposition,
                    );
                    const sources: string[] = [];
                    if (row.financeCandidate) {
                      sources.push(
                        `${formatMoney(
                          row.financeCandidate.amountCents,
                          row.financeCandidate.currency,
                        )} from ${row.financeCandidate.sourceLabel}`,
                      );
                    }
                    if (row.stripeCandidate) {
                      sources.push(
                        `Stripe customer ${row.stripeCandidate.customerId} through ${row.stripeCandidate.connectedConnections} Connection${row.stripeCandidate.connectedConnections === 1 ? "" : "s"}`,
                      );
                    }
                    const detail =
                      row.disposition === "ambiguous_account"
                        ? `${row.zeroValueDealsOnAccount} zero-value Deals share this Account`
                        : row.disposition === "pending_review"
                          ? `${row.proposalCounts.proposed} proposal(s) awaiting review`
                          : selectable && sources.length > 0
                            ? sources.join(" · ")
                            : row.disposition.replaceAll("_", " ");
                    return (
                      <label
                        key={row.dealId}
                        className={`flex gap-3 py-3 ${selectable ? "cursor-pointer" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={selectedCommercialDealIds.includes(row.dealId)}
                          disabled={!selectable || commercialSubmitting}
                          onChange={(event) =>
                            toggleCommercialDeal(row.dealId, event.target.checked)
                          }
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {row.title}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {row.accountName ?? "No Account"} · {row.stageName ?? "Unknown stage"} ·{" "}
                            {detail}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <Button
                  disabled={commercialSubmitting || selectedCommercialDeals("finance").length === 0}
                  onClick={() => void proposeSelectedFinanceValues()}
                >
                  {commercialSubmitting ? <Spinner size={14} /> : null}
                  Propose Finance values ({selectedCommercialDeals("finance").length})
                </Button>
                {stripeConnections.length > 0 ? (
                  <>
                    <Select
                      label="Stripe Connection"
                      value={stripeConnectionId}
                      onChange={(event) => setStripeConnectionId(event.target.value)}
                      disabled={commercialSubmitting}
                    >
                      {stripeConnections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      disabled={
                        commercialSubmitting ||
                        !stripeConnectionId ||
                        selectedCommercialDeals("stripe").length === 0
                      }
                      onClick={() => void proposeSelectedStripeValues()}
                    >
                      {commercialSubmitting ? <Spinner size={14} /> : null}
                      Propose Stripe values ({selectedCommercialDeals("stripe").length})
                    </Button>
                  </>
                ) : (
                  <p className="self-center text-xs text-slate-500">
                    Connect Stripe to propose subscription or paid-invoice values.
                  </p>
                )}
              </div>
            </>
          )}
        </Section>
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
                      runMaintenance("Couldn’t dismiss the candidate", () =>
                        api.post(`${base}/duplicates/${candidate.id}/dismiss`, {
                          confirm: "DISMISS",
                        }),
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
                  {[...mergePreview.fieldConflicts, ...mergePreview.customFieldConflicts].map(
                    (conflict) => (
                      <tr
                        key={conflict.field}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="px-3 py-2 font-medium">{conflict.label}</td>
                        <td className="px-3 py-2">{displayValue(conflict.sourceValue)}</td>
                        <td className="px-3 py-2">{displayValue(conflict.targetValue)}</td>
                        <td className="px-3 py-2">
                          <Select
                            aria-label={`Choose ${conflict.label} value`}
                            value={mergeResolutions[conflict.field] ?? conflict.resolution}
                            onChange={(event) =>
                              setMergeResolutions((current) => ({
                                ...current,
                                [conflict.field]: event.target.value as "source" | "target",
                              }))
                            }
                          >
                            <option value="target">Keep survivor</option>
                            <option value="source">Use duplicate</option>
                          </Select>
                        </td>
                      </tr>
                    ),
                  )}
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
              {mergePreview.customValueConflicts} need an explicit survivor or duplicate choice.
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
              <Button
                variant="ghost"
                onClick={() => {
                  setMergeCandidate(null);
                  setMergePreview(null);
                  setMergeResolutions({});
                }}
              >
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
                detail: [
                  displayValue(parsedJson(row.extractedValueJson)),
                  `${row.confidence}% confidence`,
                  `${row.sourceType}: ${row.sourceLabel || row.sourceId}`,
                  row.extractionMethod || "extraction method unknown",
                  row.observedAt
                    ? `observed ${new Date(row.observedAt).toLocaleString()}`
                    : "observation date unknown",
                  row.lastVerifiedAt
                    ? `last verified ${new Date(row.lastVerifiedAt).toLocaleString()}`
                    : row.verificationState,
                  row.verifyingActorType
                    ? `verified by ${row.verifyingActorType.replaceAll("_", " ")}${row.verifyingActorId ? ` ${row.verifyingActorId}` : ""}`
                    : "not yet verified",
                ].join(" · "),
              }))}
              onDecision={(id, decision) =>
                runMaintenance(
                  `Couldn’t ${decision === "accept" ? "accept" : "reject"} the evidence`,
                  () => reviewEvidence(id, decision),
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
                        {row.gmailMessageId
                          ? ` · Gmail ${row.gmailMessageId}${row.gmailAttachmentId ? ` · attachment ${row.gmailAttachmentId}` : ""}`
                          : ""}
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
                          runMaintenance("Couldn’t capture the attachment", () =>
                            api.post(`${base}/document-capture/candidates/${row.id}/review`, {
                              decision: "accept",
                              resourceType: selected.resourceType,
                              resourceId: selected.resourceId,
                            }),
                          )
                        }
                      >
                        <Check size={14} /> Capture
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          runMaintenance("Couldn’t reject the attachment", () =>
                            api.post(`${base}/document-capture/candidates/${row.id}/review`, {
                              decision: "reject",
                            }),
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
        <div className="grid gap-3 lg:grid-cols-5">
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
                <option value="standard_fields">Set standard fields (JSON)</option>
                <option value="custom_fields">Set custom fields (JSON)</option>
              </>
            )}
          </Select>
          <Input
            value={bulkValue}
            onChange={(event) => setBulkValue(event.target.value)}
            placeholder="Action value (when required)"
          />
          <Select
            value={bulkMode}
            onChange={(event) => setBulkMode(event.target.value as "atomic" | "partial")}
          >
            <option value="partial">Partial — apply valid rows</option>
            <option value="atomic">Atomic — all or nothing</option>
          </Select>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={bulkSubmitting}
              onClick={() => void runBulk(true)}
            >
              {bulkSubmitting && !bulkJob ? <Spinner size={14} /> : null} Preview
            </Button>
            <Button
              disabled={
                bulkSubmitting ||
                !bulkResult?.dryRun ||
                bulkPreviewConfigurationKey !== bulkConfigurationKey()
              }
              onClick={() => void runBulk(false)}
            >
              Apply preview
            </Button>
          </div>
        </div>
        {bulkResult?.dryRun && bulkPreviewConfigurationKey !== bulkConfigurationKey() && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            These settings changed after the preview. Preview again before applying.
          </p>
        )}
        {bulkJob?.summary.progress && (
          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            {["queued", "running"].includes(bulkJob.operation.status) && <Spinner size={13} />}
            Job {bulkJob.operation.status}: {bulkJob.summary.progress.processed}/
            {bulkJob.summary.progress.total} processed · {bulkJob.summary.progress.valid} valid ·{" "}
            {bulkJob.summary.progress.failedValidation} failed validation
          </p>
        )}
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
          description="Every export is frozen at its first page and follows nextCursor to download one consistent CSV snapshot."
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
          <FormSuccess message={exportNotice} className="mt-3" />
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
                    onClick={() => void undoOperation(operation)}
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
