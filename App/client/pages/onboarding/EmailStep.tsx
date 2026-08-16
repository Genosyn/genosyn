import React from "react";
import { ArrowRight, CheckCircle2, Mail } from "lucide-react";
import {
  api,
  Company,
  Employee,
  IntegrationCatalogEntry,
} from "../../lib/api";
import {
  MailAccount,
  MailConnectCandidate,
  MailGrant,
  mailApi,
} from "../../lib/mail";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { FormError } from "../../components/ui/FormError";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { OauthOrServiceAccountModal } from "../SettingsIntegrations";

export function EmailStep({
  company,
  employee,
  onBack,
  onContinue,
}: {
  company: Company;
  employee: Employee;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [catalogEntry, setCatalogEntry] = React.useState<IntegrationCatalogEntry | null>(null);
  const [candidates, setCandidates] = React.useState<MailConnectCandidate[]>([]);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [grants, setGrants] = React.useState<MailGrant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [oauthOpen, setOauthOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  const load = React.useCallback(async () => {
    setError(null);
    const [catalog, candidateResult, accountResult] = await Promise.all([
      api.get<IntegrationCatalogEntry[]>(
        `/api/companies/${company.id}/integrations/catalog`,
      ),
      mailApi.connectCandidates(company.id),
      mailApi.accounts(company.id),
    ]);
    const nextAccounts = accountResult.accounts;
    setCatalogEntry(catalog.find((entry) => entry.provider === "google") ?? null);
    setCandidates(candidateResult.candidates);
    if (nextAccounts.length > 0) {
      const accountGrants = await Promise.all(
        nextAccounts.map(async (account) => ({
          account,
          grants: (await mailApi.grants(company.id, account.id)).direct,
        })),
      );
      const preferred =
        accountGrants.find((item) =>
          item.grants.some((grant) => grant.employeeId === employee.id),
        ) ?? accountGrants[0];
      setAccounts([
        preferred.account,
        ...nextAccounts.filter((account) => account.id !== preferred.account.id),
      ]);
      setGrants(preferred.grants);
    } else {
      setAccounts([]);
      setGrants([]);
    }
  }, [company.id, employee.id]);

  React.useEffect(() => {
    setLoading(true);
    load()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [load]);

  React.useEffect(() => {
    function handleOauthMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; ok?: boolean; detail?: string } | null;
      if (!data || data.source !== "genosyn-oauth") return;
      if (data.ok) {
        toast("Google connected", "success");
        setOauthOpen(false);
        setLoading(true);
        load()
          .catch((err) => setError((err as Error).message))
          .finally(() => setLoading(false));
      } else {
        setError(data.detail ?? "Google could not be connected");
      }
    }
    window.addEventListener("message", handleOauthMessage);
    return () => window.removeEventListener("message", handleOauthMessage);
  }, [load, toast]);

  const account = accounts[0] ?? null;
  const grant = grants.find((item) => item.employeeId === employee.id) ?? null;
  const candidate = candidates.find(
    (item) => item.hasGmailScope && item.linkedAccountId === null,
  );
  const emailReady = account !== null && grant !== null;

  async function connectMailbox() {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mailApi.connectAccount(company.id, candidate.connectionId);
      await mailApi.createGrant(company.id, result.account.id, {
        employeeId: employee.id,
        accessLevel: "draft",
      });
      toast(`Email connected for ${employee.name}`, "success");
      await load();
    } catch (err) {
      setError((err as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function grantMailbox() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await mailApi.createGrant(company.id, account.id, {
        employeeId: employee.id,
        accessLevel: "draft",
      });
      toast(`Draft access granted to ${employee.name}`, "success");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardBody className="p-5 sm:p-7">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              <Mail size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Connect email
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                Add a Gmail mailbox and give {employee.name} draft access. They can read, triage,
                and prepare replies, but cannot send without you raising the Grant later.
              </p>
            </div>
          </div>

          <div className="my-6 border-t border-slate-100 dark:border-slate-800" />
          <FormError message={error} />

          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner size={22} />
            </div>
          ) : emailReady ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-900 dark:text-emerald-200">
                <CheckCircle2 size={16} />
                {account.address} is ready
              </div>
              <p className="mt-1 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
                {employee.name} has draft access. Sending remains under human control.
              </p>
            </div>
          ) : account ? (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Mailbox connected: {account.address}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Finish by giving {employee.name} safe draft access.
              </p>
              <Button className="mt-4" onClick={grantMailbox} disabled={busy}>
                {busy ? "Granting…" : "Grant draft access"}
              </Button>
            </div>
          ) : candidate ? (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Google is connected
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Connect {candidate.accountHint || candidate.label} as a mailbox and grant{" "}
                {employee.name} draft access in one step.
              </p>
              <Button className="mt-4" onClick={connectMailbox} disabled={busy}>
                {busy ? "Connecting…" : "Connect mailbox"}
              </Button>
            </div>
          ) : catalogEntry?.enabled ? (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Connect Google Workspace
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                You will create or choose an OAuth client, then approve Gmail access in Google.
                Genosyn stores each Connection&apos;s credentials encrypted.
              </p>
              <Button className="mt-4" onClick={() => setOauthOpen(true)}>
                Connect Gmail
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Gmail needs operator setup
              </div>
              <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-300">
                {catalogEntry?.disabledReason ??
                  "Google Workspace is not enabled on this Genosyn instance."}{" "}
                You can continue now and connect it later from Email → Integrations.
              </p>
            </div>
          )}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            {!emailReady && (
              <button
                type="button"
                onClick={onContinue}
                className="text-sm font-medium text-slate-500 hover:text-slate-800 sm:ml-auto dark:text-slate-400 dark:hover:text-slate-200"
              >
                Set up email later
              </button>
            )}
            {emailReady && (
              <Button className="sm:ml-auto" onClick={onContinue}>
                Continue to first request <ArrowRight size={15} />
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {catalogEntry && (
        <OauthOrServiceAccountModal
          open={oauthOpen}
          entry={catalogEntry}
          reconnect={null}
          companyId={company.id}
          initialScopeGroups={["mail"]}
          onClose={() => setOauthOpen(false)}
          onSaved={() => {
            setOauthOpen(false);
            setLoading(true);
            window.setTimeout(() => {
              load()
                .catch((err) => setError((err as Error).message))
                .finally(() => setLoading(false));
            }, 750);
          }}
        />
      )}
    </div>
  );
}
