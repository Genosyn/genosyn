import React from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, type AIModel, type AIModelApiKey, type Company } from "@/lib/api";
import { companyModelPath } from "@/lib/companyModels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { useDialog } from "@/components/ui/Dialog";
import { clsx } from "@/components/ui/clsx";
import { errorDetail, errorMessage } from "@/lib/errors";
import { apiKeyHealthLine, apiKeysDescription, apiKeyState, isRefused } from "@/lib/modelApiKeys";
import { ModelSettingSection } from "./ModelSettingSection";

/**
 * An API-key AI Model's keys, in its card's Advanced section: the pool its
 * sessions are spread across, every key an equal, each as a masked preview
 * with how it has been doing — when it was last used, how many sessions it
 * carried in the last day, and when the provider last refused it and why. A
 * refused key hands its sessions to the others, so this list is where an
 * owner sees the work spread across the keys and which key is dead.
 *
 * Owners and admins add keys (each tested alone first) and remove them;
 * anyone else reads the list. Order means nothing here — each session takes
 * the next key in turn — so there is nothing to move. There is no limit on how
 * many keys a model holds.
 */
export function ApiKeysPanel({
  company,
  model,
  onChanged,
}: {
  company: Pick<Company, "id" | "role">;
  model: Pick<AIModel, "id" | "provider" | "apiKeys">;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const canManage = company.role === "owner" || company.role === "admin";
  const keys = model.apiKeys ?? [];
  const base = companyModelPath(company.id, model.id, "/keys");
  const [newKey, setNewKey] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<unknown>(null);
  // The id of the key whose remove button was pressed, while its request runs.
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<unknown>(null);
  const now = Date.now();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const apiKey = newKey.trim();
    if (!apiKey) return;
    setAddError(null);
    setRowError(null);
    setAdding(true);
    try {
      await api.post<AIModel>(base, { apiKey });
      setNewKey("");
      onChanged();
    } catch (err) {
      setAddError(err);
    } finally {
      setAdding(false);
    }
  }

  async function remove(key: AIModelApiKey) {
    const ok = await dialog.confirm({
      title: "Remove this API key?",
      message: `${key.preview} will be removed from this AI Model and its stored copy deleted. Sessions carry on across the other keys.`,
      confirmLabel: "Remove key",
      variant: "danger",
    });
    if (!ok) return;
    setRowError(null);
    setRemoving(key.id);
    try {
      await api.del(`${base}/${encodeURIComponent(key.id)}`);
      onChanged();
    } catch (err) {
      setRowError(err);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <ModelSettingSection
      headingId={`api-keys-${model.id}`}
      title="API keys"
      description={apiKeysDescription(keys.length)}
    >
      <FormError
        message={rowError ? errorMessage(rowError) : null}
        detail={errorDetail(rowError)}
        className="mb-2"
      />

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3 dark:divide-slate-800 dark:border-slate-700">
        {keys.map((key) => {
          const refused = isRefused(key, now);
          const state = apiKeyState(key, now);
          return (
            <li
              key={key.id}
              aria-label={`API key ${key.preview}`}
              className="flex items-start justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-800 dark:text-slate-100">
                    {key.preview}
                  </span>
                  {refused && (
                    <Badge tone="warning">{state === "resting" ? "Skipped for now" : "Failing"}</Badge>
                  )}
                </div>
                <div
                  className={clsx(
                    "mt-0.5 text-xs tabular-nums",
                    refused
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-slate-500 dark:text-slate-400",
                  )}
                >
                  {apiKeyHealthLine(key, now)}
                </div>
                {refused && key.lastError && (
                  <div
                    className="mt-0.5 line-clamp-2 break-words text-xs text-slate-500 dark:text-slate-400"
                    title={key.lastError}
                  >
                    {key.lastError}
                  </div>
                )}
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove key ${key.preview}`}
                    title={
                      keys.length === 1
                        ? "The only key can't be removed — remove the AI Model instead"
                        : "Remove"
                    }
                    className="px-2"
                    onClick={() => remove(key)}
                    loading={removing === key.id}
                    disabled={keys.length === 1 || removing !== null || adding}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canManage && (
        <form className="mt-3 flex flex-col gap-2" onSubmit={add}>
          <Input
            label="Add a key"
            type="password"
            autoComplete="off"
            value={newKey}
            onChange={(e) => {
              setNewKey(e.target.value);
              setAddError(null);
            }}
            placeholder={
              model.provider === "anthropic"
                ? "Paste another Anthropic API key"
                : "Paste another OpenAI API key"
            }
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            We test a real reply with the key, on its own, before adding it. The small test uses
            that key&apos;s API allowance. Add as many keys as you like — a new key joins the turns
            straight away.
          </p>
          <FormError
            message={addError ? errorMessage(addError) : null}
            detail={errorDetail(addError)}
          />
          <div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              loading={adding}
              disabled={!newKey.trim() || removing !== null}
            >
              <Plus size={14} />
              {adding ? "Testing key…" : "Add key"}
            </Button>
          </div>
        </form>
      )}
    </ModelSettingSection>
  );
}
