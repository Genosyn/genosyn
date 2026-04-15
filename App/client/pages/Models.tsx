import React from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { api, Company, ModelOverviewRow } from "../lib/api";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";

/**
 * AI Models overview. Models are employee-owned (one-to-one), so this page
 * is a read-only cross-company roll-up. Click a row to jump to the
 * employee's Model tab and configure from there.
 */
export default function Models({ company }: { company: Company }) {
  const { companySlug } = useParams();
  const [rows, setRows] = React.useState<ModelOverviewRow[] | null>(null);

  React.useEffect(() => {
    api
      .get<ModelOverviewRow[]>(`/api/companies/${company.id}/models`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [company.id]);

  return (
    <>
      <TopBar title="AI Models" />
      <p className="mb-6 -mt-2 text-sm text-slate-500">
        Each AI Employee signs into their own provider. This page shows who is
        connected to what.
      </p>
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No employees yet"
          description="Hire an AI Employee first, then connect a Model on their page."
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((row) => (
            <Link
              key={row.employeeId}
              to={`/c/${companySlug}/employees/${row.employeeSlug}?tab=model`}
              className="block"
            >
              <Card className="transition hover:border-slate-300 hover:shadow">
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{row.employeeName}</div>
                    <div className="text-xs text-slate-500">{row.role}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {row.model ? (
                      <>
                        <div className="text-right">
                          <div className="text-sm text-slate-700">
                            {row.model.provider}
                          </div>
                          <div className="text-xs text-slate-400">{row.model.model}</div>
                        </div>
                        <Badge status={row.model.status} />
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function Badge({ status }: { status: "connected" | "not_connected" }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
        <Check size={10} /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
      <Loader2 size={10} className="animate-spin" /> Waiting
    </span>
  );
}
