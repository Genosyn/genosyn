import React from "react";
import { Edit3, Trash2, Unlink } from "lucide-react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import {
  companyModelPath,
  detachPrompt,
  employeeModelPath,
  removalPrompt,
  sharedWithLine,
} from "@/lib/companyModels";
import { holdsApiKeys } from "@/lib/modelApiKeys";
import { modelName } from "@/lib/modelSummary";
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
  /** The AI Employee whose Model page this is; absent in Settings → AI Models. */
  emp?: Pick<Employee, "id" | "name">;
  model: AIModel;
  /** Every company model, in Settings → AI Models, so removing one can say who it strands. */
  companyModels?: readonly AIModel[];
  canManage: boolean;
  onChanged: () => void;
};

/**
 * Everything one model card's Advanced section holds — that model's own
 * settings and nothing about any other:
 *
 *   - an API-key model: its API keys (the pool its sessions are spread
 *     across), its model, context window, concurrent Runs;
 *   - a custom endpoint: the endpoint (server, model it serves, key), context
 *     window, concurrent Runs;
 *   - a ChatGPT sign-in: the sign-in and its model — Codex manages its context
 *     and Runs, so it has neither control;
 *   - a model still waiting to connect: changing its service or model, for an
 *     owner who picked the wrong one. Finishing the connection stays on the
 *     card, where it is the next thing to do.
 *
 * The model is the company's, so a setting changed here changes for every AI
 * Employee on it — the section says so when anyone else shares it. Last comes
 * the way out: on an employee's page, detaching it from that employee; in
 * Settings → AI Models, removing it from the company. A Member reads the same
 * settings with no control to change them.
 */
export function ModelAdvancedSettings({
  company,
  emp,
  model,
  companyModels,
  canManage,
  onChanged,
}: Props) {
  const connected = model.status === "connected";
  const tunable = connected && model.authMode !== "subscription";
  const shared = emp ? sharedWithLine(model, emp.id) : null;

  const exit =
    canManage &&
    (emp ? (
      <DetachSection company={company} emp={emp} model={model} onChanged={onChanged} />
    ) : (
      <RemoveSection
        company={company}
        model={model}
        companyModels={companyModels ?? [model]}
        onChanged={onChanged}
      />
    ));

  if (!connected) {
    // On an employee's page a model still waiting to connect is cancelled from
    // its card; the company's page removes it here.
    return (
      <ModelSettingList>
        <ModelChoiceSection company={company} model={model} canManage={canManage} onChanged={onChanged} />
        {!emp && exit}
      </ModelSettingList>
    );
  }

  return (
    <ModelSettingList>
      {shared && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {shared}. A change here changes it for them too.
        </p>
      )}
      {holdsApiKeys(model) && (
        <ApiKeysPanel company={company} model={model} onChanged={onChanged} />
      )}
      {model.authMode === "subscription" && (
        <ModelSettingSection title="ChatGPT sign-in">
          <SubscriptionPanel
            company={company}
            model={model}
            canManage={canManage}
            onSaved={onChanged}
          />
        </ModelSettingSection>
      )}
      {model.authMode === "customEndpoint" ? (
        <EndpointSection company={company} model={model} canManage={canManage} onChanged={onChanged} />
      ) : (
        <ModelChoiceSection company={company} model={model} canManage={canManage} onChanged={onChanged} />
      )}
      {tunable && (
        <ContextWindowPanel
          company={company}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {tunable && (
        <RunConcurrencyPanel
          company={company}
          model={model}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {exit}
    </ModelSettingList>
  );
}

type SettingProps = {
  company: Pick<Company, "id" | "role">;
  model: AIModel;
  canManage: boolean;
  onChanged: () => void;
};

/**
 * Which model it runs, and — for an owner — changing it: a pick from the
 * models its own keys can reach, or another service with a new key. A ChatGPT
 * sign-in changes its model ID with the sign-in it already has.
 */
function ModelChoiceSection({ company, model, canManage, onChanged }: SettingProps) {
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
function EndpointSection({ company, model, canManage, onChanged }: SettingProps) {
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

/** Taking this model off one employee, asking first. The model stays in the company. */
function DetachSection({
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
  const { detaching, detach } = useDetachModel({ company, emp, model, onChanged });
  return (
    <ModelSettingSection
      title={`Detach from ${emp.name}`}
      description={
        model.isActive
          ? `${emp.name} stops using it, and the AI Model stays in Settings → AI Models. If ${emp.name} has another AI Model, the most recently added one becomes active.`
          : `${emp.name} stops using it, and the AI Model stays in Settings → AI Models. Nothing else changes.`
      }
      aside={
        <Button size="sm" variant="secondary" onClick={detach} loading={detaching}>
          <Unlink size={14} /> Detach
        </Button>
      }
    />
  );
}

/** Removing the model from the company — guarded while anyone uses it. */
function RemoveSection({
  company,
  model,
  companyModels,
  onChanged,
}: {
  company: Pick<Company, "id">;
  model: AIModel;
  companyModels: readonly AIModel[];
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [removing, setRemoving] = React.useState(false);
  const inUse = model.employees.length > 0;

  async function remove() {
    const prompt = removalPrompt(companyModels, model);
    const ok = await dialog.confirm({
      title: prompt.title,
      message: prompt.message,
      confirmLabel: prompt.confirmLabel,
      variant: "danger",
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await api.del(
        companyModelPath(company.id, model.id, prompt.detach ? "?detach=true" : ""),
      );
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t remove the AI Model" });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <ModelSettingSection
      title="Remove from the company"
      description={
        inUse
          ? "Its keys are deleted, and every AI Employee using it is detached from it first. You're asked before anything changes."
          : "Its keys are deleted. You can connect it again any time."
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
 * Detach one model from one employee, asking first when it is connected. A
 * card's Cancel on a model that never finished connecting and only this
 * employee has goes further and removes it: there is nothing in it to keep.
 * Routines pinned to it go back to the employee's active model.
 */
export function useDetachModel({
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
  const [detaching, setDetaching] = React.useState(false);
  const abandoned =
    model.status !== "connected" && model.employees.every((user) => user.id === emp.id);

  async function detach() {
    if (model.status === "connected") {
      const prompt = detachPrompt(model, emp);
      const ok = await dialog.confirm({
        title: prompt.title,
        message: prompt.message,
        confirmLabel: prompt.confirmLabel,
        variant: "danger",
      });
      if (!ok) return;
    }
    setDetaching(true);
    try {
      if (abandoned) await api.del(companyModelPath(company.id, model.id, "?detach=true"));
      else await api.del(employeeModelPath(company.id, emp.id, model.id));
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t detach the AI Model" });
    } finally {
      setDetaching(false);
    }
  }

  return { detaching, detach };
}
