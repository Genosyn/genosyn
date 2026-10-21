import React from "react";
import { ArrowDown, ArrowUp, Bot, Plus, Sparkles, Trash2 } from "lucide-react";

import { MarkdownEditor } from "../components/MarkdownEditor";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { Disclosure } from "../components/ui/Disclosure";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { clsx } from "../components/ui/clsx";
import type { Employee, Member } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { recruitingApi, type Opening } from "../lib/recruiting";
import {
  COMPENSATION_PERIODS,
  COMPENSATION_PERIOD_LABELS,
  CRITERION_IMPORTANCES,
  CRITERION_IMPORTANCE_LABELS,
  CRITERION_WEIGHTS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  MAX_OPENING_CRITERIA,
  MAX_OPENING_QUESTIONS,
  OPENING_QUESTION_KINDS,
  OPENING_QUESTION_KIND_LABELS,
  OPENING_VISIBILITIES,
  OPENING_VISIBILITY_HINTS,
  OPENING_VISIBILITY_LABELS,
  WORKPLACE_TYPES,
  WORKPLACE_TYPE_LABELS,
  type CompensationPeriod,
  type CriterionImportance,
  type EmploymentType,
  type FormFieldMode,
  type OpeningFormSettings,
  type OpeningQuestionKind,
  type OpeningVisibility,
  type WorkplaceType,
} from "../../shared/recruiting";
import { cardClass } from "./RecruitingShared";

/**
 * The three editors on an Opening's page: its details, its criteria, and the
 * form people apply with. Each saves only its own fields, so two Members
 * editing different parts never overwrite each other.
 */

/** The same look as the shared `Input`'s label, for fields that are not an `Input`. */
const fieldLabelClass = "mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300";

/**
 * The closing date as the date field shows it: the local calendar day, which
 * is the day `save` sends back as that day's last second. Reading the UTC day
 * instead moved the date a day later on every save west of UTC.
 */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A draft that follows the saved Opening while the person has not touched it.
 * When the saved version moves — another Member, an AI Employee, a save from
 * another tab — an untouched draft takes it and a draft with edits keeps them.
 * "Untouched" is measured against the version the draft started from: against
 * the new version, any change on the server would look like an edit.
 */
