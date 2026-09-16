import React from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { api, type Company } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import {
  proactiveReadiness,
  type ProactiveOverview,
  type ProactiveRecipe,
} from "../../../shared/proactive";

/**
 * Assign one server-owned starter without making the catalogue page own a
 * second form hierarchy. Starters remain deliberately narrower than a custom
 * Routine: the server knows their trigger, required Grants, and review ceiling.
 */
export function StarterSetupModal({
  recipe,
  overview,
  company,
  onClose,
  onSaved,
}: {
  recipe: ProactiveRecipe;
  overview: ProactiveOverview;
  company: Company;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [accountId, setAccountId] = React.useState("");
  const delivery = "draft" as const;
  const [instruction, setInstruction] = React.useState(recipe.brief);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const employee = overview.employees.find((entry) => entry.id === employeeId);
  const mailbox = overview.mailboxes.find((entry) => entry.id === accountId);
  const needs = proactiveReadiness(recipe, employee, mailbox, delivery);
  const already = overview.installations.find(
    (entry) =>
      entry.recipeId === recipe.id &&
      entry.employeeId === employeeId &&
      entry.accountId === (accountId || null),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/proactive`, {
        recipeId: recipe.id,
        employeeId,
        accountId: accountId || null,
        delivery,
        instruction,
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={recipe.name}
      description={recipe.description}
      size="lg"
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" type="button" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || needs.length > 0 || !instruction.trim() || Boolean(already)}
          >
            <Sparkles size={16} aria-hidden="true" />
            {saving ? "Assigning…" : "Assign work"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Select
          label="AI Employee"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
          required
        >
          <option value="">Choose an AI Employee</option>
          {overview.employees.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>

        {recipe.requirements.includes("mail") && (
          <Select
            label="Mailbox"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            required
          >
            <option value="">Choose a mailbox</option>
            {overview.mailboxes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.address}
              </option>
            ))}
          </Select>
        )}

        {recipe.kind === "email" && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
            <p className="text-sm font-medium text-indigo-950 dark:text-indigo-100">
              Customer communication is reviewed in Genosyn
            </p>
            <p className="mt-1 text-xs leading-5 text-indigo-800 dark:text-indigo-200">
              The exact proposed email appears in the Decision stack. It never creates a draft in
              Gmail or IMAP and never sends automatically. An owner or admin chooses Send now or
              Discard.
            </p>
          </div>
        )}

        {recipe.kind === "routine" && (
          <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
            {recipe.scheduleLabel}
            {recipe.triggerKind ? ", and on relevant changes (at most once an hour)." : "."} You can
            edit the schedule and require Approval on the Routine after setup.
          </p>
        )}

        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Instructions
          <textarea
            className="mt-2 block min-h-64 w-full rounded-lg border border-slate-300 bg-transparent p-3 text-sm font-normal leading-6 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            maxLength={20_000}
            required
          />
        </label>

        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          Choose who owns this responsibility and how they work. Existing Grants are checked here;
          setup never adds access. Scheduled starters put proposed customer communication in the
          Decision stack for review; they never create a draft in Gmail or IMAP and preserve source
          restrictions.
        </p>

        {already && (
          <p className="text-sm text-indigo-600 dark:text-indigo-400">
            This responsibility is already assigned to this AI Employee and mailbox.{" "}
            <Link className="underline" to={already.href}>
              Review existing work
            </Link>
            .
          </p>
        )}

        {needs.length > 0 && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900">
            <p className="font-medium">Before assigning</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {needs.map((need) => (
                <li key={need}>{need}</li>
              ))}
            </ul>
          </div>
        )}

        <FormError message={error} />
      </div>
    </Modal>
  );
}
