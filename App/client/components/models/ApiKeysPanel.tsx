import React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { api, type AIModel, type AIModelApiKey, type Company } from "@/lib/api";
import { companyModelPath } from "@/lib/companyModels";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { useDialog } from "@/components/ui/Dialog";
import { clsx } from "@/components/ui/clsx";
import { errorDetail, errorMessage } from "@/lib/errors";
import { apiKeyHealthLine, apiKeyState, isRefused, moveApiKey } from "@/lib/modelApiKeys";
import { ModelSettingSection } from "./ModelSettingSection";

/**
 * An API-key AI Model's keys, in its card's Advanced section: the primary and every backup
 * key in the order requests try them, each as a masked preview with how it has
 * been doing. When the provider refuses a key — invalid or revoked, out of
 * credit, rate-limited — the same request moves to the next key, so this list
 * is where an owner sees which key is dead.
 *
 * Owners and admins add keys (each tested alone first), move them up and down
 * — the top one is the primary — and remove them; anyone else reads the list.
 * There is no limit on how many keys a model holds.
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
  // `${action}:${keyId}` of the row button pressed, while its request runs.
  const [busy, setBusy] = React.useState<string | null>(null);
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

  async function move(key: AIModelApiKey, direction: "up" | "down") {
    setRowError(null);
    setBusy(`${direction}:${key.id}`);
    try {
      await api.post<AIModel>(`${base}/reorder`, {
        orderedIds: moveApiKey(
          keys.map((k) => k.id),
          key.id,
          direction,
        ),
      });
      onChanged();
    } catch (err) {
      setRowError(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(key: AIModelApiKey, index: number) {
    const ok = await dialog.confirm({
      title: "Remove this API key?",
      message: `${key.preview} will be removed from this AI Model and its stored copy deleted.${
        index === 0 ? " The next key becomes the primary." : ""
      }`,
      confirmLabel: "Remove key",
      variant: "danger",
    });
    if (!ok) return;
    setRowError(null);
    setBusy(`remove:${key.id}`);
    try {
      await api.del(`${base}/${encodeURIComponent(key.id)}`);
      onChanged();
    } catch (err) {
      setRowError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ModelSettingSection
      headingId={`api-keys-${model.id}`}
      title="API keys"
      description="Requests use the first key. When the provider refuses it — invalid or revoked, out of credit, or rate-limited — the same request moves to the next key, so work carries on; a refused key is skipped for a few minutes."
    >
      <FormError
        message={rowError ? errorMessage(rowError) : null}
        detail={errorDetail(rowError)}
        className="mb-2"
      />

      <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3 dark:divide-slate-800 dark:border-slate-700">
        {keys.map((key, index) => {
          const refused = isRefused(key, now);
          const state = apiKeyState(key, now);
          return (
            <li
              key={key.id}
              aria-label={`API key ${index + 1}: ${key.preview}`}
              className="flex items-start justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {index + 1}
                  </span>
                  <span className="font-mono text-xs text-slate-800 dark:text-slate-100">
                    {key.preview}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {index === 0 ? "Primary" : "Backup"}
                  </span>
                  {refused && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">
                      {state === "resting" ? "Skipped for now" : "Failing"}
                    </span>
                  )}
                </div>
                <div
                  className={clsx(
                    "mt-0.5 text-xs",
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
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move key ${index + 1} up`}
                    title="Move up"
                    className="px-2"
                    onClick={() => move(key, "up")}
                    loading={busy === `up:${key.id}`}
                    disabled={index === 0 || busy !== null || adding}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move key ${index + 1} down`}
                    title="Move down"
                    className="px-2"
                    onClick={() => move(key, "down")}
                    loading={busy === `down:${key.id}`}
                    disabled={index === keys.length - 1 || busy !== null || adding}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove key ${index + 1}`}
                    title={
                      keys.length === 1
                        ? "The only key can't be removed — remove the AI Model instead"
                        : "Remove"
                    }
                    className="px-2"
                    onClick={() => remove(key, index)}
                    loading={busy === `remove:${key.id}`}
                    disabled={keys.length === 1 || busy !== null || adding}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {canManage && (
        <form className="mt-3 flex flex-col gap-2" onSubmit={add}>
          <Input
            label="Add a backup key"
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
            that key&apos;s API allowance. Add as many keys as you like.
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
              disabled={!newKey.trim() || busy !== null}
            >
              <Plus size={14} />
              {adding ? "Testing key…" : "Add backup key"}
            </Button>
          </div>
        </form>
      )}
    </ModelSettingSection>
  );
}