function useServerDraft<T>(saved: T, fingerprint: (value: T) => string) {
  const [draft, setDraft] = React.useState<T>(saved);
  const base = React.useRef(saved);
  React.useEffect(() => {
    if (base.current === saved) return;
    const untouched = fingerprint(draft) === fingerprint(base.current);
    base.current = saved;
    if (untouched) setDraft(saved);
    // Runs when the saved version moves; the draft is read here, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  return [draft, setDraft] as const;
}

function SaveBar({
  dirty,
  saving,
  error,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
      <FormError message={error} />
      <div className="flex justify-end gap-2 sm:ml-auto">
        <Button type="button" variant="secondary" disabled={!dirty || saving} onClick={onReset}>
          Discard changes
        </Button>
        <Button type="button" loading={saving} disabled={!dirty} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ── Details ─────────────────────────────────────────────────────────────────

type DetailsDraft = {
  title: string;
  summary: string;
  description: string;
  department: string;
  location: string;
  workplace: WorkplaceType;
  employmentType: EmploymentType;
  visibility: OpeningVisibility;
  publishPay: boolean;
  payMin: string;
  payMax: string;
  currency: string;
  period: CompensationPeriod;
  headcount: string;
  applyBy: string;
  ownerUserId: string;
  screenerEmployeeId: string;
};

function detailsDraft(opening: Opening): DetailsDraft {
  return {
    title: opening.title,
    summary: opening.summary,
    description: opening.description,
    department: opening.department,
    location: opening.location,
    workplace: opening.workplace,
    employmentType: opening.employmentType,
    visibility: opening.visibility,
    publishPay: opening.compensation.min !== null || opening.compensation.max !== null,
    payMin: opening.compensation.min === null ? "" : String(opening.compensation.min),
    payMax: opening.compensation.max === null ? "" : String(opening.compensation.max),
    currency: opening.compensation.currency,
    period: opening.compensation.period,
    headcount: String(opening.headcount),
    applyBy: toDateInput(opening.applyBy),
    ownerUserId: opening.owner?.id ?? "",
    screenerEmployeeId: opening.screenerIsDefault ? "" : (opening.screener?.id ?? ""),
  };
}

export function DetailsEditor({
  companyId,
  opening,
  employees,
  members,
  onSaved,
}: {
  companyId: string;
  opening: Opening;
  employees: Employee[];
  members: Member[];
  onSaved: (opening: Opening) => void;
}) {
  const initial = React.useMemo(() => detailsDraft(opening), [opening]);
  const [draft, setDraft] = useServerDraft(initial, (value) => JSON.stringify(value));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const descriptionId = React.useId();
  const visibilityName = React.useId();
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);

  const set = <K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    const parse = (value: string) => (value.trim() === "" ? null : Number(value.replace(/,/g, "")));
    const min = parse(draft.payMin);
    const max = parse(draft.payMax);
    if (draft.publishPay && ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)))) {
      setError("Enter pay as numbers, like 120000.");
      return;
    }
    if (draft.publishPay && min === null && max === null) {
      setError("Enter at least the lowest or the highest pay, or turn off publishing pay.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await recruitingApi(companyId).updateOpening(opening.id, {
        title: draft.title,
        summary: draft.summary,
        description: draft.description,
        department: draft.department,
        location: draft.location,
        workplace: draft.workplace,
        employmentType: draft.employmentType,
        visibility: draft.visibility,
        compensation: draft.publishPay
          ? { min, max, currency: draft.currency.trim().toUpperCase() || "USD", period: draft.period }
          : null,
        headcount: Math.max(1, Math.round(Number(draft.headcount) || 1)),
        applyBy: draft.applyBy ? new Date(`${draft.applyBy}T23:59:59`).toISOString() : null,
        ownerUserId: draft.ownerUserId || null,
        screenerEmployeeId: draft.screenerEmployeeId || null,
      });
      // Take what the server kept — trimmed text, an upper-case currency, pay
      // without commas — so a saved form reads as saved.
      setDraft(detailsDraft(saved));
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "Could not save the Opening"));
    } finally {
      setSaving(false);
    }
  }

  const advancedSummary = [
    `${OPENING_VISIBILITY_LABELS[draft.visibility]}`,
    draft.screenerEmployeeId
      ? `Screened by ${employees.find((e) => e.id === draft.screenerEmployeeId)?.name ?? "an AI Employee"}`
      : "Company screener",
    draft.applyBy ? `Closes ${draft.applyBy}` : null,
    Number(draft.headcount) > 1 ? `Hiring ${draft.headcount}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`${cardClass} p-5 sm:p-6`}>
      <div className="grid gap-4">
        <Input label="Title" value={draft.title} onChange={(event) => set("title", event.target.value)} />
        <Input
          label="Summary"
          value={draft.summary}
          onChange={(event) => set("summary", event.target.value)}
          placeholder="One or two sentences shown on the careers site's list of roles."
        />
        <div>
          <label htmlFor={descriptionId} className={fieldLabelClass}>
            Description
          </label>
          <MarkdownEditor
            id={descriptionId}
            value={draft.description}
            onChange={(value) => set("description", value)}
            rows={14}
            initialMode="edit"
            placeholder={"## The role\nWhat the work is, the team, what success looks like.\n\n## You will\n- …\n\n## You have\n- …"}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Type" value={draft.employmentType} onChange={(event) => set("employmentType", event.target.value as EmploymentType)}>
            {EMPLOYMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EMPLOYMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Select label="Workplace" value={draft.workplace} onChange={(event) => set("workplace", event.target.value as WorkplaceType)}>
            {WORKPLACE_TYPES.map((type) => (
              <option key={type} value={type}>
                {WORKPLACE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Input label="Location" value={draft.location} onChange={(event) => set("location", event.target.value)} />
          <Input label="Team" value={draft.department} onChange={(event) => set("department", event.target.value)} />
        </div>

        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              checked={draft.publishPay}
              onChange={(event) => set("publishPay", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Publish the pay
          </label>
          <p className="mt-1 text-xs text-slate-500">
            People decide whether to apply on the rate. Publishing it brings more of the right applicants, and job
            search engines show it.
          </p>
          {draft.publishPay ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Input label="From" inputMode="decimal" value={draft.payMin} onChange={(event) => set("payMin", event.target.value)} placeholder="120000" />
              <Input label="To" inputMode="decimal" value={draft.payMax} onChange={(event) => set("payMax", event.target.value)} placeholder="150000" />
              <Input label="Currency" value={draft.currency} maxLength={3} onChange={(event) => set("currency", event.target.value)} />
              <Select label="Per" value={draft.period} onChange={(event) => set("period", event.target.value as CompensationPeriod)}>
                {COMPENSATION_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {COMPENSATION_PERIOD_LABELS[period]}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>

        <Disclosure title="Advanced" summary={advancedSummary}>
          <div className="grid gap-4 pt-2">
            <fieldset>
              <legend className={fieldLabelClass}>Who can see it</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {OPENING_VISIBILITIES.map((visibility) => (
                  <label
                    key={visibility}
                    className={clsx(
                      // The radio itself is hidden, so the card carries its keyboard focus.
                      "cursor-pointer rounded-lg border p-3 focus-within:ring-2 focus-within:ring-indigo-500/40",
                      draft.visibility === visibility
                        ? "border-indigo-500 bg-indigo-50/60 dark:bg-indigo-500/10"
                        : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/50",
                    )}
                  >
                    <input
                      type="radio"
                      name={visibilityName}
                      className="sr-only"
                      checked={draft.visibility === visibility}
                      onChange={() => set("visibility", visibility)}
                    />
                    <span className="block text-sm font-medium text-slate-900 dark:text-white">
                      {OPENING_VISIBILITY_LABELS[visibility]}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">{OPENING_VISIBILITY_HINTS[visibility]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="AI screener for this Opening"
                value={draft.screenerEmployeeId}
                onChange={(event) => set("screenerEmployeeId", event.target.value)}
              >
                <option value="">Company default</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} — {employee.role}
                  </option>
                ))}
              </Select>
              <Select label="Owner" value={draft.ownerUserId} onChange={(event) => set("ownerUserId", event.target.value)}>
                <option value="">Nobody</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name || member.email}
                  </option>
                ))}
              </Select>
              <Input
                label="Applications close"
                type="date"
                value={draft.applyBy}
                onChange={(event) => set("applyBy", event.target.value)}
              />
              <Input
                label="People to hire"
                type="number"
                min={1}
                max={1000}
                value={draft.headcount}
                onChange={(event) => set("headcount", event.target.value)}
              />
            </div>
            <p className="text-xs text-slate-500">
              The owner hears about strong matches as the AI screener finds them — or about every new applicant when
              nobody screens this Opening.
            </p>
          </div>
        </Disclosure>
      </div>
      <SaveBar dirty={dirty} saving={saving} error={error} onSave={() => void save()} onReset={() => setDraft(initial)} />
    </div>
  );
}

// ── Criteria ────────────────────────────────────────────────────────────────

type CriterionDraft = { key: string; id?: string; name: string; description: string; importance: CriterionImportance };

let draftCounter = 0;
function newKey(): string {
  draftCounter += 1;
  return `new-${draftCounter}`;
}

function criteriaDraft(opening: Opening): CriterionDraft[] {
  return opening.criteria.map((criterion) => ({ key: criterion.id, ...criterion }));
}

function stripCriteria(list: CriterionDraft[]) {
  return list.map(({ name, description, importance, id }) => ({ id, name, description, importance }));
}

export function CriteriaEditor({
  companyId,
  opening,
  employees,
  onSaved,
}: {
  companyId: string;
  opening: Opening;
  employees: Employee[];
  onSaved: (opening: Opening) => void;
}) {
  const dialog = useDialog();
  const initial = React.useMemo(() => criteriaDraft(opening), [opening]);
  const [rows, setRows] = useServerDraft(initial, (list) => JSON.stringify(stripCriteria(list)));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickedSuggester, setPickedSuggester] = React.useState("");
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<CriterionDraft[] | null>(null);
  const dirty = JSON.stringify(stripCriteria(initial)) !== JSON.stringify(stripCriteria(rows));
  // Whoever was picked, else the Opening's screener, else the first AI
  // Employee — worked out on every render, so it is there once the roster
  // arrives rather than stuck empty when this tab drew first.
  const suggester =
    [pickedSuggester, opening.screener?.id, employees[0]?.id].find(
      (id): id is string => Boolean(id) && employees.some((employee) => employee.id === id),
    ) ?? "";

  function update(key: string, patch: Partial<CriterionDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function move(index: number, by: number) {
    setRows((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });
  }

  async function save() {
    if (rows.some((row) => !row.name.trim())) {
      setError("Give every criterion a name, or remove the empty one.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await recruitingApi(companyId).updateOpening(opening.id, {
        criteria: rows.map((row) => ({
          ...(row.id ? { id: row.id } : {}),
          name: row.name.trim(),
          description: row.description.trim(),
          importance: row.importance,
        })),
      });
      // New criteria get their ids from the server. Taking them is what makes
      // the list read as saved, and keeps a second save from minting new ones.
      setRows(criteriaDraft(saved));
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "Could not save the criteria"));
    } finally {
      setSaving(false);
    }
  }

  async function suggest() {
    if (!suggester) return;
    setSuggesting(true);
    setError(null);
    try {
      const result = await recruitingApi(companyId).suggestCriteria(opening.id, suggester);
      setSuggestions(result.criteria.map((criterion) => ({ key: newKey(), ...criterion })));
    } catch (err) {
      setError(errorMessage(err, "Could not draft criteria"));
    } finally {
      setSuggesting(false);
    }
  }

  async function applySuggestions() {
    if (!suggestions) return;
    if (rows.length > 0) {
      const ok = await dialog.confirm({
        title: "Replace the criteria?",
        message: `The suggestions take the place of the ${rows.length} ${rows.length === 1 ? "criterion" : "criteria"} here. Nothing changes until you save, and Discard changes brings the current ones back.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    setRows(suggestions);
    setSuggestions(null);
  }

  const authorNote =
    opening.criteriaSource !== "member" && opening.criteria.length > 0
      ? `${opening.criteriaBy?.name ?? "An AI Employee"} ${opening.criteriaSource === "screener" ? "drafted these criteria when the first application arrived" : "wrote these criteria"}. Review them: every score is measured against them.`
      : null;

  return (
    <div className="grid gap-5">
      {authorNote ? (
        <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
          <Bot size={16} className="mt-0.5 shrink-0" /> {authorNote}
        </div>
      ) : null}
      <div className={`${cardClass} p-5 sm:p-6`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">The bar applicants are scored against</h2>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
              Each criterion is rated Not shown, Partly, Meets or Exceeds. Must haves count ×{CRITERION_WEIGHTS.must_have},
              important ×{CRITERION_WEIGHTS.important}, nice to have ×{CRITERION_WEIGHTS.nice_to_have}. A must have rated
              Not shown makes the match Weak whatever the total. Three to eight specific criteria work best.
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="mt-6 rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
            No criteria yet. Add your own, or let an AI Employee draft them from the description. If an application
            arrives first, the AI screener drafts them for you to review.
          </p>
        ) : (
          <ol className="mt-5 space-y-3">
            {rows.map((row, index) => {
              const number = index + 1;
              return (
                <li key={row.key} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto]">
                    <Input
                      aria-label={`Criterion ${number}`}
                      value={row.name}
                      onChange={(event) => update(row.key, { name: event.target.value })}
                      placeholder="Production TypeScript"
                    />
                    <Select
                      aria-label={`Importance of criterion ${number}`}
                      value={row.importance}
                      onChange={(event) => update(row.key, { importance: event.target.value as CriterionImportance })}
                    >
                      {CRITERION_IMPORTANCES.map((importance) => (
                        <option key={importance} value={importance}>
                          {CRITERION_IMPORTANCE_LABELS[importance]}
                        </option>
                      ))}
                    </Select>
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move criterion ${number} up`}>
                        <ArrowUp size={14} />
                      </button>
                      <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800" disabled={index === rows.length - 1} onClick={() => move(index, 1)} aria-label={`Move criterion ${number} down`}>
                        <ArrowDown size={14} />
                      </button>
                      <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))} aria-label={`Remove criterion ${number}`}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <Textarea
                    aria-label={`What meeting criterion ${number} looks like`}
                    className="mt-2 min-h-[4rem]"
                    rows={2}
                    value={row.description}
                    onChange={(event) => update(row.key, { description: event.target.value })}
                    placeholder="What meeting the bar looks like, in a sentence."
                  />
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={rows.length >= MAX_OPENING_CRITERIA}
            onClick={() => setRows((current) => [...current, { key: newKey(), name: "", description: "", importance: "important" }])}
          >
            <Plus size={14} /> Add criterion
          </Button>
          {employees.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <Select aria-label="AI Employee to draft criteria" value={suggester} onChange={(event) => setPickedSuggester(event.target.value)} containerClassName="w-48">
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </Select>
              <Button type="button" variant="secondary" loading={suggesting} disabled={!suggester} onClick={() => void suggest()}>
                <Sparkles size={14} /> Draft with AI
              </Button>
            </div>
          ) : null}
        </div>

        {suggestions ? (
          <div className="mt-5 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-500/30 dark:bg-indigo-500/5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-indigo-950 dark:text-indigo-100">Suggested criteria</h3>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => setSuggestions(null)}>
                  Dismiss
                </Button>
                <Button type="button" size="sm" onClick={() => void applySuggestions()}>
                  {rows.length > 0 ? "Replace with these" : "Use these"}
                </Button>
              </div>
            </div>
            <ul className="mt-3 space-y-2">
              {suggestions.map((suggestion) => (
                <li key={suggestion.key} className="flex items-start justify-between gap-3 text-sm">
                  <div>
                    <span className="font-medium text-slate-900 dark:text-white">{suggestion.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{CRITERION_IMPORTANCE_LABELS[suggestion.importance]}</span>
                    {suggestion.description ? <p className="text-xs text-slate-600 dark:text-slate-400">{suggestion.description}</p> : null}
                  </div>
                  <button
                    type="button"
                    disabled={rows.length >= MAX_OPENING_CRITERIA}
                    aria-label={`Add ${suggestion.name}`}
                    className="shrink-0 text-xs font-medium text-indigo-600 hover:underline disabled:opacity-40 dark:text-indigo-400"
                    onClick={() => setRows((current) => [...current, { ...suggestion, key: newKey() }])}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <SaveBar dirty={dirty} saving={saving} error={error} onSave={() => void save()} onReset={() => setRows(initial)} />
      </div>
    </div>
  );
}

// ── Application form ────────────────────────────────────────────────────────

type QuestionDraft = {
  key: string;
  id?: string;
  label: string;
  help: string;
  kind: OpeningQuestionKind;
  required: boolean;
  options: string;
};

function questionsDraft(opening: Opening): QuestionDraft[] {
  return opening.questions.map((question) => ({
    key: question.id,
    id: question.id,
    label: question.label,
    help: question.help,
    kind: question.kind,
    required: question.required,
    options: question.options.join("\n"),
  }));
}

function stripQuestions(list: QuestionDraft[]) {
  return list.map(({ key: _key, ...rest }) => rest);
}

const FORM_FIELDS: Array<{ key: keyof OpeningFormSettings; label: string; hint: string }> = [
  { key: "resume", label: "Resume", hint: "PDF, Word, OpenDocument, RTF or text, up to 10 MB" },
  { key: "coverLetter", label: "Cover letter", hint: "A free-text answer" },
  { key: "phone", label: "Phone", hint: "For scheduling calls" },
  { key: "location", label: "Location", hint: "Where they are based" },
  { key: "linkedin", label: "LinkedIn", hint: "A profile link" },
  { key: "website", label: "Website or portfolio", hint: "A link to their work" },
];

export function FormEditor({
  companyId,
  opening,
  onSaved,
}: {
  companyId: string;
  opening: Opening;
  onSaved: (opening: Opening) => void;
}) {
  const initialForm = opening.form;
  const initialQuestions = React.useMemo(() => questionsDraft(opening), [opening]);
  const [form, setForm] = useServerDraft(initialForm, (value) => JSON.stringify(value));
  const [questions, setQuestions] = useServerDraft(initialQuestions, (list) => JSON.stringify(stripQuestions(list)));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initialForm) ||
    JSON.stringify(stripQuestions(questions)) !== JSON.stringify(stripQuestions(initialQuestions));

  function updateQuestion(key: string, patch: Partial<QuestionDraft>) {
    setQuestions((current) => current.map((question) => (question.key === key ? { ...question, ...patch } : question)));
  }

  async function save() {
    for (const question of questions) {
      if (!question.label.trim()) {
        setError("Give every question its wording, or remove the empty one.");
        return;
      }
      const choices = question.options.split("\n").map((option) => option.trim()).filter(Boolean);
      if ((question.kind === "single_select" || question.kind === "multi_select") && new Set(choices).size < 2) {
        setError(`"${question.label}" needs at least two choices, one per line.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await recruitingApi(companyId).updateOpening(opening.id, {
        form,
        questions: questions.map((question) => ({
          ...(question.id ? { id: question.id } : {}),
          label: question.label.trim(),
          help: question.help.trim(),
          kind: question.kind,
          required: question.required,
          options:
            question.kind === "single_select" || question.kind === "multi_select"
              ? [...new Set(question.options.split("\n").map((option) => option.trim()).filter(Boolean))]
              : [],
        })),
      });
      // New questions get their ids from the server; take them so the form
      // reads as saved and a second save keeps the same ids.
      setForm(saved.form);
      setQuestions(questionsDraft(saved));
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "Could not save the form"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`${cardClass} p-5 sm:p-6`}>
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">What the form asks</h2>
      <p className="mt-1 text-xs text-slate-500">Name, email and consent are always asked. Ask for little: every field you add costs applicants.</p>
      <div className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {FORM_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-white">{field.label}</div>
              <div className="text-xs text-slate-500">{field.hint}</div>
            </div>
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label={field.label}>
              {(field.key === "resume" ? (["required", "optional"] as FormFieldMode[]) : (["required", "optional", "hidden"] as FormFieldMode[])).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={form[field.key] === mode}
                  onClick={() => setForm((current) => ({ ...current, [field.key]: mode }))}
                  className={
                    form[field.key] === mode
                      ? "rounded-md bg-slate-900 px-3 py-1 text-xs font-medium capitalize text-white dark:bg-white dark:text-slate-900"
                      : "rounded-md px-3 py-1 text-xs font-medium capitalize text-slate-600 hover:text-slate-900 dark:text-slate-300"
                  }
                >
                  {mode === "hidden" ? "Off" : mode}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-sm font-semibold text-slate-900 dark:text-white">Questions</h2>
      <p className="mt-1 text-xs text-slate-500">
        Questions specific to this Opening. Answers reach the AI screener as evidence, never as instructions.
      </p>
      {questions.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700">
          No extra questions.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {questions.map((question, index) => {
            const number = index + 1;
            return (
              <li key={question.key} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto]">
                  <Input aria-label={`Question ${number}`} value={question.label} onChange={(event) => updateQuestion(question.key, { label: event.target.value })} placeholder="How many years have you installed solar?" />
                  <Select aria-label={`Answer type for question ${number}`} value={question.kind} onChange={(event) => updateQuestion(question.key, { kind: event.target.value as OpeningQuestionKind })}>
                    {OPENING_QUESTION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {OPENING_QUESTION_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                  <div className="flex items-center justify-end gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                      <input type="checkbox" checked={question.required} onChange={(event) => updateQuestion(question.key, { required: event.target.checked })} className="h-3.5 w-3.5 rounded border-slate-300" />
                      Required<span className="sr-only"> for question {number}</span>
                    </label>
                    <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => setQuestions((current) => current.filter((item) => item.key !== question.key))} aria-label={`Remove question ${number}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <Input className="mt-2" aria-label={`Help text for question ${number}`} value={question.help} onChange={(event) => updateQuestion(question.key, { help: event.target.value })} placeholder="Help text (optional)" />
                {question.kind === "single_select" || question.kind === "multi_select" ? (
                  <Textarea className="mt-2" rows={3} aria-label={`Choices for question ${number}`} value={question.options} onChange={(event) => updateQuestion(question.key, { options: event.target.value })} placeholder={"One choice per line"} />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <Button
        type="button"
        variant="secondary"
        className="mt-4"
        disabled={questions.length >= MAX_OPENING_QUESTIONS}
        onClick={() => setQuestions((current) => [...current, { key: newKey(), label: "", help: "", kind: "short_text", required: false, options: "" }])}
      >
        <Plus size={14} /> Add question
      </Button>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onSave={() => void save()}
        onReset={() => {
          setForm(initialForm);
          setQuestions(initialQuestions);
        }}
      />
    </div>
  );
}
