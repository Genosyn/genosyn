import React from "react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { errorDetail, errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";

type PanelProps = {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id">;
  model: AIModel;
  onSaved: () => void;
};

/**
 * The API key a Claude or OpenAI model is still waiting for. Saving tests a
 * real reply first, so a key that does not work is never stored.
 */
export function ApiKeyPanel({ company, emp, model, onSaved }: PanelProps) {
  const [key, setKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/apikey`,
            { apiKey: key },
          );
          setKey("");
          onSaved();
        } catch (err) {
          setError(err);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Input
        label="API key"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={model.provider === "openai" ? "sk-…" : "sk-ant-…"}
        required
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        We test a real reply before saving it. Stored encrypted.
      </p>
      <FormError message={error ? errorMessage(error) : null} detail={errorDetail(error)} />
      <div>
        <Button type="submit" loading={saving} disabled={key.length === 0}>
          {saving ? "Testing connection…" : "Connect AI Model"}
        </Button>
      </div>
    </form>
  );
}

/**
 * A custom OpenAI-compatible endpoint: its base URL, model ID and optional
 * key. Used to finish connecting one, and to change a connected one.
 *
 * The saved URL and key never come back to the browser — the card only knows
 * the host — so changing the endpoint asks for its details again, and a key
 * left blank is saved as no key. The test runs before anything is replaced: a
 * failed one leaves the working endpoint as it was.
 */
export function CustomEndpointPanel({ company, emp, model, onSaved }: PanelProps) {
  const [baseURL, setBaseURL] = React.useState("");
  const [modelId, setModelId] = React.useState(model.customEndpointModelId ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const connected = model.status === "connected";
  const host = model.customEndpointHost;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/custom-endpoint`,
            { baseURL, modelId, ...(apiKey ? { apiKey } : {}) },
          );
          setApiKey("");
          onSaved();
        } catch (err) {
          setError(err);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Base URL"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder={host ? `e.g. http://${host}/v1` : "http://host.docker.internal:11434/v1"}
          required
        />
        <Input
          label="Model ID (optional)"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="Blank: the model the server serves"
        />
      </div>
      <Input
        label="API key (optional)"
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={
          model.customEndpointHasApiKey
            ? "A key is saved — enter it again to keep it"
            : "Leave blank if the server needs none"
        }
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {connected
          ? "Genosyn never sends the saved URL or key back to your browser, so enter them again to change the endpoint. "
          : "Point this AI Model at an OpenAI-compatible server, such as Ollama, vLLM or llama.cpp. "}
        Leave the model ID blank on a server that serves one model: Genosyn uses it, and follows it
        if the server restarts with another. We test a real reply before saving; the URL and key are
        stored encrypted.
      </p>
      <FormError message={error ? errorMessage(error) : null} detail={errorDetail(error)} />
      <div>
        <Button type="submit" loading={saving} disabled={baseURL.length === 0}>
          {saving ? "Testing connection…" : connected ? "Save endpoint" : "Save & connect"}
        </Button>
      </div>
    </form>
  );
}
