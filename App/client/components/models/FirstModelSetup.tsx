import React from "react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import {
  attachableModels,
  companyModelPath,
  employeeModelPath,
  sameModelAsLabel,
  usedByLine,
} from "@/lib/companyModels";
import { errorMessage } from "@/lib/errors";
import { describeModel } from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { ModelSetupForm } from "@/components/models/ModelSetupForm";
import { CompanyModelOffers } from "@/components/models/CompanyModelOffers";

/**
 * What an AI Employee with no AI Model sees.
 *
 * When the company already has a model connected, the way forward is a single
 * button — "Use the same AI Model as Avery" — because the key is already in
 * the company and pasting it again is the work this screen exists to remove.
 * It attaches that very model (`POST …/employees/:eid/models/attach`): one set
 * of keys for everyone on it, and the browser only ever names which model.
 * Connecting a different one is the quieter second path, and only then does
 * the connect form appear; the model it connects is the company's too.
 *
 * With nothing to offer, the form is the whole screen. A Member, who can't
 * choose an employee's model, is never shown this: `EmployeeModelSection`
 * says an owner or admin connects one instead.
 */
export function FirstModelSetup({
  company,
  emp,
  onSaved,
}: {
  company: Pick<Company, "id" | "role">;
  emp: Pick<Employee, "id" | "name">;
  onSaved: () => void;
}) {
  // Only an owner or admin can choose an employee's model, so only they are
  // offered the company's. Anyone else sees the form, as before.
  const canAttach = company.role !== "member";
  const [offers, setOffers] = React.useState<AIModel[] | null>(canAttach ? null : []);
  const [connectingNew, setConnectingNew] = React.useState(false);
  const [attaching, setAttaching] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!canAttach) return;
    let cancelled = false;
    api
      .get<AIModel[]>(companyModelPath(company.id))
      .then((list) => {
        if (!cancelled) setOffers(attachableModels(list, emp.id));
      })
      // The shortcut is optional. If the list can't be read, the connect form
      // below still does the whole job, so fall back to it rather than block.
      .catch(() => {
        if (!cancelled) setOffers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, emp.id, canAttach]);

  async function attach(offer: AIModel) {
    setError(null);
    setAttaching(offer.id);
    try {
      await api.post(employeeModelPath(company.id, emp.id, undefined, "/attach"), {
        modelId: offer.id,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAttaching(null);
    }
  }

  if (offers === null) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const [lead, ...others] = offers;

  if (!lead) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Connect an AI Model for {emp.name}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Pick where {emp.name} thinks, then paste the key. The company keeps it, so later hires
              can use it with one click.
            </div>
          </div>
          <ModelSetupForm
            mode="create"
            initial={{ provider: "anthropic", model: "", authMode: "apikey" }}
            company={company}
            emp={emp}
            onSaved={onSaved}
            submitLabel="Continue"
          />
        </CardBody>
      </Card>
    );
  }

  if (!connectingNew) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Connect an AI Model for {emp.name}
            </div>
            <div className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-200">
              {describeModel(lead)}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {lead.employees.length > 0 ? usedByLine(lead) : "Connected in your company"}
              {lead.customEndpointHost ? ` (${lead.customEndpointHost})` : ""}. {emp.name} would run
              on the same AI Model and keys, so there is nothing to paste and usage is billed to the
              same account.
            </div>
          </div>
          <FormError message={error} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => attach(lead)} loading={attaching === lead.id}>
              {sameModelAsLabel(lead)}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setConnectingNew(true);
              }}
              disabled={attaching !== null}
            >
              Connect a different model
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Connect a different model for {emp.name}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Pick where {emp.name} thinks, then paste the key.
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              setConnectingNew(false);
            }}
          >
            Back
          </Button>
        </div>
        {others.length > 0 && (
          <CompanyModelOffers
            offers={others}
            attaching={attaching}
            error={error}
            onUse={(offer) => void attach(offer)}
          />
        )}
        <ModelSetupForm
          mode="create"
          initial={{ provider: "anthropic", model: "", authMode: "apikey" }}
          company={company}
          emp={emp}
          onSaved={onSaved}
          submitLabel="Continue"
        />
      </CardBody>
    </Card>
  );
}
