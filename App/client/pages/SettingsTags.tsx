import React from "react";
import { Pencil, Tag, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { api, CompanyTag } from "../lib/api";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import type { SettingsOutletCtx } from "./SettingsLayout";

export function SettingsTags() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [tags, setTags] = React.useState<CompanyTag[] | null>(null);
  const [name, setName] = React.useState("");
  const [editing, setEditing] = React.useState<CompanyTag | null>(null);
  const [editName, setEditName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialog = useDialog();
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      setTags(await api.get<CompanyTag[]>(`/api/companies/${company.id}/tags`));
    } catch (err) {
      toast((err as Error).message, "error");
      setTags([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/tags`, { name: name.trim() });
      setName("");
      await reload();
      toast("Tag created", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function rename(tag: CompanyTag) {
    if (!editName.trim() || saving) return;
    setSaving(true);
    try {
      await api.patch(`/api/companies/${company.id}/tags/${tag.id}`, {
        name: editName.trim(),
      });
      setEditing(null);
      await reload();
      toast("Tag renamed", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(tag: CompanyTag) {
    const count = tag.usageCount ?? 0;
    const ok = await dialog.confirm({
      title: `Delete tag "${tag.name}"?`,
      message:
        count > 0
          ? `This removes it from ${count} resource${count === 1 ? "" : "s"}. The resources themselves are not deleted.`
          : "This tag is not attached to any resources.",
      confirmLabel: "Delete tag",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/tags/${tag.id}`);
      await reload();
      toast("Tag deleted", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar title="Tags" />
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Create a tag</h2>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={create}>
            <FormError message={error} />
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Marketing"
              maxLength={50}
              required
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tags belong to the company. Reuse them across routines, skills, and Resources.
            </p>
            <div className="flex justify-end">
              <Button type="submit" disabled={!name.trim() || saving}>
                {saving ? "Creating…" : "Create tag"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <h2 className="text-sm font-semibold">Company tags</h2>
        </CardHeader>
        <CardBody>
          {tags === null ? (
            <Spinner />
          ) : tags.length === 0 ? (
            <EmptyState
              title="No tags yet"
              description="Create a tag here, or create one while editing a resource."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {tags.map((tag) => (
                <li key={tag.id} className="flex items-center justify-between gap-3 py-3">
                  {editing?.id === tag.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename(tag);
                      }}
                    >
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        maxLength={50}
                        autoFocus
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
                      />
                      <Button size="sm" type="submit" disabled={!editName.trim() || saving}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <div className="flex min-w-0 items-center gap-3">
                        <Tag size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {tag.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {tag.usageCount ?? 0} resource{tag.usageCount === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(tag);
                            setEditName(tag.name);
                          }}
                        >
                          <Pencil size={12} /> Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(tag)}>
                          <Trash2 size={12} /> Delete
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
