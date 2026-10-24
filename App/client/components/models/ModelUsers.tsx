import React from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { api, type AIModel, type Company, type ModelUser } from "@/lib/api";
import { companyModelPath, detachPrompt, usedByLine } from "@/lib/companyModels";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { ButtonSpinner } from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";

/**
 * Who runs on a company AI Model, on its card in Settings → AI Models: each AI
 * Employee as a chip linking to its Model page, marked when this is the model
 * its Routines and chat use. An owner detaches one from here — after saying
 * that the model stays and who keeps it.
 */
export function ModelUsers({
  company,
  model,
  canManage,
  onChanged,
}: {
  company: Pick<Company, "id" | "slug">;
  model: AIModel;
  canManage: boolean;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [detaching, setDetaching] = React.useState<string | null>(null);

  async function detach(user: ModelUser) {
    const prompt = detachPrompt(model, user);
    const ok = await dialog.confirm({
      title: prompt.title,
      message: prompt.message,
      confirmLabel: prompt.confirmLabel,
      variant: "danger",
    });
    if (!ok) return;
    setDetaching(user.id);
    try {
      await api.post(companyModelPath(company.id, model.id, "/detach"), {
        employeeIds: [user.id],
      });
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t detach the AI Model" });
    } finally {
      setDetaching(null);
    }
  }

  if (model.employees.length === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400">{usedByLine(model)}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">Used by</span>
      <ul className="flex flex-wrap gap-1.5" aria-label="AI Employees using this AI Model">
        {model.employees.map((user) => (
          <li
            key={user.id}
            className="flex min-w-0 items-center gap-1.5 rounded-full border border-slate-200 py-0.5 pl-0.5 pr-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
          >
            <Avatar
              name={user.name}
              kind="ai"
              size="xs"
              src={employeeAvatarUrl(company.id, user.id, user.avatarKey)}
            />
            <Link
              to={`/c/${company.slug}/employees/${user.slug}/settings/model`}
              className="truncate font-medium hover:underline"
            >
              {user.name}
            </Link>
            <span className="text-slate-400 dark:text-slate-500">
              {user.isActive ? "· active" : "· standby"}
            </span>
            {canManage && (
              <button
                type="button"
                onClick={() => void detach(user)}
                disabled={detaching !== null}
                aria-label={`Detach from ${user.name}`}
                title={`Detach from ${user.name}`}
                className="grid h-5 w-5 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                {detaching === user.id ? (
                  <ButtonSpinner size={12} />
                ) : (
                  <X size={12} aria-hidden="true" />
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
