import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Company, Employee } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

export default function EmployeeNew({ company }: { company: Company }) {
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const emp = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
        name,
        role,
      });
      // Jump straight to Settings so the operator connects a brain next.
      navigate(`/c/${companySlug}/employees/${emp.slug}/settings`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="mb-3">
        <Breadcrumbs
          items={[
            { label: "Employees", to: `/c/${companySlug}` },
            { label: "New" },
          ]}
        />
      </div>
      <TopBar title="Hire an AI Employee" />
      <Card>
        <CardHeader>
          <p className="text-sm text-slate-500">
            Give the employee a name and a role. You&apos;ll write their Soul and
            connect their AI Model next.
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
