import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, Company, Employee } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";

export default function CompanyDashboard({ company }: { company: Company }) {
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const navigate = useNavigate();
  const { companySlug } = useParams();

  React.useEffect(() => {
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [company.id]);

  return (
    <>
      <TopBar
        title="AI Employees"
        right={
          <Button onClick={() => navigate(`/c/${companySlug}/employees/new`)}>
            <Plus size={16} /> New employee
          </Button>
        }
      />
      {employees === null ? (
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      ) : employees.length === 0 ? (
        <EmptyState
          title="No AI employees yet"
          description="Hire your first employee to give them a Soul, Skills, and Routines."
          action={
            <Button onClick={() => navigate(`/c/${companySlug}/employees/new`)}>
              <Plus size={16} /> New employee
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {employees.map((e) => (
            <Card
              key={e.id}
              className="cursor-pointer transition hover:border-slate-300"
              onClick={() => navigate(`/c/${companySlug}/employees/${e.slug}`)}
            >
              <CardBody>
                <div className="text-sm text-slate-500">{e.role}</div>
                <div className="mt-1 text-lg font-semibold">{e.name}</div>
                <div className="mt-3 text-xs text-slate-400">@{e.slug}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
