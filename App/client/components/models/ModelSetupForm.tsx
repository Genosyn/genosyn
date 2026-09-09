import React from "react";
import {
  api,
  type AIModel,
  type AuthMode,
  type Company,
  type Employee,
  type Provider,
} from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type ModelCatalog = { models: Array<{ id: string; label: string }>; recommendedModel: string };

/** One submit connects API models; an optional choice follows live account discovery. */
export function ModelSetupForm({
  mode,
  editModelId,
  initial,
  company,
  emp,
  onSaved,
  submitLabel,
}: {
  mode: "create" | "edit";
  editModelId?: string;
  initial: { provider: Provider; model: string; authMode: AuthMode };
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id">;
  onSaved: () => void;
  submitLabel: string;
}) {
  const [provider, setProvider] = React.useState(initial.provider);
  const [authMode, setAuthMode] = React.useState(initial.authMode);
  const [modelStr, setModelStr] = React.useState(initial.model === "auto" ? "" : initial.model);
  const [apiKey, setApiKey] = React.useState("");
  const [baseURL, setBaseURL] = React.useState("");
  const [customModelId, setCustomModelId] = React.useState("");
  const [catalog, setCatalog] = React.useState<ModelCatalog | null>(null);
  const [discovering, setDiscovering] = React.useState(false);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const requestVersion = React.useRef(0);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models`;
  const isCustom = provider === "custom";
  const editingExistingCustom = mode === "edit" && isCustom && initial.provider === "custom";
  const isApiKey = !isCustom && authMode === "apikey";
  const needsKey =
    mode === "create" || provider !== initial.provider || authMode !== initial.authMode;

  function clearDiscovery() {
    requestVersion.current += 1;
    setCatalog(null);
    setDiscoveryError(null);
    setDiscovering(false);
    setError(null);
  }

  React.useEffect(() => {
    if (!isApiKey || !apiKey.trim()) return;
    const version = ++requestVersion.current;
    let stopped = false;
    setDiscovering(true);
    const timer = window.setTimeout(() => {
      api
        .post<ModelCatalog>(`${base}/discover`, { provider, apiKey: apiKey.trim() })
        .then((result) => {
          if (!stopped && version === requestVersion.current) setCatalog(result);
        })
        .catch((err: unknown) => {
          if (!stopped && version === requestVersion.current) setDiscoveryError(message(err));
        })
        .finally(() => {
          if (!stopped && version === requestVersion.current) setDiscovering(false);
        });
    }, 500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [apiKey, base, isApiKey, provider, refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (editingExistingCustom) return;
    setError(null);
    setSaving(true);
    try {
      if (isApiKey && mode === "create") {
        await api.post<AIModel>(`${base}/connect`, {
          provider,
          apiKey: apiKey.trim(),
          ...(modelStr || catalog?.recommendedModel
            ? { model: modelStr || catalog?.recommendedModel }
            : {}),
        });
      } else if (isCustom) {
        await api.post<AIModel>(`${base}/connect-custom`, {
          baseURL,
          modelId: customModelId,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        });
      } else {
        const selectedModel =
          modelStr || catalog?.recommendedModel || (authMode === "subscription" ? "auto" : "");
        const payload = {
          provider,
          authMode,
          model: selectedModel,
          ...(isApiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        };
        if (mode === "create") await api.post<AIModel>(base, payload);
        else await api.put<AIModel>(`${base}/${editModelId}`, payload);
      }
      setApiKey("");
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="AI Model service"
            value={provider}
            onChange={(e) => {
              clearDiscovery();
              const next = e.target.value as Provider;
              setProvider(next);
              setAuthMode(next === "custom" ? "customEndpoint" : "apikey");
              setModelStr("");
              setApiKey("");
            }}
          >
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="openai">OpenAI / ChatGPT</option>
            <option value="custom" disabled={mode === "edit" && initial.provider !== "custom"}>
              Custom endpoint
            </option>
          </Select>
          {provider === "openai" && (
            <Select
              label="Connect with"
              value={authMode}
              onChange={(e) => {
                clearDiscovery();
                setAuthMode(e.target.value as AuthMode);
                setModelStr("");
                setApiKey("");
              }}
            >
              <option value="apikey">OpenAI API key</option>
              <option
                value="subscription"
                disabled={mode === "edit" && initial.authMode !== "subscription"}
              >
                ChatGPT sign-in
              </option>
            </Select>
          )}
        </div>
        {mode === "edit" && initial.provider !== "custom" && (
          <p className="text-xs text-slate-500">
            Use Add model to connect a custom endpoint or start a new ChatGPT sign-in.
          </p>
        )}
        {isApiKey && (
          <>
            <Input
              label={needsKey ? "API key" : "Replace API key (optional)"}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                clearDiscovery();
                setApiKey(e.target.value);
              }}
              required={needsKey}
              placeholder={
                provider === "anthropic"
                  ? "Paste your Anthropic API key"
                  : "Paste your OpenAI API key"
              }
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              We find the available models and test a real reply before connecting. Your key is
              stored encrypted. The small test uses your API account.
            </p>
            {discovering && (
              <p role="status" className="text-xs text-slate-500">
                Finding available models…
              </p>
            )}
            {catalog && (
              <Select label="Model" value={modelStr} onChange={(e) => setModelStr(e.target.value)}>
                <option value="">
                  Recommended:{" "}
                  {catalog.models.find((m) => m.id === catalog.recommendedModel)?.label ||
                    catalog.recommendedModel}
                </option>
                {modelStr && !catalog.models.some((m) => m.id === modelStr) && (
                  <option value={modelStr}>{modelStr} (your choice)</option>
                )}
                {catalog.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
            {catalog && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Recommended from the newest compatible models your account can access.
              </p>
            )}
            {discoveryError && (
              <div className="space-y-2">
                <FormError message={discoveryError} />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    clearDiscovery();
                    setRefresh((n) => n + 1);
                  }}
                >
                  Try loading models again
                </Button>
              </div>
            )}
            <details className="text-xs text-slate-600 dark:text-slate-300">
              <summary className="cursor-pointer">Choose a model ID manually</summary>
              <div className="mt-3">
                <Input
                  label="Model ID (optional)"
                  value={modelStr}
                  onChange={(e) => setModelStr(e.target.value)}
                  placeholder="Leave blank to choose automatically"
                />
              </div>
            </details>
          </>
        )}
        {authMode === "subscription" && (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {mode === "edit"
                ? "We test your selected model with the existing ChatGPT sign-in before saving. Leave the model ID blank to use your workspace’s current default."
                : "Continue to sign in with ChatGPT. We use your workspace’s current default model and test a reply before connecting."}
            </p>
            <details className="text-xs text-slate-600 dark:text-slate-300">
              <summary className="cursor-pointer">Choose a model ID manually</summary>
              <div className="mt-3">
                <Input
                  label="Model ID (optional)"
                  value={modelStr}
                  onChange={(e) => setModelStr(e.target.value)}
                  placeholder="Use the ChatGPT default"
                />
              </div>
            </details>
          </>
        )}
        {editingExistingCustom && (
          <p className="text-xs text-slate-500">
            Use the endpoint form above to change this custom model or its credentials.
          </p>
        )}
        {isCustom && !editingExistingCustom && (
          <>
            <Input
              label="Base URL"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="http://localhost:11434/v1"
              required
            />
            <Input
              label="Model ID"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              required
            />
            <Input
              label="API key (optional)"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </>
        )}
        <FormError message={error} />
        {!editingExistingCustom && (
          <div>
            <Button
              type="submit"
              disabled={saving || discovering || (isApiKey && needsKey && !apiKey.trim())}
            >
              {saving
                ? authMode === "subscription" && mode === "create"
                  ? "Preparing sign-in…"
                  : "Testing connection…"
                : isApiKey && mode === "create"
                  ? "Connect AI Model"
                  : authMode === "subscription" && mode === "create"
                    ? "Continue to ChatGPT sign-in"
                    : submitLabel}
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not connect this AI Model. Please try again.";
}
