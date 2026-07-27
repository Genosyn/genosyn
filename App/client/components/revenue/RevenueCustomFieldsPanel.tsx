import React from "react";
import { SlidersHorizontal } from "lucide-react";
import { api } from "../../lib/api";
import type {
  RevenueCustomField,
  RevenueCustomValue,
  RevenueResourceType,
} from "../../lib/revenue";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

function optionsFor(field: RevenueCustomField): string[] {
  try {
    const parsed = JSON.parse(field.optionsJson);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function formValue(value: RevenueCustomValue["value"]): string | number | readonly string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value ?? "";
}

function ProvenanceLine({ row }: { row: RevenueCustomValue }) {
  const evidence = row.provenance;
  if (!evidence) {
    return (
      <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">No provenance recorded</p>
    );
  }
  const observed = evidence.observedAt
    ? new Date(evidence.observedAt).toLocaleDateString()
    : "date unknown";
  const source = evidence.sourceLabel || evidence.sourceType;
  return (
    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
      <span
        className={
          evidence.verificationState === "verified"
            ? "font-medium text-emerald-700 dark:text-emerald-400"
            : "font-medium text-amber-700 dark:text-amber-400"
        }
      >
        {evidence.verificationState === "verified" ? "Verified" : "Unverified"}
      </span>
      {" · "}
      {source} · {observed}
      {row.provenanceHistoryCount > 1 ? ` · ${row.provenanceHistoryCount} provenance records` : ""}
    </p>
  );
}

export function RevenueCustomFieldsPanel({
  companyId,
  resourceType,
  resourceId,
}: {
  companyId: string;
  resourceType: RevenueResourceType;
  resourceId: string;
}) {
  const base = `/api/companies/${companyId}/revenue`;
  const [rows, setRows] = React.useState<RevenueCustomValue[] | null>(null);
  const [draft, setDraft] = React.useState<Record<string, RevenueCustomValue["value"]>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const result = await api.get<{ rows: RevenueCustomValue[] }>(
      `${base}/custom-values/${resourceType}/${resourceId}`,
    );
    setRows(result.rows);
    setDraft(Object.fromEntries(result.rows.map((row) => [row.field.key, row.value])));
    setError(null);
  }, [base, resourceId, resourceType]);

  React.useEffect(() => {
    reload().catch((cause) => {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [reload]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`${base}/custom-values/${resourceType}/${resourceId}`, { values: draft });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!rows || (rows.length === 0 && !error)) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            <SlidersHorizontal size={16} /> Custom fields
          </h2>
          <p className="mt-1 text-xs text-slate-500">Structured, filterable company data.</p>
        </div>
        {rows.length > 0 && (
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {error && <FormError message={error} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((row) => {
          const { field } = row;
          const value = draft[field.key];
          const options = optionsFor(field);
          if (field.fieldType === "boolean") {
            return (
              <div key={field.id}>
                <Select
                  label={field.name}
                  value={String(formValue(value))}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: event.target.value === "" ? null : event.target.value === "true",
                    }))
                  }
                >
                  <option value="">Not set</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Select>
                <ProvenanceLine row={row} />
              </div>
            );
          }
          if (field.fieldType === "select") {
            return (
              <div key={field.id}>
                <Select
                  label={field.name}
                  value={String(formValue(value))}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.key]: event.target.value || null }))
                  }
                >
                  <option value="">Not set</option>
                  {options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </Select>
                <ProvenanceLine row={row} />
              </div>
            );
          }
          if (field.fieldType === "multi_select") {
            return (
              <div key={field.id}>
                <Select
                  label={field.name}
                  multiple
                  className="h-24"
                  value={Array.isArray(value) ? value : []}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: Array.from(
                        event.target.selectedOptions,
                        (option) => option.value,
                      ),
                    }))
                  }
                >
                  {options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </Select>
                <ProvenanceLine row={row} />
              </div>
            );
          }
          return (
            <div key={field.id}>
              <Input
                label={field.name}
                required={field.required}
                type={
                  field.fieldType === "number"
                    ? "number"
                    : field.fieldType === "date"
                      ? "date"
                      : field.fieldType === "url"
                        ? "url"
                        : "text"
                }
                value={String(formValue(value))}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field.key]:
                      field.fieldType === "number"
                        ? event.target.value === ""
                          ? null
                          : Number(event.target.value)
                        : event.target.value || null,
                  }))
                }
              />
              <ProvenanceLine row={row} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
