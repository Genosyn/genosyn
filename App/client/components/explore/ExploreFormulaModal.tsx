import React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { ChartRenderer } from "@/components/charts/ChartRenderer";
import { Spinner } from "@/components/ui/Spinner";
import {
  dashboardCardStates,
  type DashboardCard,
  type DashboardChart,
  type DashboardRunState,
} from "@/lib/exploreDashboard";
import { validateFormula, type ExploreFormula } from "../../../shared/exploreFormula";

export function ExploreFormulaModal({
  card,
  cards,
  charts,
  runs,
  saving,
  error,
  onClose,
  onSave,
}: {
  card: DashboardCard | null;
  cards: DashboardCard[];
  charts: DashboardChart[];
  runs: Record<string, DashboardRunState>;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (title: string, formula: ExploreFormula) => void;
}) {
  const choices = cards.filter(
    (candidate) =>
      candidate.id !== card?.id &&
      (candidate.formula ||
        charts.some((chart) => chart.id === candidate.chartId && chart.vizType === "scalar")),
  );
  const [title, setTitle] = React.useState(card?.titleOverride ?? "");
  const [inputs, setInputs] = React.useState<ExploreFormula["inputs"]>(
    () =>
      card?.formula?.inputs ??
      choices.slice(0, 2).map((candidate, index) => ({
        name: String.fromCharCode(65 + index),
        cardId: candidate.id,
      })),
  );
  const [expression, setExpression] = React.useState(
    () => card?.formula?.expression ?? inputs.map((input) => input.name).join(" + "),
  );
  const [prefix, setPrefix] = React.useState(card?.formula?.prefix ?? "");
  const [suffix, setSuffix] = React.useState(card?.formula?.suffix ?? "");
  const formula: ExploreFormula = { expression, inputs, prefix, suffix };
  let validationError: string | null = null;
  try {
    validateFormula(formula);
  } catch (error) {
    validationError = error instanceof Error ? error.message : "Check the formula and its inputs.";
  }
  const previewCard: DashboardCard = {
    id: card?.id ?? "formula-preview",
    dashboardId: card?.dashboardId ?? "",
    chartId: null,
    formula,
    titleOverride: title,
    x: 0,
    y: 0,
    w: 6,
    h: 3,
  };
  const preview = dashboardCardStates(
    [...cards.filter((candidate) => candidate.id !== previewCard.id), previewCard],
    charts,
    runs,
  ).get(previewCard.id);

  function addInput() {
    const used = new Set(inputs.map((input) => input.name));
    let index = 0;
    let name = "A";
    while (used.has(name)) {
      index += 1;
      name = index < 26 ? String.fromCharCode(65 + index) : `V${index + 1}`;
    }
    const candidate =
      choices.find((choice) => !inputs.some((input) => input.cardId === choice.id)) ?? choices[0];
    if (!candidate) return;
    setInputs([...inputs, { name, cardId: candidate.id }]);
    setExpression(expression.trim() ? `(${expression}) + ${name}` : name);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={card ? "Edit formula" : "Add formula"}
      description="Combine Number and Formula cards from this dashboard."
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && !validationError && !saving) onSave(title.trim(), formula);
      }}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || !!validationError || saving}>
            {saving ? "Saving…" : "Save formula"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          Title
          <input
            autoFocus
            value={title}
            maxLength={200}
            required
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Total revenue"
            className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Inputs</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addInput}
              disabled={inputs.length >= 32 || choices.length === 0}
            >
              <Plus size={12} /> Add input
            </Button>
          </div>
          {inputs.map((input, index) => (
            <div key={input.name} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-center font-mono text-sm text-slate-600 dark:text-slate-300">
                {input.name}
              </span>
              <Select
                value={input.cardId}
                aria-label={`Input ${input.name}`}
                containerClassName="flex-1"
                onChange={(event) =>
                  setInputs(
                    inputs.map((current, i) =>
                      i === index ? { ...current, cardId: event.target.value } : current,
                    ),
                  )
                }
              >
                {!choices.some((choice) => choice.id === input.cardId) && (
                  <option value={input.cardId}>Unavailable card — choose another</option>
                )}
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.titleOverride ||
                      charts.find((chart) => chart.id === choice.chartId)?.title ||
                      "Formula"}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                aria-label={`Remove input ${input.name}`}
                onClick={() => setInputs(inputs.filter((_, i) => i !== index))}
                className="rounded p-2 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {choices.length === 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Add a Number card to use its value here, or calculate with numbers directly.
            </p>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Inputs use the full value displayed by each card, before rounding or unit labels.
          </p>
        </div>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          Formula
          <textarea
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="A + B"
            spellCheck={false}
            autoCapitalize="off"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </label>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Use +, -, *, /, parentheses, SUM, AVG, MIN, or MAX. For example: <code>SUM(A, B)</code> or{" "}
          <code>(A / B) * 100</code>.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Prefix
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              maxLength={32}
              placeholder="$"
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Suffix
            <input
              value={suffix}
              onChange={(event) => setSuffix(event.target.value)}
              maxLength={32}
              placeholder="%"
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
        <div
          className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
          aria-live="polite"
        >
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Preview</span>
          {preview?.kind === "ok" && (
            <div className="h-28">
              <ChartRenderer
                vizType="scalar"
                vizConfig={{ measure: "value", prefix, suffix }}
                result={preview.result}
              />
            </div>
          )}
          {preview?.kind === "running" && (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
              <Spinner size={14} /> Waiting for input values…
            </div>
          )}
          {preview?.kind === "error" && (
            <div className="mt-2">
              <FormError message={preview.message} />
            </div>
          )}
        </div>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
