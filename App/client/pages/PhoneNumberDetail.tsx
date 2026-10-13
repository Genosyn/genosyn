import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { api, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { phoneApi, type PhoneNumberDetailRow, type PhoneNumberRow } from "../lib/phone";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Checkbox } from "../components/ui/Checkbox";
import { FormError } from "../components/ui/FormError";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { PhoneActivity } from "../components/phone/PhoneActivity";
import { PhoneNumberSettingsForm } from "../components/phone/PhoneNumberSettingsForm";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * One phone number: its texts and calls, and its settings. Reached from
 * Settings → Phone numbers and from an AI Employee's Phone pane.
 */
export function PhoneNumberDetail() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const { numberId = "" } = useParams();
  const navigate = useNavigate();
  const [number, setNumber] = React.useState<PhoneNumberDetailRow | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [syncError, setSyncError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setNumber(await phoneApi.number(company.id, numberId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the phone number"));
    }
  }, [company.id, numberId]);

  React.useEffect(() => {
    void reload();
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [company.id, reload]);
  useLiveRefetch("phone", reload, numberId);

  const applySaved = (saved: PhoneNumberRow) =>
    setNumber((current) => (current ? { ...current, ...saved } : current));

  if (!number) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink slug={company.slug} />
        {loadError ? <FormError message={loadError} /> : <Spinner />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink slug={company.slug} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {number.display}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {[
                number.label,
                number.employee ? `${number.employee.name}'s number` : "Not given to anyone yet",
                number.connection ? `Twilio · ${number.connection.label}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Today: {number.usage.textsToday} of {number.dailyTextLimit} AI texts ·{" "}
              {number.usage.callsToday} of {number.dailyCallLimit} AI calls
            </p>
          </div>
          <Button variant="ghost" onClick={() => setRemoving(true)}>
            <Trash2 size={14} /> Remove
          </Button>
        </div>
      </div>

      {number.connection && number.connection.status !== "connected" && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="min-w-0 text-amber-900 dark:text-amber-100">
            <span className="font-medium">Twilio refused this account&apos;s credentials.</span>{" "}
            Texts are not being fetched and nothing can be sent until the Twilio connection is
            reconnected at{" "}
            <Link
              to={`/c/${company.slug}/settings/integrations`}
              className="font-medium underline hover:no-underline"
            >
              Settings → Integrations
            </Link>
            .
          </p>
        </div>
      )}

      {(number.webhooks.state === "error" || number.webhooks.state === "outdated") && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1 text-amber-900 dark:text-amber-100">
            <p className="font-medium">
              {number.webhooks.state === "error"
                ? "Twilio could not be pointed at Genosyn"
                : "Twilio still sends this number's calls to an older address"}
            </p>
            {number.webhooks.error && (
              <p className="mt-0.5 text-amber-800 dark:text-amber-200">{number.webhooks.error}</p>
            )}
            <FormError message={syncError} className="mt-2" />
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncError(null);
              try {
                applySaved(await phoneApi.syncWebhooks(company.id, number.id));
              } catch (err) {
                setSyncError(errorMessage(err, "Could not update the webhooks"));
              } finally {
                setSyncing(false);
              }
            }}
          >
            {!syncing && <RefreshCw size={13} />} Try again
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Activity</h2>
        </CardHeader>
        <CardBody>
          <PhoneActivity companyId={company.id} number={number} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
        </CardHeader>
        <CardBody>
          <PhoneNumberSettingsForm
            companyId={company.id}
            number={number}
            employees={employees}
            onSaved={applySaved}
          />
        </CardBody>
      </Card>

      <RemoveNumberModal
        open={removing}
        companyId={company.id}
        number={number}
        onClose={() => setRemoving(false)}
        onRemoved={() => navigate(`/c/${company.slug}/settings/phone-numbers`)}
      />
    </div>
  );
}

function BackLink({ slug }: { slug: string }) {
  return (
    <Link
      to={`/c/${slug}/settings/phone-numbers`}
      className="inline-flex items-center gap-1 self-start text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
    >
      <ArrowLeft size={14} /> Phone numbers
    </Link>
  );
}

function RemoveNumberModal({
  open,
  companyId,
  number,
  onClose,
  onRemoved,
}: {
  open: boolean;
  companyId: string;
  number: PhoneNumberRow;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [release, setRelease] = React.useState(number.reservedInGenosyn);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setRelease(number.reservedInGenosyn);
      setError(null);
    }
  }, [open, number.reservedInGenosyn]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Remove ${number.display}?`}
      description="The number leaves Genosyn, with its texts and call history here."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await phoneApi.remove(companyId, number.id, release);
                onRemoved();
              } catch (err) {
                setError(errorMessage(err, "Could not remove the number"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {release ? "Release and remove" : "Remove"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-300">
        <FormError message={error} />
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={release}
            onChange={(e) => setRelease(e.target.checked)}
            label="Also release it from Twilio"
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-slate-900 dark:text-slate-100">
              Also release it from Twilio
            </span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Twilio stops billing for it, and it cannot be got back. Leave this off to keep the
              number in your Twilio account.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
