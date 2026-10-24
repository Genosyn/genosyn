import React from "react";
import { api, type Company, type Employee, type ReusableModel } from "@/lib/api";
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
 * When the company already has one connected, the way forward is a single
 * button — "Use the same AI Model as Avery" — because the key is already in the
 * company and pasting it again is the work this screen exists to remove. The
 * copy happens on the server (`POST …/models/reuse`), so the browser only names
 * which model, never holds a credential. Connecting a different one is the
 * quieter second path, and only then does the connect form appear.
 *
 * With nothing to reuse, the form is the whole screen. A Member, who can't put
 * a credential on an employee, is never shown this: `EmployeeModelSection`
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
  // Only an owner or admin can put a credential on an employee, so only they are
  // offered the shortcut. Anyone else sees the form, as before.
  const canReuse = company.role !== "member";
  const [offers, setOffers] = React.useState<ReusableModel[] | null>(canReuse ? null : []);
  const [connectingNew, setConnectingNew] = React.useState(false);
  const [reusing, setReusing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models`;

  React.useEffect(() => {
    if (!canReuse) return;
    let cancelled = false;
    api
      .get<ReusableModel[]>(`${base}/reusable`)
      .then((list) => {
        if (!cancelled) setOffers(list);
      })
      // The shortcut is optional. If the list can't be read, the connect form
      // below still does the whole job, so fall back to it rather than block.
      .catch(() => {
        if (!cancelled) setOffers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base, canReuse]);

  async function reuse(offer: ReusableModel) {
    setError(null);
    setReusing(offer.id);
    try {
      await api.post(`${base}/reuse`, { sourceModelId: offer.id });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReusing(null);
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
              Pick where {emp.name} thinks, then paste the key. Later hires can reuse it with one
              click.
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
              {lead.employeeName} already runs on it
              {lead.endpointHost ? ` (${lead.endpointHost})` : ""}. {emp.name} would use the same
              key, so there is nothing to paste and usage is billed to the same account.
            </div>
          </div>
          <FormError message={error} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => reuse(lead)} loading={reusing === lead.id}>
              Use the same AI Model as {lead.employeeName}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setConnectingNew(true);
              }}
              disabled={reusing !== null}
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
            reusing={reusing}
            error={error}
            onUse={(offer) => void reuse(offer)}
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
