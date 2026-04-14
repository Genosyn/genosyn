import React from "react";
import { Trash2 } from "lucide-react";
import { api, AIModel, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

export default function Models({ company }: { company: Company }) {
  const [models, setModels] = React.useState<AIModel[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const { toast } = useToast();

  async function reload() {
    const m = await api.get<AIModel[]>(`/api/companies/${company.id}/models`);
    setModels(m);
  }

  React.useEffect(() => {
    reload().catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  return (
    <>
      <TopBar
        title="AI Models"
        right={<Button onClick={() => setAdding(true)}>Add model</Button>}
      />
      {models === null ? (
        <Spinner />
      ) : models.length === 0 ? (
        <EmptyState
          title="No models configured"
          description="Add a Claude Code, Codex, or opencode model so your employees have a brain."
        />
      ) : (
        <div className="grid gap-3">
          {models.map((m) => (
            <Card key={m.id}>
              <CardBody className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{m.name}</div>
                  <div className="text-xs text-slate-500">
                    {m.provider} · {m.model}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!confirm(`Delete model "${m.name}"?`)) return;
                    try {
                      await api.del(`/api/companies/${company.id}/models/${m.id}`);
                      reload();
                    } catch (err) {
                      toast((err as Error).message, "error");
                    }
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <AddModelModal
          company={company}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function AddModelModal({
  company,
  onClose,
  onCreated,
}: {
  company: Company;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [provider, setProvider] = React.useState<"claude-code" | "codex" | "opencode">(
    "claude-code",
  );
  const [model, setModel] = React.useState("");
  const { toast } = useToast();

  return (
    <Modal open onClose={onClose} title="Add AI Model">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post(`/api/companies/${company.id}/models`, {
              name,
              provider,
              model,
            });
            onCreated();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <Input
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production Claude"
          required
        />
        <Select
          label="Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as "claude-code" | "codex" | "opencode")}
        >
          <option value="claude-code">claude-code</option>
          <option value="codex">codex</option>
          <option value="opencode">opencode</option>
        </Select>
        <Input
          label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="claude-opus-4-6"
          required
        />
        <Button type="submit">Add</Button>
      </form>
    </Modal>
  );
}
