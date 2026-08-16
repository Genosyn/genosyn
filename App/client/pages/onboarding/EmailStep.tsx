import React from "react";
import { ArrowRight, CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import { api, Company, Employee, IntegrationCatalogEntry } from "../../lib/api";
import { MailAccount, MailConnectCandidate, MailGrant, mailApi } from "../../lib/mail";
import { Button } from "../../components/ui/Button";
import { FormError } from "../../components/ui/FormError";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { OauthOrServiceAccountModal } from "../SettingsIntegrations";
import { Note, SkipLink, StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

/**
 * Optional Gmail access, at the deliberately safe `draft` level.
 *
 * The step is labelled "Gmail" rather than "Email" because the catalog lookup
 * is hard-filtered to `provider === "google"`. Calling it "Email" sent members
 * on other providers hunting for a misconfiguration that did not exist.
 */
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
      api.get<IntegrationCatalogEntry[]>(`/api/companies/${company.id}/integrations/catalog`),
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
      // The popup is same-origin; anything else is not ours to trust.
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
      toast(`Draft access granted to ${employee.name}`, "success");
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
    <StepCard>
      <StepHeading
        icon={Mail}
        title="Connect Gmail"
        description={
          <>
            Optional, and only Gmail for now — other mailboxes connect later from Email →
            Integrations. Linking one lets {employee.name} read the inbox and prepare replies inside
            Genosyn.
          </>
        }
      />

      <Note kind="info" icon={ShieldCheck} className="mt-4" title="They get draft access, not send">
        Mailbox access has three levels. <strong className="font-semibold">Read</strong> browses
        threads. <strong className="font-semibold">Draft</strong> — what this step grants — also
        writes replies, applies labels, archives, and marks read, so {employee.name} can clear an
        inbox and leave a finished reply in the thread while a human presses Send.{" "}
        <strong className="font-semibold">Send</strong> is never granted here. Change the level any
        time at Email → Settings → AI access.
      </Note>

      <div className="my-5 border-t border-slate-100 dark:border-slate-800" />
      <FormError message={error} />

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner size={22} />
        </div>
      ) : emailReady ? (
        // The Grant may pre-date this step at any level, so report the level
        // that is actually on it — claiming "sending stays with you" about a
        // `send` Grant misstates a safety property.
        <Note kind="success" icon={CheckCircle2} title={`${account.address} is ready`}>
          {grant.accessLevel === "read"
            ? `${employee.name} has read access — they can browse and search threads, but not write replies.`
            : grant.accessLevel === "send"
              ? `${employee.name} already has send access to this mailbox and can send without asking. Change it at Email → Settings → AI access.`
              : `${employee.name} has draft access to this mailbox. Sending stays with you.`}
        </Note>
      ) : account ? (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Mailbox connected: {account.address}
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            One step left — give {employee.name} draft access to it.
          </p>
          <Button className="mt-4" onClick={grantMailbox} disabled={busy}>
            {busy ? "Granting…" : "Grant draft access"}
          </Button>
        </div>
      ) : candidate ? (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Google is already connected
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Link {candidate.accountHint || candidate.label} as a mailbox and grant {employee.name}{" "}
            draft access in one step.
          </p>
          <Button className="mt-4" onClick={connectMailbox} disabled={busy}>
            {busy ? "Connecting…" : "Connect mailbox"}
          </Button>
        </div>
      ) : catalogEntry?.enabled ? (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Connect Google Workspace
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            You will pick or create an OAuth client, then approve Gmail access in Google. That
            creates a <strong className="font-semibold">Connection</strong> — one authenticated
            account your company owns — whose credentials Genosyn stores encrypted.
          </p>
          <Button className="mt-4" onClick={() => setOauthOpen(true)}>
            Connect Gmail
          </Button>
        </div>
      ) : (
        <Note kind="warn" title="Gmail needs operator setup on this instance">
          {catalogEntry?.disabledReason ??
            "Google Workspace is not enabled on this Genosyn instance."}{" "}
          Skip this step — nothing else depends on it — and connect a mailbox later from Email →
          Integrations.
        </Note>
      )}

      <StepFooter
        onBack={onBack}
        secondary={
          !emailReady ? <SkipLink onClick={onContinue}>Skip email for now</SkipLink> : undefined
        }
      >
        <Button className="w-full sm:w-auto" onClick={onContinue}>
          {emailReady ? "Finish setup" : "Continue"} <ArrowRight size={15} />
        </Button>
      </StepFooter>

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
    </StepCard>
  );
}
