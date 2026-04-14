import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, AIModel, Company, Employee } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

export default function EmployeeNew({ company }: { company: Company }) {
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [defaultModelId, setDefaultModelId] = React.useState("");
  const [models, setModels] = React.useState<AIModel[]>([]);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const { toast } = useToast();

  React.useEffect(() => {
    api.get<AIModel[]>(`/api/companies/${company.id}/models`).then(setModels).catch(() => {});
  }, [company.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const emp = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
        name,
        role,
        defaultModelId: defaultModelId || undefined,
      });
      navigate(`/c/${companySlug}/employees/${emp.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <TopBar title="Hire an AI Employee" />
      <Card>
        <CardHeader>
          <p className="text-sm text-slate-500">
            Give the employee a name and a role. You&apos;ll write their Soul next.
          </p>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada"
              required
            />
            <Input
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Research Analyst"
              required
            />
            <Select
              label="Default AI Model (optional)"
              value={defaultModelId}
              onChange={(e) => setDefaultModelId(e.target.value)}
            >
              <option value="">— None —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.provider}/{m.model}
                </option>
              ))}
            </Select>
            <div className="flex gap-2">
              <Button type="submit" disabled={loading}>
                {loading ? "Creating…" : "Hire employee"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate(`/c/${companySlug}`)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
