import { Link } from "react-router-dom";
import type { Company, InvoiceIssuer as Issuer, Subsidiary } from "@/lib/api";
import { Select } from "@/components/ui/Select";

export function InvoiceIssuerSelect({
  company,
  subsidiaries,
  value,
  onChange,
  savedIssuer,
  savedSubsidiaryId,
}: {
  company: Company;
  subsidiaries: Subsidiary[];
  value: string;
  onChange: (value: string) => void;
  savedIssuer?: Issuer | null;
  savedSubsidiaryId?: string | null;
}) {
  const selected = subsidiaries.find((item) => item.id === value);
  const issuer = savedIssuer && value === savedSubsidiaryId ? savedIssuer : selected;
  return (
    <div className="min-w-0 space-y-2">
      <Select label="Issued by" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Company default — {company.name}</option>
        {subsidiaries
          .filter((item) => !item.archived || item.id === value || item.id === savedSubsidiaryId)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.id === savedSubsidiaryId && savedIssuer ? savedIssuer.name : item.name}
              {item.archived ? " (archived)" : ""}
            </option>
          ))}
      </Select>
      {issuer && (
        <p className="whitespace-pre-line text-xs text-slate-500 dark:text-slate-400">
          {[issuer.address, issuer.country].filter(Boolean).join("\n")}
          {issuer.taxNumber && `\nTax / VAT: ${issuer.taxNumber}`}
        </p>
      )}
      {savedIssuer && value === savedSubsidiaryId && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This draft keeps its saved issuer details.
        </p>
      )}
      {selected?.archived ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          This subsidiary is archived. Choose an active issuer for new work.
        </p>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The legal entity shown on this document.{" "}
          <Link
            className="text-indigo-600 hover:underline dark:text-indigo-400"
            to={`/c/${company.slug}/finance/subsidiaries`}
          >
            Manage subsidiaries
          </Link>
        </p>
      )}
    </div>
  );
}

export function InvoiceIssuerDetails({
  issuer,
  companyName,
}: {
  issuer: Issuer | null;
  companyName: string;
}) {
  return (
    <div className="mb-6 border-b border-slate-100 pb-5 text-sm dark:border-slate-800">
      <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
        Issued by
      </div>
      <div className="mt-1 font-medium text-slate-900 dark:text-slate-100">
        {issuer?.name ?? companyName}
      </div>
      {issuer && (
        <div className="mt-1 space-y-1 break-words text-slate-500 dark:text-slate-400">
          {(issuer.address || issuer.country) && (
            <p className="whitespace-pre-line">
              {[issuer.address, issuer.country].filter(Boolean).join("\n")}
            </p>
          )}
          {issuer.taxNumber && <p>Tax / VAT: {issuer.taxNumber}</p>}
          {issuer.registrationNumber && <p>Registration: {issuer.registrationNumber}</p>}
          {(issuer.email || issuer.phone || issuer.website) && (
            <p>{[issuer.email, issuer.phone, issuer.website].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      )}
    </div>
  );
}
