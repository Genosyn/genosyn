import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { api, CompanyTag, TagColor } from "../lib/api";
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
import { getTagColorOption, randomTagColor, TagColorPicker } from "../components/TagColorPicker";
import { useLiveRefetch } from "../components/CompanySocket";

export function SettingsTags() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [tags, setTags] = React.useState<CompanyTag[] | null>(null);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TagColor>(() => randomTagColor());
  const [editing, setEditing] = React.useState<CompanyTag | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editColor, setEditColor] = React.useState<TagColor>("slate");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialog = useDialog();
  const { toast, background } = useToast();

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

  useLiveRefetch("tag", reload);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/tags`, { name: name.trim(), color });
      setName("");
      setColor(randomTagColor());
      await reload();
      toast("Tag created", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function rename(tag: CompanyTag) {
    if (!editName.trim() || saving) return;
    const optimistic = { ...tag, name: editName.trim(), color: editColor };
    setTags(
      (current) => current?.map((item) => (item.id === tag.id ? optimistic : item)) ?? current,
    );
    setEditing(null);
    background(
      () =>
        api.patch<CompanyTag>(`/api/companies/${company.id}/tags/${tag.id}`, {
          name: optimistic.name,
          color: optimistic.color,
        }),
      {
        loading: "Renaming tag…",
        success: "Tag renamed",
        error: (error) =>
          `Couldn\u2019t rename the tag: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The previous name has been restored.`,
        onSuccess: (updated) => {
          setTags(
            (current) =>
              current?.map((item) => (item.id === updated.id ? updated : item)) ?? current,
          );
        },
        onError: () => {
          setTags(
            (current) => current?.map((item) => (item.id === tag.id ? tag : item)) ?? current,
          );
        },
      },
    );
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
    const originalIndex = tags?.findIndex((item) => item.id === tag.id) ?? -1;
    setTags((current) => current?.filter((item) => item.id !== tag.id) ?? current);
    background(() => api.del(`/api/companies/${company.id}/tags/${tag.id}`), {
      loading: "Deleting tag…",
      success: "Tag deleted",
      error: (error) =>
        `Couldn\u2019t delete the tag: ${
          error instanceof Error ? error.message : "Unknown error"
        }. It has been restored.`,
      onError: () => {
        setTags((current) => {
          if (!current || current.some((item) => item.id === tag.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, tag);
          return next;
        });
      },
    });
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
            <TagColorPicker value={color} onChange={setColor} />
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
                      className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename(tag);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <Input
                          label="Name"
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          maxLength={50}
                          autoFocus
                        />
                      </div>
                      <TagColorPicker value={editColor} onChange={setEditColor} />
                      <div className="flex gap-2">
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
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="min-w-0">
                          <div
                            className={`inline-block max-w-full truncate rounded-full border px-2.5 py-0.5 text-sm font-medium ${getTagColorOption(tag.color).chipClass}`}
                          >
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
                            setEditColor(tag.color);
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
