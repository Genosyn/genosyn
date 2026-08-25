import React from "react";
import { Bot, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage } from "@/lib/errors";
import {
  vaultApi,
  type VaultEmployeeAccessLevel,
  type VaultEmployeeCandidate,
  type VaultEmployeeGrant,
  type VaultItem,
  type VaultMemberAccess,
  type VaultMemberAccessLevel,
  type VaultMemberCandidate,
} from "@/lib/vault";

export function VaultAccessPanel({ companyId, item }: { companyId: string; item: VaultItem }) {
  const dialog = useDialog();
  const [memberAccess, setMemberAccess] = React.useState<VaultMemberAccess[] | null>(null);
  const [memberCandidates, setMemberCandidates] = React.useState<VaultMemberCandidate[]>([]);
  const [employeeGrants, setEmployeeGrants] = React.useState<VaultEmployeeGrant[] | null>(null);
  const [employeeCandidates, setEmployeeCandidates] = React.useState<VaultEmployeeCandidate[]>([]);
  const [memberPick, setMemberPick] = React.useState("");
  const [memberLevel, setMemberLevel] = React.useState<VaultMemberAccessLevel>("view");
  const [employeePick, setEmployeePick] = React.useState("");
  const [employeeLevel, setEmployeeLevel] = React.useState<VaultEmployeeAccessLevel>("use");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [memberError, setMemberError] = React.useState<string | null>(null);
  const [employeeError, setEmployeeError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const [access, people, grants, employees] = await Promise.all([
        vaultApi.listMemberAccess(companyId, item.id),
        vaultApi.listMemberCandidates(companyId, item.id),
        vaultApi.listEmployeeGrants(companyId, item.id),
        vaultApi.listEmployeeCandidates(companyId, item.id),
      ]);
      setMemberAccess(access);
      setMemberCandidates(people);
      setEmployeeGrants(grants);
      setEmployeeCandidates(employees);
    } catch (cause) {
      setError(errorMessage(cause, "Vault access could not be loaded."));
      setMemberAccess([]);
      setEmployeeGrants([]);
    }
  }, [companyId, item.id]);

  React.useEffect(() => {
    setMemberAccess(null);
    setEmployeeGrants(null);
    setMemberPick("");
    setEmployeePick("");
    setMemberError(null);
    setEmployeeError(null);
    void reload();
  }, [reload]);

  const memberIds = new Set((memberAccess ?? []).map((row) => row.userId));
  const employeeIds = new Set((employeeGrants ?? []).map((row) => row.employeeId));
  const availableMembers = memberCandidates.filter(
    (candidate) => !candidate.isCreator && !memberIds.has(candidate.id) && !candidate.access,
  );
  const availableEmployees = employeeCandidates.filter(
    (candidate) => !employeeIds.has(candidate.id) && !candidate.grant,
  );

  async function addMember() {
    if (!memberPick || busy) return;
    setBusy("member:add");
    setMemberError(null);
    try {
      await vaultApi.createMemberAccess(companyId, item.id, memberPick, memberLevel);
      setMemberPick("");
      setMemberLevel("view");
      await reload();
    } catch (cause) {
      setMemberError(errorMessage(cause, "Member access could not be added."));
    } finally {
      setBusy(null);
    }
  }

  async function changeMember(row: VaultMemberAccess, accessLevel: VaultMemberAccessLevel) {
    if (row.accessLevel === accessLevel || busy) return;
    setBusy(`member:${row.id}`);
    try {
      await vaultApi.updateMemberAccess(companyId, item.id, row.id, accessLevel);
      await reload();
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t update the Member’s access" });
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(row: VaultMemberAccess) {
    if (busy) return;
    setBusy(`member:${row.id}`);
    try {
      await vaultApi.deleteMemberAccess(companyId, item.id, row.id);
      await reload();
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t remove the Member’s access" });
    } finally {
      setBusy(null);
    }
  }

  async function addEmployee() {
    if (!employeePick || busy) return;
    setBusy("employee:add");
    setEmployeeError(null);
    try {
      await vaultApi.createEmployeeGrant(companyId, item.id, employeePick, employeeLevel);
      setEmployeePick("");
      setEmployeeLevel("use");
      await reload();
    } catch (cause) {
      setEmployeeError(errorMessage(cause, "The Grant could not be added."));
    } finally {
      setBusy(null);
    }
  }

  async function changeEmployee(row: VaultEmployeeGrant, accessLevel: VaultEmployeeAccessLevel) {
    if (row.accessLevel === accessLevel || busy) return;
    setBusy(`employee:${row.id}`);
    try {
      await vaultApi.updateEmployeeGrant(companyId, item.id, row.id, accessLevel);
      await reload();
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t update the Grant" });
    } finally {
      setBusy(null);
    }
  }

  async function removeEmployee(row: VaultEmployeeGrant) {
    if (busy) return;
    setBusy(`employee:${row.id}`);
    try {
      await vaultApi.deleteEmployeeGrant(companyId, item.id, row.id);
      await reload();
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t remove the Grant" });
    } finally {
      setBusy(null);
    }
  }

  if (memberAccess === null || employeeGrants === null) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 text-center dark:border-slate-700">
        <p className="max-w-md px-4 text-sm text-slate-500 dark:text-slate-400">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          <RefreshCw size={13} /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/40">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-indigo-500" />
          <div>
            <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
              {item.visibility === "company"
                ? "Every Member can view this item"
                : "Only selected Members can view this item"}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
              View access includes reveal and copy. Edit also changes fields and rotates the stored
              value. Only the creator and company owners or admins can change access or delete it.
            </p>
          </div>
        </div>
      </div>

      <AccessSection
        icon={<Users size={16} />}
        title="Member access"
        description={
          item.visibility === "company"
            ? "Everyone already has View access. Add a Member here only when they should be able to edit."
            : "Choose the Members who may open this item, then decide who may edit it."
        }
      >
        {memberAccess.length === 0 ? (
          <EmptyAccessRow
            icon={<UserRound size={17} />}
            text={
              item.visibility === "company"
                ? "No Members have extra Edit access."
                : "No Members have been added yet."
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {memberAccess.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={row.member.name} size="sm" kind="human" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {row.member.name}
                    </div>
                    {row.member.email && (
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {row.member.email}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={row.accessLevel}
                    disabled={!item.canShare || busy !== null}
                    onChange={(event) =>
                      void changeMember(row, event.target.value as VaultMemberAccessLevel)
                    }
                    className="h-8 w-28 text-xs"
                    aria-label={`Access for ${row.member.name}`}
                  >
                    <option value="view">View</option>
                    <option value="edit">Edit</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!item.canShare || busy !== null}
                    onClick={() => void removeMember(row)}
                    aria-label={`Remove ${row.member.name}'s access`}
                    title="Remove access"
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {item.canShare && (
          <div className="border-t border-slate-100 p-4 dark:border-slate-800">
            <FormError message={memberError} className="mb-3" />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Select
                label="Add a Member"
                value={memberPick}
                disabled={busy !== null || availableMembers.length === 0}
                onChange={(event) => setMemberPick(event.target.value)}
                containerClassName="min-w-0 flex-1"
              >
                <option value="">
                  {availableMembers.length ? "Choose a Member…" : "No more Members to add"}
                </option>
                {availableMembers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.email ? ` — ${candidate.email}` : ""}
                  </option>
                ))}
              </Select>
              <Select
                label="Access"
                value={memberLevel}
                disabled={busy !== null || availableMembers.length === 0}
                onChange={(event) => setMemberLevel(event.target.value as VaultMemberAccessLevel)}
                containerClassName="w-full sm:w-28"
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </Select>
              <Button
                size="sm"
                disabled={busy !== null || !memberPick}
                onClick={() => void addMember()}
              >
                <Plus size={13} /> Add
              </Button>
            </div>
          </div>
        )}
      </AccessSection>

      <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3 dark:border-indigo-900 dark:bg-indigo-950/30">
        <div className="flex items-start gap-2.5">
          <Bot size={16} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
          <div>
            <div className="text-sm font-medium text-indigo-900 dark:text-indigo-100">
              AI-native access without plaintext in the model
            </div>
            <p className="mt-0.5 text-xs leading-5 text-indigo-800/75 dark:text-indigo-200/75">
              <strong>Use</strong> exposes safe metadata. For Login items, it lets an AI Employee
              fill the saved username, password, or current authenticator code server-side, and use
              a saved software passkey in Genosyn&apos;s browser. Passwords and codes go only to
              their matching sign-in fields; passkey private keys never leave the server-side
              browser boundary. API-key and secure-note values have no AI plaintext or Browser-fill
              path. <strong>Manage</strong> can also update a Login&apos;s title, username, and
              private context while preserving its saved website origin. It never lets AI reveal,
              rebind, rotate, or delete credential material. A Login an AI Employee creates grants
              it Manage automatically, which also lets it capture authenticators during that signup
              flow.
            </p>
          </div>
        </div>
      </div>

      <AccessSection
        icon={<Bot size={16} />}
        title="AI Employee Grants"
        description="Company visibility never grants AI access. Add each AI Employee explicitly and start with Use."
      >
        {employeeGrants.length === 0 ? (
          <EmptyAccessRow icon={<Bot size={17} />} text="No AI Employees can use this item." />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {employeeGrants.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={row.employee.name} size="sm" kind="ai" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {row.employee.role}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={row.accessLevel}
                    disabled={!item.canShare || busy !== null}
                    onChange={(event) =>
                      void changeEmployee(row, event.target.value as VaultEmployeeAccessLevel)
                    }
                    className="h-8 w-28 text-xs"
                    aria-label={`Grant for ${row.employee.name}`}
                  >
                    <option value="use">Use</option>
                    <option value="manage">Manage</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!item.canShare || busy !== null}
                    onClick={() => void removeEmployee(row)}
                    aria-label={`Remove ${row.employee.name}'s Grant`}
                    title="Remove Grant"
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {item.canShare && (
          <div className="border-t border-slate-100 p-4 dark:border-slate-800">
            <FormError message={employeeError} className="mb-3" />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Select
                label="Grant to an AI Employee"
                value={employeePick}
                disabled={busy !== null || availableEmployees.length === 0}
                onChange={(event) => setEmployeePick(event.target.value)}
                containerClassName="min-w-0 flex-1"
              >
                <option value="">
                  {availableEmployees.length
                    ? "Choose an AI Employee…"
                    : "No more AI Employees to add"}
                </option>
                {availableEmployees.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} — {candidate.role}
                  </option>
                ))}
              </Select>
              <Select
                label="Grant"
                value={employeeLevel}
                disabled={busy !== null || availableEmployees.length === 0}
                onChange={(event) =>
                  setEmployeeLevel(event.target.value as VaultEmployeeAccessLevel)
                }
                containerClassName="w-full sm:w-28"
              >
                <option value="use">Use</option>
                <option value="manage">Manage</option>
              </Select>
              <Button
                size="sm"
                disabled={busy !== null || !employeePick}
                onClick={() => void addEmployee()}
              >
                <Plus size={13} /> Add
              </Button>
            </div>
          </div>
        )}
      </AccessSection>
    </div>
  );
}

function AccessSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <span className="text-slate-500 dark:text-slate-400">{icon}</span>
          {title}
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyAccessRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-400 dark:text-slate-500">
      {icon}
      {text}
    </div>
  );
}
