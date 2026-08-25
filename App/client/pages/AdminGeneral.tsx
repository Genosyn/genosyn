import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe2,
  RefreshCw,
  Save,
} from "lucide-react";
import { api, type InstanceSettings } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";

/** Admin → General. Database-backed settings for the whole installation. */
export function AdminGeneral() {
  const [data, setData] = React.useState<InstanceSettings | null>(null);
  const [publicUrl, setPublicUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const detectedUrl = window.location.origin;

  const reload = React.useCallback(async () => {
    try {
      const next = await api.get<InstanceSettings>("/api/admin/instance-settings");
      setData(next);
      setPublicUrl(next.publicUrl);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the instance settings"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return (
      <>
        <TopBar title="General" />
        <Card>
          <CardBody>{loadError ? <FormError message={loadError} /> : <Spinner />}</CardBody>
        </Card>
      </>
    );
  }

  const normalizedDraft = publicUrl.trim().replace(/\/$/, "");
  const dirty = normalizedDraft !== data.publicUrl;
  const differsFromBrowser = data.publicUrl !== detectedUrl;

  const save = async () => {
    setError(null);
    if (!publicUrl.trim()) {
      setError("Public URL is required");
      return;
    }
    setSaving(true);
    try {
      const next = await api.put<InstanceSettings>("/api/admin/instance-settings", {
        publicUrl: publicUrl.trim(),
      });
      setData(next);
      setPublicUrl(next.publicUrl);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TopBar
        title="General"
        right={
          <Button variant="secondary" onClick={reload} disabled={saving}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FormError message={loadError} />

        <Card
          className={
            data.configured && !differsFromBrowser
              ? "border-emerald-200 dark:border-emerald-500/30"
              : "border-amber-200 dark:border-amber-500/30"
          }
        >
          <CardBody className="flex items-center gap-3">
            <span
              className={
                data.configured && !differsFromBrowser
                  ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                  : "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
              }
            >
              {data.configured && !differsFromBrowser ? (
                <CheckCircle2 size={20} />
              ) : (
                <AlertTriangle size={20} />
              )}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {!data.configured
                  ? "Public URL has not been confirmed"
                  : differsFromBrowser
                    ? "Public URL differs from this browser"
                    : "Public URL is configured"}
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {!data.configured || differsFromBrowser
                  ? `This browser reached Genosyn at ${detectedUrl}. Review and save the value below.`
                  : "Absolute links, OAuth callbacks, and WebAuthn use this origin."}
              </p>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe2 size={16} className="text-indigo-500" />
              <div>
                <h2 className="text-sm font-semibold">Public URL</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  The exact origin Members use to open this Genosyn installation.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (dirty) void save();
              }}
            >
              <Input
                label="Public URL"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://genosyn.example.com"
                value={publicUrl}
                onChange={(event) => setPublicUrl(event.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Enter only the origin: scheme, hostname, and optional port. Paths, query strings,
                fragments, and embedded credentials are rejected. Changes apply without a restart.
              </p>
              {normalizedDraft !== detectedUrl && (
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPublicUrl(detectedUrl)}
                    disabled={saving}
                  >
                    Use {detectedUrl}
                  </Button>
                </div>
              )}
              <FormError message={error} />
              <div className="flex justify-end">
                <Button type="submit" disabled={!dirty || saving}>
                  <Save size={14} /> {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
