import React from "react";
import { Plus } from "lucide-react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { attachableModels, companyModelPath, employeeModelPath } from "@/lib/companyModels";
import { errorMessage } from "@/lib/errors";
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
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
    >
      <Plus size={16} aria-hidden="true" /> Add an AI Model
    </button>
  );
}

/**
 * Adding another AI Model: the company's own models first, one click each
 * (leaving out any this employee already has) — attaching the same model,
 * never a copy — then the connect form for a new one, which the company keeps
 * too. Whatever is added becomes the employee's active AI Model; Make active
 * on another card switches back.
 */
export function AddModelPanel({
  company,
  emp,
  onCancel,
  onAdded,
}: {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id" | "name">;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [offers, setOffers] = React.useState<AIModel[] | null>(null);
  const [attaching, setAttaching] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<AIModel[]>(companyModelPath(company.id))
      .then((list) => {
        if (!cancelled) setOffers(attachableModels(list, emp.id));
      })
      // The offers are a shortcut: without them the form still adds a model.
      .catch(() => {
        if (!cancelled) setOffers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, emp.id]);

  async function attach(offer: AIModel) {
    setError(null);
    setAttaching(offer.id);
    try {
      await api.post(employeeModelPath(company.id, emp.id, undefined, "/attach"), {
        modelId: offer.id,
      });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAttaching(null);
    }
  }

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
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={attaching !== null}>
            Cancel
          </Button>
        </div>
        {offers === null ? (
          <div className="flex justify-center py-2">
            <Spinner size={16} />
          </div>
        ) : (
          offers.length > 0 && (
            <>
              <CompanyModelOffers
                offers={offers}
                attaching={attaching}
                error={error}
                onUse={(offer) => void attach(offer)}
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
