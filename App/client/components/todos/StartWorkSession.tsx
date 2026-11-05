import React from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { api, type Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type Repositories = { repositories: Array<{ id: string; name: string; slug: string }> };

/**
 * Hand this Todo to its AI assignee as code: a Repository work session with the Todo's
 * text as its instruction, under this person's access, linked both ways. Says nothing
 * when there's no Repository to offer, so a Todo that isn't about code doesn't grow a
 * button. The server decides that, and leaves out a Todo held to limits.
 */
export function StartWorkSession({
  todo,
  companyId,
  companySlug,
}: {
  todo: Pick<Todo, "id" | "assigneeEmployeeId" | "heldToLimits">;
  companyId: string;
  companySlug: string;
}) {
  const navigate = useNavigate();
  const [repositories, setRepositories] = React.useState<Repositories["repositories"]>([]);
  const [chosen, setChosen] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/companies/${companyId}/todos/${todo.id}`;
  const wanted = Boolean(todo.assigneeEmployeeId) && !todo.heldToLimits;

  React.useEffect(() => {
    setRepositories([]);
    setChosen("");
    setError(null);
    if (!wanted) return;
    let cancelled = false;
    void api
      .get<Repositories>(`${base}/work-session-repositories`)
      .then((found) => {
        if (cancelled) return;
        setRepositories(found.repositories);
        setChosen(found.repositories[0]?.id ?? "");
      })
      // Nothing to offer isn't worth a message on every Todo that's opened.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, wanted, todo.assigneeEmployeeId]);

  if (repositories.length === 0) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.post<{ path: string }>(`${base}/work-session`, {
        repositoryId: chosen,
      });
      navigate(`/c/${companySlug}${started.path}`);
    } catch (err) {
      setError(errorMessage(err, "Could not start a work session."));
      setBusy(false);
    }
  };

  const only = repositories.length === 1 ? repositories[0] : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!only && (
          <Select
            aria-label="Repository"
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
          >
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
          </Select>
        )}
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={() => void start()}
          title="Its AI Employee works on this task in the Repository, with your access"
        >
          <GitBranch size={13} className="mr-1.5" />
          Start work session{only ? ` in ${only.name}` : ""}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}
