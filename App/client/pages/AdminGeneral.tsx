import React from "react";
import { AlertTriangle, CheckCircle2, Code2, Globe2, RefreshCw, Save } from "lucide-react";
import { api, type CustomJavaScriptSettings, type InstanceSettings } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Disclosure } from "../components/ui/Disclosure";
import { Input } from "../components/ui/Input";
import { describeCustomJavaScript } from "../lib/customJavaScriptSummary";
import { Textarea } from "../components/ui/Textarea";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";

/**
 * Admin → General. Database-backed settings for the whole installation: the
 * public URL up front, with its own status, and custom JavaScript — rare, and
 * code every Member's browser runs — under one closed Advanced disclosure.
 */
export function AdminGeneral() {
  const [data, setData] = React.useState<InstanceSettings | null>(null);
  const [javascriptData, setJavaScriptData] = React.useState<CustomJavaScriptSettings | null>(null);
  const [publicUrl, setPublicUrl] = React.useState("");
  const [customJavaScript, setCustomJavaScript] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [savingJavaScript, setSavingJavaScript] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [javascriptError, setJavaScriptError] = React.useState<string | null>(null);
  const detectedUrl = window.location.origin;

  const reload = React.useCallback(async () => {
    try {
      const [next, nextJavaScript] = await Promise.all([
        api.get<InstanceSettings>("/api/admin/instance-settings"),
        api.get<CustomJavaScriptSettings>("/api/admin/custom-javascript"),
      ]);
      setData(next);
      setPublicUrl(next.publicUrl);
      setJavaScriptData(nextJavaScript);
      setCustomJavaScript(nextJavaScript.customJavaScript);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the instance settings"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data || !javascriptData) {
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
  const javascriptDirty = customJavaScript !== javascriptData.customJavaScript;
  const differsFromBrowser = data.publicUrl !== detectedUrl;
  /** Confirmed and matching this browser: nothing to review. */
  const settled = data.configured && !differsFromBrowser;

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

  const saveJavaScript = async () => {
    setJavaScriptError(null);
    setSavingJavaScript(true);
    try {
      const next = await api.put<CustomJavaScriptSettings>("/api/admin/custom-javascript", {
        customJavaScript,
      });
      setJavaScriptData(next);
      setCustomJavaScript(next.customJavaScript);
    } catch (err) {
      setJavaScriptError(errorMessage(err));
    } finally {
      setSavingJavaScript(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <TopBar
        title="General"
        right={
          <Button
            variant="secondary"
            onClick={refresh}
            loading={refreshing}
            disabled={saving || savingJavaScript}
          >
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FormError message={loadError} />

        {/* One card per setting: its status lives in the card it describes,
            not in a second card above it. */}
        <Card>
          <CardHeader>
            <div className="flex items-start gap-2">
              <Globe2 size={16} className="mt-0.5 shrink-0 text-indigo-500" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">Public URL</h2>
                  {settled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                      <CheckCircle2 size={11} aria-hidden="true" /> Configured
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  The exact origin Members use to open this Genosyn installation. Links in emails,
                  sign-in with other services, and passkeys all use it.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {!settled && (
              <div
                role="status"
                className="mb-3 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 text-xs leading-5">
                  <p className="font-semibold">
                    {!data.configured
                      ? "Public URL has not been confirmed"
                      : "Public URL differs from this browser"}
                  </p>
                  <p>
                    This browser reached Genosyn at {detectedUrl}. Review and save the value below.
                  </p>
                </div>
              </div>
            )}
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
                <Button type="submit" loading={saving} disabled={!dirty}>
                  <Save size={14} /> {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        {/* Rare and risky — code that runs in every Member's browser — so it
            waits under Advanced, whose line always says whether any is set. */}
        <Disclosure
          variant="card"
          heading="h2"
          title="Advanced"
          summary={describeCustomJavaScript(javascriptData.customJavaScript, customJavaScript)}
          keepMounted
        >
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Code2 size={16} className="text-indigo-500" />
              <div>
                <h3 className="text-sm font-semibold">Custom JavaScript</h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Add analytics, tag managers, or other trusted browser scripts to this instance.
                </p>
              </div>
            </div>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (javascriptDirty) void saveJavaScript();
              }}
            >
              <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p className="text-xs leading-5">
                  This code runs with the same access as every signed-in Member. Only paste code you
                  trust, and never put secrets here. Authentication and credential-bearing page
                  loads do not start custom code.
                </p>
              </div>
              <Textarea
                label="Custom JavaScript"
                value={customJavaScript}
                onChange={(event) => setCustomJavaScript(event.target.value)}
                maxLength={100_000}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={
                  '<script async src="https://example.com/analytics.js"></script>\n<script>\n  // Configure the script here\n</script>'
                }
                className="min-h-[280px] font-mono text-xs leading-5"
                hint={
                  <>
                    Paste raw JavaScript or complete <code>&lt;script&gt;</code> snippets. External
                    script tags must use HTTPS and <code>async</code>. Changes run on the next page
                    load. Clear the field and save to disable them.
                  </>
                }
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                If a script disrupts the page, reload with <code>?safe=1</code>, return here, and
                clear it.
              </p>
              <FormError message={javascriptError} />
              <div className="flex justify-end">
                <Button type="submit" loading={savingJavaScript} disabled={!javascriptDirty}>
                  <Save size={14} /> {savingJavaScript ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </div>
        </Disclosure>
      </div>
    </>
  );
}
