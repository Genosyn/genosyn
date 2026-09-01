import React from "react";
import { ArrowRight, CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import { Company, Employee } from "../../lib/api";
import { MailAccount, MailGrant, mailApi } from "../../lib/mail";
import { ConnectMailboxForm } from "../../components/mail/ConnectMailbox";
import { Button } from "../../components/ui/Button";
import { FormError } from "../../components/ui/FormError";
import { Spinner } from "../../components/ui/Spinner";
import { Note, SkipLink, StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

/**
 * Optional mailbox access, at the deliberately safe `draft` level.
 *
 * The step used to be labelled "Gmail" because the connect path was hard-wired
 * to a Google Connection that had to exist first — which meant a member on
 * Fastmail or a company Exchange server reached this screen and had nothing to
 * press. It now asks for an email address like every other connect surface,
 * and works for any mailbox that speaks IMAP.
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
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [grants, setGrants] = React.useState<MailGrant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    const accountResult = await mailApi.accounts(company.id);
    const nextAccounts = accountResult.accounts;
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

  const account = accounts[0] ?? null;
  const grant = grants.find((item) => item.employeeId === employee.id) ?? null;
  const emailReady = account !== null && grant !== null;

  /**
   * Connecting a mailbox during onboarding always ends with a grant, because
   * a mailbox no employee can touch is not what the person came to this step
   * for. The grant is `draft`: enough to clear an inbox and leave a finished
   * reply, never enough to send.
   */
  async function grantMailbox(target: MailAccount) {
    await mailApi.createGrant(company.id, target.id, {
      employeeId: employee.id,
      accessLevel: "draft",
    });
  }

  async function grantExisting() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await grantMailbox(account);
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
        title="Connect email"
        description={
          <>
            Optional. Connect a mailbox — Gmail, Outlook, Fastmail, iCloud, or your own mail server
            — and {employee.name} can read the inbox and prepare replies inside Genosyn.
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
          <Button className="mt-4" onClick={grantExisting} disabled={busy}>
            {busy ? "Granting…" : "Grant draft access"}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <ConnectMailboxForm
            companyId={company.id}
            canConnect={company.role !== "member"}
            onConnected={async (connected) => {
              // The OAuth route reports back through a popup and hands us no
              // account, so re-read to find the mailbox it created before
              // granting on it.
              try {
                if (connected) await grantMailbox(connected);
                else {
                  const { accounts: fresh } = await mailApi.accounts(company.id);
                  if (fresh[0]) await grantMailbox(fresh[0]);
                }
              } catch (err) {
                setError((err as Error).message);
              }
              setLoading(true);
              await load()
                .catch((err) => setError((err as Error).message))
                .finally(() => setLoading(false));
            }}
          />
        </div>
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
    </StepCard>
  );
}
