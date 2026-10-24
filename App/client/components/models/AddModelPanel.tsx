import React from "react";
import { Plus } from "lucide-react";
import { api, type AIModel, type Company, type Employee, type ReusableModel } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { offersNotHeld } from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { CompanyModelOffers } from "./CompanyModelOffers";
import { ModelSetupForm } from "./ModelSetupForm";

/**
 * The page-level way to give an employee another AI Model, under its cards:
 * one obvious button that opens the panel below.
 */
export function AddModelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
    >
      <Plus size={16} aria-hidden="true" /> Add an AI Model
    </button>
  );
}

/**
 * Adding another AI Model: the ones the company already runs on, one click
 * each (leaving out any this employee already has), then the connect form for
 * a new one. Whatever is added becomes the employee's active AI Model; Make
 * active on another card switches back.
 */
export function AddModelPanel({
  company,
  emp,
  held,
  onCancel,
  onAdded,
}: {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id" | "name">;
  /** The AI Models the employee already has, so their copies are not offered again. */
  held: readonly AIModel[];
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [offers, setOffers] = React.useState<ReusableModel[] | null>(null);
  const [reusing, setReusing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models`;

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<ReusableModel[]>(`${base}/reusable`)
      .then((list) => {
        if (!cancelled) setOffers(list);
      })
      // The offers are a shortcut: without them the form still adds a model.
      .catch(() => {
        if (!cancelled) setOffers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  async function reuse(offer: ReusableModel) {
    setError(null);
    setReusing(offer.id);
    try {
      await api.post(`${base}/reuse`, { sourceModelId: offer.id });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReusing(null);
    }
  }

  const available = offers ? offersNotHeld(offers, held) : null;

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Add an AI Model
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              The AI Model you add becomes {emp.name}&apos;s active one. Make active on another card
              switches back any time.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={reusing !== null}>
            Cancel
          </Button>
        </div>
        {available === null ? (
          <div className="flex justify-center py-2">
            <Spinner size={16} />
          </div>
        ) : (
          available.length > 0 && (
            <>
              <CompanyModelOffers
                offers={available}
                reusing={reusing}
                error={error}
                onUse={(offer) => void reuse(offer)}
              />
              <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                or connect a new one
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
            </>
          )
        )}
        <ModelSetupForm
          mode="create"
          initial={{ provider: "anthropic", model: "", authMode: "apikey" }}
          company={company}
          emp={emp}
          onSaved={onAdded}
          submitLabel="Add AI Model"
        />
      </CardBody>
    </Card>
  );
}
