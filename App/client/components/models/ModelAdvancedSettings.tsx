import React from "react";
import { Edit3, Trash2 } from "lucide-react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { holdsApiKeys } from "@/lib/modelApiKeys";
import { describeModel, modelName } from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { CustomEndpointPanel } from "./ConnectPanels";
import { ContextWindowPanel } from "./ContextWindowPanel";
import { ModelSettingList, ModelSettingSection } from "./ModelSettingSection";
import { ModelSetupForm } from "./ModelSetupForm";
import { RunConcurrencyPanel } from "./RunConcurrencyPanel";
import { SubscriptionPanel } from "./SubscriptionPanel";

type Props = {
  company: Pick<Company, "id" | "role">;
  emp: Pick<Employee, "id" | "name">;
  model: AIModel;
  canManage: boolean;
  onChanged: () => void;
};

/**
 * Everything one model card's Advanced section holds — that model's own
 * settings and nothing about any other:
 *
 *   - an API-key model: its API keys (backups included), its model, context
 *     window, concurrent Runs, and Remove;
 *   - a custom endpoint: the endpoint (server, model it serves, key), context
 *     window, concurrent Runs, and Remove;
 *   - a ChatGPT sign-in: the sign-in, its model, and Remove — Codex manages its
 *     context and Runs, so it has neither control;
 *   - a model still waiting to connect: changing its service or model, for an
 *     owner who picked the wrong one. Finishing the connection stays on the
 *     card, where it is the next thing to do.
 *
 * A Member reads the same settings with no control to change them.
 */
export function ModelAdvancedSettings({ company, emp, model, canManage, onChanged }: Props) {
  const connected = model.status === "connected";
  const tunable = connected && model.authMode !== "subscription";

  if (!connected) {
    return (
      <ModelSettingList>
        <ModelChoiceSection
          company={company}
          emp={emp}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      </ModelSettingList>
    );
  }

  return (
    <ModelSettingList>
      {holdsApiKeys(model) && (
        <ApiKeysPanel company={company} emp={emp} model={model} onChanged={onChanged} />
      )}
      {model.authMode === "subscription" && (
        <ModelSettingSection title="ChatGPT sign-in">
          <SubscriptionPanel
            company={company}
            emp={emp}
            model={model}
            canManage={canManage}
            onSaved={onChanged}
          />
        </ModelSettingSection>
      )}
      {model.authMode === "customEndpoint" ? (
        <EndpointSection
          company={company}
          emp={emp}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      ) : (
        <ModelChoiceSection
          company={company}
          emp={emp}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {tunable && (
        <ContextWindowPanel
          company={company}
          emp={emp}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {tunable && (
        <RunConcurrencyPanel
          company={company}
          emp={emp}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {canManage && (
        <RemoveSection company={company} emp={emp} model={model} onChanged={onChanged} />
      )}
    </ModelSettingList>
  );
}

/**
 * Which model it runs, and — for an owner — changing it: a pick from the
 * models its own keys can reach, or another service with a new key. A ChatGPT
 * sign-in changes its model ID with the sign-in it already has.
 */
function ModelChoiceSection({ company, emp, model, canManage, onChanged }: Props) {
  const [changing, setChanging] = React.useState(false);
  const connected = model.status === "connected";
  return (
    <ModelSettingSection
      title={connected ? "Model" : "Service and model"}
      description={
        <>
          <span className="font-mono text-slate-700 dark:text-slate-200">{modelName(model)}</span>
          {model.authMode === "subscription" && model.model === "auto"
            ? " · whatever your ChatGPT workspace offers as its default"
            : null}
        </>
      }
      aside={
        canManage &&
        !changing && (
          <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
            <Edit3 size={14} /> Change
          </Button>
        )
      }
    >
      {changing && (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
              Change the model or service
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
          <ModelSetupForm
            mode="edit"
            editModelId={model.id}
            initial={{ provider: model.provider, model: model.model, authMode: model.authMode }}
            company={company}
            emp={emp}
            onSaved={() => {
              setChanging(false);
              onChanged();
            }}
            submitLabel="Save"
            catalogFromSavedKeys={connected}
          />
        </div>
      )}
    </ModelSettingSection>
  );
}

/**
 * A custom endpoint: the server it reaches, the model that server serves, and
 * whether a key is saved — the URL and key themselves never reach the browser.
 */
function EndpointSection({ company, emp, model, canManage, onChanged }: Props) {
  const [changing, setChanging] = React.useState(false);
  return (
    <ModelSettingSection
      title="Endpoint"
      description={
        <>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <dt>Server</dt>
            <dd className="break-all font-mono text-slate-700 dark:text-slate-200">
              {model.customEndpointHost ?? "—"}
            </dd>
            <dt>Model</dt>
            <dd className="break-all font-mono text-slate-700 dark:text-slate-200">
              {modelName(model)}
            </dd>
            <dt>API key</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {model.customEndpointHasApiKey ? "Saved" : "None"}
            </dd>
          </dl>
          <span className="mt-1 block text-slate-400 dark:text-slate-500">
            When the server serves a single model, Genosyn follows it if the server restarts with
            another.
          </span>
        </>
      }
      aside={
        canManage &&
        !changing && (
          <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
            <Edit3 size={14} /> Change endpoint
          </Button>
        )
      }
    >
      {changing && (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
              Change the endpoint
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
          <CustomEndpointPanel
            company={company}
            emp={emp}
            model={model}
            onSaved={() => {
              setChanging(false);
              onChanged();
            }}
          />
        </div>
      )}
    </ModelSettingSection>
  );
}

/** Taking this model off the employee, asking first. */
function RemoveSection({ company, emp, model, onChanged }: Omit<Props, "canManage">) {
  const { removing, remove } = useRemoveModel({ company, emp, model, onChanged });
  return (
    <ModelSettingSection
      title={`Remove from ${emp.name}`}
      description={
        model.isActive
          ? `${emp.name} stops using it. If ${emp.name} has another AI Model, the most recently added one becomes active.`
          : `${emp.name} stops using it. Nothing else changes.`
      }
      aside={
        <Button size="sm" variant="secondary" onClick={remove} loading={removing}>
          <Trash2 size={14} /> Remove
        </Button>
      }
    />
  );
}

/**
 * Remove one model, asking first when it holds a credential. A card's Cancel
 * (a model that never finished connecting) and its Advanced Remove share it.
 * Routines pinned to it go back to the employee's active model.
 */
export function useRemoveModel({
  company,
  emp,
  model,
  onChanged,
}: {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id" | "name">;
  model: AIModel;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [removing, setRemoving] = React.useState(false);

  async function remove() {
    if (model.status === "connected") {
      const ok = await dialog.confirm({
        title: `Remove this AI Model from ${emp.name}?`,
        message: `${emp.name} stops using ${describeModel(model)}, and the credentials saved with it here are deleted. AI Employees that use their own copy keep it. You can connect it again any time.`,
        confirmLabel: "Remove",
        variant: "danger",
      });
      if (!ok) return;
    }
    setRemoving(true);
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}/models/${model.id}`);
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t remove the AI Model" });
    } finally {
      setRemoving(false);
    }
  }

  return { removing, remove };
}
