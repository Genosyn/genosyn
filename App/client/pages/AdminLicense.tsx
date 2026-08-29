import React from "react";
import { BadgeCheck, ShieldOff } from "lucide-react";
import { api, AdminLicenseStatus } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → License (M56). A self-hosted install activates Genosyn Enterprise
 * here by pasting an offline-verifiable signed license key. Community edition
 * (the default) runs everything except SSO and the Audit log. Expiry is soft
 * for paid licenses — features stay on with a renewal warning — and hard for
 * evaluation licenses.
 */
export function AdminLicense() {
  const [status, setStatus] = React.useState<AdminLicenseStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [key, setKey] = React.useState("");
  const [activating, setActivating] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<AdminLicenseStatus>("/api/admin/license");
      setStatus(d);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the license"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!status) {
    return (
      <>
        <TopBar title="License" />
        <Card>
          <CardBody>{loadError ? <FormError message={loadError} /> : <Spinner />}</CardBody>
        </Card>
      </>
    );
  }

  const licensed = status.status === "valid" || status.status === "expired";

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || activating) return;
    setActivating(true);
    setError(null);
    try {
      const next = await api.put<AdminLicenseStatus>("/api/admin/license", {
        key: key.trim(),
      });
      setStatus(next);
      setKey("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setActivating(false);
    }
  }

  async function removeLicense() {
    const ok = await dialog.confirm({
      title: "Remove the license?",
      message:
        "This install returns to Community edition: SSO and the Audit log turn off until a license is activated again. Nothing is deleted — audit history keeps accruing.",
      confirmLabel: "Remove license",
      variant: "danger",
    });
    if (!ok) return;
    setRemoving(true);
    setError(null);
    try {
      await api.del("/api/admin/license");
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t remove the license" });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <TopBar title="License" />
      <div className="flex flex-col gap-4">
        <Card
          className={clsx(
            "border",
            licensed
              ? status.status === "expired"
                ? "border-amber-200 dark:border-amber-500/30"
                : "border-emerald-200 dark:border-emerald-500/30"
              : "border-slate-200 dark:border-slate-700",
          )}
        >
          <CardBody className="flex items-start gap-3">
            <span
              className={clsx(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                licensed
                  ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              {licensed ? <BadgeCheck size={20} /> : <ShieldOff size={20} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {licensed ? "Genosyn Enterprise" : "Community edition"}
                </span>
                {licensed && status.evaluation && (
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                    Evaluation
                  </span>
                )}
              </div>
              {licensed ? (
                <div className="mt-1 flex flex-col gap-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {status.companyName && <div>Licensed to {status.companyName}</div>}
                  {status.expiresAt && (
                    <div>Expires {new Date(status.expiresAt).toLocaleDateString()}</div>
                  )}
                  <div>
                    {status.seats === null
                      ? "Unlimited AI Employees"
                      : `Licensed for ${status.seats} AI Employee${status.seats === 1 ? "" : "s"} · ${status.aiEmployeeCount} in use`}
                  </div>
                  {status.status === "expired" && (
                    <div className="mt-1 text-amber-700 dark:text-amber-400">
                      {status.evaluation
                        ? "This evaluation license has expired — enterprise features are disabled. Contact enterprise@genosyn.com for a full license."
                        : "This license has expired — features remain enabled; contact enterprise@genosyn.com to renew."}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  SSO and Audit log are disabled. Activate a Genosyn Enterprise
                  license to unlock them.
                </p>
              )}
            </div>
            {licensed && (
              <Button
                size="sm"
                variant="ghost"
                onClick={removeLicense}
                disabled={removing || activating}
              >
                {removing ? "Removing…" : "Remove license"}
              </Button>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Activate a license</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Paste the license key you received from Genosyn. Keys are verified
              offline — no call home. To get one, see{" "}
              <a
                href="https://genosyn.com/pricing"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                genosyn.com/pricing
              </a>
              .
            </p>
          </CardHeader>
          <CardBody>
            <form className="flex flex-col gap-3" onSubmit={activate}>
              <Textarea
                label="License key"
                className="min-h-[96px] font-mono text-xs"
                placeholder="genlic1...."
                value={key}
                onChange={(event) => setKey(event.target.value)}
                spellCheck={false}
              />
              <FormError message={error} />
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={!key.trim() || activating}>
                  {activating ? "Activating…" : "Activate"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
