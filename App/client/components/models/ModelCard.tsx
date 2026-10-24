import React from "react";
import { AlertTriangle, Check, PlugZap, X } from "lucide-react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { errorDetail, errorMessage } from "@/lib/errors";
import { failingKeysNotice } from "@/lib/modelApiKeys";
import {
  canManageModels,
  describeModel,
  modelAdvancedSummary,
  modelConnectionLine,
  testPassedLine,
} from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { clsx } from "@/components/ui/clsx";
import { ApiKeyPanel, CustomEndpointPanel } from "./ConnectPanels";
import { ModelActiveBadge, ModelKindIcon, ModelStatusBadge } from "./ModelBadges";
import { ModelAdvancedSettings, useRemoveModel } from "./ModelAdvancedSettings";
import { SubscriptionPanel } from "./SubscriptionPanel";

/**
 * One AI Model, whole: what it is and whether it is connected, what to do with
 * it — Test connection, Make active — and, inside the same card, an Advanced
 * section closed by default that holds that model's own settings. Its closed
 * line names whatever has been changed in it ("2 backup API keys · 4 concurrent
 * Runs"), so nothing set is hidden by being folded away, and nothing about this
 * model lives anywhere but this card.
 *
 * A model still waiting to connect shows the step that finishes it on the card
 * itself. A key the provider is refusing is said on the card too, not only
 * inside Advanced: it is the one thing in there nobody should have to look for.
 * A Member sees the same card with nothing to press.
 */
export function ModelCard({
  company,
  emp,
  model,
  several,
  advancedOpen,
  onChanged,
}: {
  company: Pick<Company, "id" | "role">;
  emp: Pick<Employee, "id" | "name">;
  model: AIModel;
  /** The employee holds more than one AI Model, so the active one is marked. */
  several: boolean;
  /** Open the Advanced section on arrival — a link that came for its settings. */
  advancedOpen?: boolean;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const canManage = canManageModels(company.role);
  const connected = model.status === "connected";
  const base = `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}`;
  const [activating, setActivating] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testPassed, setTestPassed] = React.useState<string | null>(null);
  const [testError, setTestError] = React.useState<unknown>(null);
  const { removing, remove } = useRemoveModel({ company, emp, model, onChanged });
  const keyNotice = failingKeysNotice(model);
  const headingId = React.useId();

  async function activate() {
    setActivating(true);
    try {
      await api.post(`${base}/activate`);
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t switch the active AI Model" });
    } finally {
      setActivating(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestPassed(null);
    setTestError(null);
    try {
      const reply = await api.post<{ ok: true; elapsedMs: number }>(`${base}/test`);
      setTestPassed(testPassedLine(reply.elapsedMs));
    } catch (err) {
      setTestError(err);
    } finally {
      setTesting(false);
      // Either way the test's requests told each key's health something new.
      onChanged();
    }
  }

  const actions = canManage && (
    <>
      {connected && (
        <Button size="sm" variant="secondary" onClick={test} loading={testing}>
          <PlugZap size={14} />
          {testing ? "Testing…" : "Test connection"}
        </Button>
      )}
      {connected && several && !model.isActive && (
        <Button size="sm" variant="secondary" onClick={activate} loading={activating}>
          <Check size={14} />
          Make active
        </Button>
      )}
      {!connected && (
        <Button size="sm" variant="ghost" onClick={remove} loading={removing}>
          <X size={14} /> Cancel
        </Button>
      )}
    </>
  );

  // A Member has nothing to change on a model still waiting for its owner.
  const showAdvanced = connected || canManage;

  return (
    <Card
      role="group"
      aria-labelledby={headingId}
      className={clsx(
        several && model.isActive && "ring-1 ring-indigo-300 dark:ring-indigo-500/40",
      )}
    >
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
            <ModelKindIcon model={model} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3
                  id={headingId}
                  className="break-words text-sm font-semibold text-slate-900 dark:text-slate-100"
                >
                  {describeModel(model)}
                </h3>
                <ModelStatusBadge connected={connected} />
                {several && model.isActive && <ModelActiveBadge />}
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {modelConnectionLine(model)}
              </p>
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>

        <FormSuccess message={testPassed} />
        <FormError
          message={testError ? errorMessage(testError) : null}
          detail={errorDetail(testError)}
        />

        {keyNotice && (
          <div
            role="status"
            className={clsx(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
              keyNotice.all
                ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
            )}
          >
            <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />
            <span>{keyNotice.text}</span>
          </div>
        )}

        {!connected && canManage && model.authMode === "apikey" && (
          <ApiKeyPanel company={company} emp={emp} model={model} onSaved={onChanged} />
        )}
        {!connected && model.authMode === "subscription" && (
          <SubscriptionPanel
            company={company}
            emp={emp}
            model={model}
            canManage={canManage}
            onSaved={onChanged}
          />
        )}
        {!connected && canManage && model.authMode === "customEndpoint" && (
          <CustomEndpointPanel company={company} emp={emp} model={model} onSaved={onChanged} />
        )}
        {!connected && !canManage && model.authMode !== "subscription" && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Waiting for an owner or admin to finish connecting it.
          </p>
        )}
      </CardBody>

      {showAdvanced && (
        <Disclosure
          variant="inset"
          title="Advanced"
          summary={modelAdvancedSummary(model)}
          defaultOpen={advancedOpen}
          keepMounted
        >
          <ModelAdvancedSettings
            company={company}
            emp={emp}
            model={model}
            canManage={canManage}
            onChanged={onChanged}
          />
        </Disclosure>
      )}
    </Card>
  );
}
