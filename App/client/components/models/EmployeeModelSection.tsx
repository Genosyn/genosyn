import React from "react";
import { useLocation } from "react-router-dom";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { activeFirst, canManageModels, modelListLine } from "@/lib/modelSummary";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { AddModelButton, AddModelPanel } from "./AddModelPanel";
import { FirstModelSetup } from "./FirstModelSetup";
import { ModelCard } from "./ModelCard";

/**
 * An AI Employee's AI Models, as Settings → Model, the hire wizard and
 * onboarding all show them.
 *
 * Each model is one self-contained card: what it is and whether it is
 * connected, Test connection and Make active, and an Advanced section inside
 * that card holding that model's own settings — its keys, model, endpoint or
 * sign-in, context window, concurrent Runs, Remove. Nothing about one model
 * sits outside its card, and no setting here applies to every model, so the
 * page itself holds only the line saying which one is active and the button
 * that adds another.
 *
 * An employee with none is first offered the company's existing AI Model
 * (`FirstModelSetup`). Owners and admins change models; a Member reads the same
 * cards with nothing to press, and is told who connects one when there is none.
 *
 * `#advanced` in the address opens the active model's Advanced section, for
 * links that come for its settings — the chat's context-window badge.
 */
export function EmployeeModelSection({
  company,
  emp,
}: {
  company: Pick<Company, "id" | "name" | "role">;
  emp: Pick<Employee, "id" | "name">;
}) {
  const [models, setModels] = React.useState<AIModel[] | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const canManage = canManageModels(company.role);
  const { hash } = useLocation();

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<AIModel[]>(
        `/api/companies/${company.id}/employees/${emp.id}/models`,
      );
      setModels(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [company.id, emp.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefetch("employee", reload, emp.id);

  if (loadError)
    return (
      <div className="space-y-3">
        <FormError message={loadError} />
        <Button
          variant="secondary"
          onClick={() => {
            setLoadError(null);
            void reload();
          }}
        >
          Try loading AI Models again
        </Button>
      </div>
    );
  if (models === undefined) return <Spinner />;

  if (models.length === 0) {
    return canManage ? (
      <FirstModelSetup company={company} emp={emp} onSaved={reload} />
    ) : (
      <EmptyState
        title={`${emp.name} has no AI Model yet`}
        description={`An AI Model is what ${emp.name} thinks with, for chat and Routines. An owner or admin of ${company.name} connects one here.`}
      />
    );
  }

  const ordered = activeFirst(models);
  const several = ordered.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {several && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {modelListLine(ordered.length, emp.name)}
        </p>
      )}
      {ordered.map((model) => (
        <ModelCard
          key={model.id}
          company={company}
          emp={emp}
          model={model}
          several={several}
          advancedOpen={hash === "#advanced" && (model.isActive || !several)}
          onChanged={reload}
        />
      ))}
      {canManage &&
        (adding ? (
          <AddModelPanel
            company={company}
            emp={emp}
            held={ordered}
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void reload();
            }}
          />
        ) : (
          <AddModelButton onClick={() => setAdding(true)} />
        ))}
    </div>
  );
}
