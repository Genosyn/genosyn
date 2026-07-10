import React from "react";
import { CheckCircle2, Lock, RefreshCw, Unlock } from "lucide-react";
import { api, SignupSettings } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Sign-ups. Instance-wide toggle for self-service registration. When an
 * operator turns sign-ups off, the public signup form is refused for everyone
 * except the first-user bootstrap on a fresh install. Existing members keep
 * their accounts; this only stops new self-service registrations. Persisted
 * server-side as a single `AppSetting` row (see services/signupSettings.ts).
 */

export function AdminSignups() {
  const [data, setData] = React.useState<SignupSettings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      setData(await api.get<SignupSettings>("/api/admin/signup-settings"));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return (
      <>
        <TopBar title="Sign-ups" />
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      </>
    );
  }

  const disabled = data.signupsDisabled;

  const setDisabled = async (next: boolean) => {
    setSaving(true);
    try {
      const saved = await api.put<SignupSettings>("/api/admin/signup-settings", {
        signupsDisabled: next,
      });
      setData(saved);
      toast(
        saved.signupsDisabled ? "Sign-ups disabled" : "Sign-ups enabled",
        "success",
      );
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TopBar
        title="Sign-ups"
        right={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <StatusBanner disabled={disabled} />

        <Card>
          <CardBody className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Disable sign-ups
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Turn off self-service registration for this instance. The public
                sign-up form stops accepting new accounts — existing members are
                unaffected, and the first account on a fresh install can always
                be created so the instance is never left without an operator.
              </p>
            </div>
            <Toggle
              checked={disabled}
              disabled={saving}
              onChange={(v) => setDisabled(v)}
              label="Disable sign-ups"
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function StatusBanner({ disabled }: { disabled: boolean }) {
  const Icon = disabled ? Lock : CheckCircle2;
  return (
    <Card
      className={clsx(
        "border",
        disabled
          ? "border-amber-200 dark:border-amber-500/30"
          : "border-emerald-200 dark:border-emerald-500/30",
      )}
    >
      <CardBody className="flex items-center gap-3">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            disabled
              ? "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
              : "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {disabled ? "Sign-ups are disabled" : "Sign-ups are open"}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {disabled
              ? "New people can't register themselves. Add members by promoting existing accounts or inviting them from a company's Settings → Members."
              : "Anyone who reaches this instance can create an account from the sign-up page."}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** A minimal accessible on/off switch. Green when on (here: sign-ups disabled). */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-slate-900",
        checked ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-600",
      )}
    >
      <span
        className={clsx(
          "inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      >
        {checked ? (
          <Lock size={11} className="text-indigo-600" />
        ) : (
          <Unlock size={11} className="text-slate-400" />
        )}
      </span>
    </button>
  );
}
