import React from "react";
import { useOutletContext } from "react-router-dom";
import { Pencil, Trash2, Users } from "lucide-react";
import { api, Team } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → Teams. Company owners group AI employees into Teams (Engineering,
 * Revenue, Ops, …) so the org chart, handoff defaults, and team-scoped
 * digests have something to read from. Membership itself is set on the
 * employee — this page is just CRUD over Team rows.
 */
export function SettingsTeams() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Team | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<Team[]>(
        `/api/companies/${company.id}/teams?includeArchived=true`,
      );
      setTeams(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setTeams([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(`/api/companies/${company.id}/teams`, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setName("");
      setDescription("");
      await reload();
      toast("Team created", "success");
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteTeam(team: Team) {
    const ok = await dialog.confirm({
      title: `Delete team "${team.name}"?`,
      message:
        team.memberCount > 0
          ? `${team.memberCount} employee${team.memberCount === 1 ? "" : "s"} will be detached from this team.`
          : "This will permanently remove the team.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/teams/${team.id}`);
      await reload();
      toast("Team deleted", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar title="Teams" />
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Create a team</h2>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={createTeam}>
            <FormError message={createError} />
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
              required
            />
            <Input
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ships product code and infra."
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={!name.trim() || creating}>
                {creating ? "Creating…" : "Create team"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <h2 className="text-sm font-semibold">All teams</h2>
        </CardHeader>
        <CardBody>
          {teams === null ? (
            <Spinner />
          ) : teams.length === 0 ? (
            <EmptyState
              title="No teams yet"
              description="Create a team to group employees by function."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {teams.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Users
                      size={16}
                      className="text-slate-400 dark:text-slate-500"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{t.name}</span>
                        {t.archivedAt && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            Archived
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {t.memberCount === 0
                          ? "No members"
                          : `${t.memberCount} member${t.memberCount === 1 ? "" : "s"}`}
                        {t.description ? ` · ${t.description}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(t)}
                    >
                      <Pencil size={12} /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteTeam(t)}
                    >
                      <Trash2 size={12} /> Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {editing && (
        <EditTeamModal
          companyId={company.id}
          team={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      )}
    </>
  );
}

function EditTeamModal({
  companyId,
  team,
  onClose,
}: {
  companyId: string;
  team: Team;
  onClose: (saved: boolean) => void;
}) {
  const [name, setName] = React.useState(team.name);
  const [description, setDescription] = React.useState(team.description);
  const [archived, setArchived] = React.useState(team.archivedAt !== null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/api/companies/${companyId}/teams/${team.id}`, {
        name: name.trim(),
        description,
        archived,
      });
      toast("Team updated", "success");
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={() => onClose(false)}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">Edit team</h3>
        <form className="mt-4 flex flex-col gap-3" onSubmit={save}>
          <FormError message={error} />
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Archived
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onClose(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
