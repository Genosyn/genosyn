import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import {
  MailAccessLevel,
  MailConnectCandidate,
  MailGrant,
  MailGrantCandidate,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailOutletCtx } from "./MailLayout";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

/**
 * Email settings: the mailbox account (sync status, pause/resume,
 * disconnect), a way to connect additional mailboxes, and the AI-access
 * panel — which employees can act on this inbox and at what level.
 */

const LEVEL_HINT: Record<MailAccessLevel, string> = {
  read: "Browse threads and labels",
  draft: "Also write drafts, label, archive, mark read",
  send: "Also send mail on this account's behalf",
};

export default function MailSettings() {
  const { company, account, accounts, refresh } =
    useOutletContext<MailOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();

  const [grants, setGrants] = React.useState<MailGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<MailGrantCandidate[]>([]);
  const [addOpen, setAddOpen] = React.useState(false);
  const [connectOpen, setConnectOpen] = React.useState(false);

  const loadGrants = React.useCallback(async () => {
    const [g, cand] = await Promise.all([
      mailApi.grants(company.id, account.id),
      mailApi.grantCandidates(company.id, account.id),
    ]);
    setGrants(g.direct);
    setCandidates(cand.candidates);
  }, [company.id, account.id]);

  React.useEffect(() => {
    setGrants(null);
    loadGrants().catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadGrants]);

  const togglePause = async () => {
    try {
      await mailApi.patchAccount(
        company.id,
        account.id,
        account.status === "paused" ? "active" : "paused",
      );
      await refresh();
      toast(account.status === "paused" ? "Sync resumed" : "Sync paused", "info");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const disconnect = async () => {
    const ok = await dialog.confirm({
      title: `Disconnect ${account.address}?`,
      message: "Removes the local mirror (threads, rules, handovers, AI grants) here. Your Gmail account and the Google connection are untouched.",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await mailApi.deleteAccount(company.id, account.id);
      toast("Mailbox disconnected", "info");
      await refresh();
      navigate(`/c/${company.slug}/mail`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const setLevel = async (grant: MailGrant, level: MailAccessLevel) => {
    try {
      await mailApi.patchGrant(company.id, account.id, grant.id, level);
      await loadGrants();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const revoke = async (grant: MailGrant) => {
    try {
      await mailApi.deleteGrant(company.id, account.id, grant.id);
      await loadGrants();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-5 text-lg font-semibold text-slate-900 dark:text-slate-100">
        Email settings
      </h1>

      {/* Account card */}
      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Mail size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-900 dark:text-slate-100">
              {account.address}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs">
              {account.status === "error" ? (
                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                  <AlertTriangle size={12} /> {account.statusMessage || "Sync error"}
                </span>
              ) : account.status === "paused" ? (
                <span className="text-slate-500">Sync paused</span>
              ) : (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={12} />{" "}
                  {account.backfilledAt
                    ? `Synced ${shortMailDate(account.lastSyncAt)}`
                    : "First sync in progress…"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await mailApi.syncNow(company.id, account.id);
                toast("Sync started", "info");
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }}
          >
            <RefreshCw size={14} className="mr-1.5" /> Sync now
          </Button>
          <Button size="sm" variant="secondary" onClick={togglePause}>
            {account.status === "paused" ? (
              <>
                <Play size={14} className="mr-1.5" /> Resume sync
              </>
            ) : (
              <>
                <Pause size={14} className="mr-1.5" /> Pause sync
              </>
            )}
          </Button>
          <Button size="sm" variant="danger" onClick={disconnect}>
            <Trash2 size={14} className="mr-1.5" /> Disconnect
          </Button>
        </div>
      </section>

      {/* AI access */}
      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-1 flex items-center gap-2">
          <Users size={16} className="text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            AI access
          </h2>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={14} className="mr-1" /> Grant access
          </Button>
        </div>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          Which AI employees can act on this mailbox through their tools and
          via rules. Members always have full access; this only governs AI.
        </p>

        {grants === null ? (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        ) : grants.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700">
            No AI employees have access yet. Grant one so it can triage,
            draft, or reply.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2.5">
                <Avatar
                  name={g.employee?.name ?? "?"}
                  src={employeeAvatarUrl(company.id, g.employee?.id ?? "", g.employee?.avatarKey)}
                  kind="ai"
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-900 dark:text-slate-100">
                    {g.employee?.name ?? "Unknown employee"}
                  </div>
                  <div className="truncate text-xs text-slate-400">
                    {LEVEL_HINT[g.accessLevel]}
                  </div>
                </div>
                <Select
                  value={g.accessLevel}
                  onChange={(e) => setLevel(g, e.target.value as MailAccessLevel)}
                  className="w-28"
                >
                  <option value="read">Read</option>
                  <option value="draft">Draft</option>
                  <option value="send">Send</option>
                </Select>
                <button
                  onClick={() => revoke(g)}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                  title="Revoke"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Other mailboxes / connect */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Connected mailboxes
          </h2>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setConnectOpen(true)}
          >
            <Plus size={14} className="mr-1" /> Connect another
          </Button>
        </div>
        <ul className="space-y-1.5">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm dark:border-slate-800"
            >
              <Mail size={14} className="text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
                {a.address}
              </span>
              <span className="text-xs capitalize text-slate-400">{a.status}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Need to add a Gmail account not listed? Add a Google connection with
          the Gmail scope under{" "}
          <Link
            to={`/c/${company.slug}/settings/integrations`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Settings → Integrations
          </Link>
          .
        </p>
      </section>

      {addOpen && (
        <GrantModal
          companyId={company.id}
          accountId={account.id}
          candidates={candidates}
          onClose={() => setAddOpen(false)}
          onGranted={async () => {
            setAddOpen(false);
            await loadGrants();
          }}
        />
      )}
      {connectOpen && (
        <ConnectModal
          companyId={company.id}
          onClose={() => setConnectOpen(false)}
          onConnected={async () => {
            setConnectOpen(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function GrantModal({
  companyId,
  accountId,
  candidates,
  onClose,
  onGranted,
}: {
  companyId: string;
  accountId: string;
  candidates: MailGrantCandidate[];
  onClose: () => void;
  onGranted: () => Promise<void>;
}) {
  const { toast } = useToast();
  const available = candidates.filter((c) => !c.alreadyGranted);
  const [employeeId, setEmployeeId] = React.useState(available[0]?.id ?? "");
  const [level, setLevel] = React.useState<MailAccessLevel>("draft");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await mailApi.createGrant(companyId, accountId, {
        employeeId,
        accessLevel: level,
      });
      toast("Access granted", "success");
      await onGranted();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Grant mailbox access">
      {available.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every AI employee already has access to this mailbox.
        </p>
      ) : (
        <div className="space-y-3">
          <Select
            label="Employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Access level"
            value={level}
            onChange={(e) => setLevel(e.target.value as MailAccessLevel)}
          >
            <option value="read">Read — browse only</option>
            <option value="draft">Draft — triage + write drafts</option>
            <option value="send">Send — can send mail</option>
          </Select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {LEVEL_HINT[level]}.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || !employeeId}>
              {busy ? <Spinner size={14} /> : "Grant"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConnectModal({
  companyId,
  onClose,
  onConnected,
}: {
  companyId: string;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [candidates, setCandidates] = React.useState<MailConnectCandidate[] | null>(
    null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    mailApi
      .connectCandidates(companyId)
      .then((res) => setCandidates(res.candidates))
      .catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const usable = (candidates ?? []).filter(
    (c) => c.hasGmailScope && !c.linkedAccountId,
  );

  return (
    <Modal open onClose={onClose} title="Connect a mailbox">
      {candidates === null ? (
        <div className="flex justify-center py-6">
          <Spinner size={18} />
        </div>
      ) : usable.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No unlinked Gmail-capable Google connections. Add one with the Gmail
          scope under Settings → Integrations first.
        </p>
      ) : (
        <div className="space-y-2">
          {usable.map((c) => (
            <div
              key={c.connectionId}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
            >
              <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-300">
                {c.accountHint || c.label}
              </span>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(c.connectionId);
                  try {
                    await mailApi.connectAccount(companyId, c.connectionId);
                    toast("Mailbox connected", "success");
                    await onConnected();
                  } catch (err) {
                    toast((err as Error).message, "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === c.connectionId ? <Spinner size={13} /> : "Connect"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
