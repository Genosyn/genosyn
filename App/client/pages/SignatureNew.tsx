import React from "react";
import { Bot, FileText, UploadCloud, X } from "lucide-react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { api, type Customer } from "@/lib/api";
import {
  signatureDateInputToEndOfDayIso,
  type SignatureEnvelope,
  type SignatureEnvelopeDetail,
} from "@/lib/signing";
import type { SignatureOutletContext } from "@/pages/SignatureLayout";

function extractEnvelopeId(value: SignatureEnvelope | SignatureEnvelopeDetail): string {
  return "envelope" in value ? value.envelope.id : value.id;
}

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 200;

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function SignatureNew() {
  const { company } = useOutletContext<SignatureOutletContext>();
  const navigate = useNavigate();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [routingMode, setRoutingMode] = React.useState<"parallel" | "ordered">("parallel");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [checkingFile, setCheckingFile] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const titleCustomizedRef = React.useRef(false);
  const fileCheckRef = React.useRef(0);
  const routeBase = `/c/${company.slug}/signatures`;

  React.useEffect(() => {
    void api
      .get<Customer[] | { customers: Customer[] }>(`/api/companies/${company.id}/customers`)
      .then((result) => setCustomers(Array.isArray(result) ? result : result.customers))
      .catch(() => setCustomers([]));
  }, [company.id]);

  async function choose(next: File | undefined) {
    if (!next) return;
    const rejectFile = (message: string) => {
      setError(message);
      if (inputRef.current) inputRef.current.value = "";
    };
    const checkId = ++fileCheckRef.current;
    if (next.type !== "application/pdf" && !next.name.toLowerCase().endsWith(".pdf")) {
      rejectFile("Choose a PDF document.");
      return;
    }
    if (next.size > MAX_PDF_BYTES) {
      rejectFile("Choose a PDF smaller than 25 MB.");
      return;
    }
    setCheckingFile(true);
    setError(null);
    try {
      const task = getDocument({ data: await next.arrayBuffer() });
      const document = await task.promise;
      const pageCount = document.numPages;
      await document.cleanup();
      if (checkId !== fileCheckRef.current) return;
      if (pageCount > MAX_PDF_PAGES) {
        rejectFile(`Choose a PDF with ${MAX_PDF_PAGES} pages or fewer.`);
        return;
      }
      setFile(next);
      if (!titleCustomizedRef.current) setTitle(next.name.replace(/\.pdf$/i, ""));
    } catch {
      if (checkId === fileCheckRef.current) {
        rejectFile("This PDF could not be opened. Try exporting it again before uploading.");
      }
    } finally {
      if (checkId === fileCheckRef.current) setCheckingFile(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose the PDF you want people to sign.");
      return;
    }
    if (!title.trim()) {
      setError("Give this request a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.uploadFile<SignatureEnvelope | SignatureEnvelopeDetail>(
        `/api/companies/${company.id}/signature-envelopes`,
        file,
        {
          title: title.trim(),
          customerId,
          message: message.trim(),
          routingMode,
          expiresAt: signatureDateInputToEndOfDayIso(expiresAt) ?? "",
        },
      );
      navigate(`${routeBase}/${extractEnvelopeId(result)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be created.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs items={[{ label: "Signatures", to: routeBase }, { label: "New request" }]} />
      <div className="mt-5 max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          New signature request
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Start with a PDF. You will add recipients and place signing fields in the next step.
        </p>

        <form onSubmit={submit} className="mt-7 space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Document</h2>
            {!file ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void choose(event.dataTransfer.files[0]);
                }}
                disabled={checkingFile}
                className="mt-3 flex w-full flex-col items-center rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center transition hover:border-indigo-400 hover:bg-indigo-50/30 dark:border-slate-600 dark:hover:bg-indigo-950/20"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                  <UploadCloud size={21} />
                </span>
                <span className="mt-3 text-sm font-medium text-slate-800 dark:text-slate-200">
                  {checkingFile ? "Checking PDF…" : "Drop a PDF here, or choose a file"}
                </span>
                <span className="mt-1 text-xs text-slate-400">
                  PDF only · up to 25 MB and 200 pages
                </span>
              </button>
            ) : (
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
                <FileText size={20} className="shrink-0 text-indigo-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                    {file.name}
                  </div>
                  <div className="text-xs text-slate-400">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    fileCheckRef.current += 1;
                    setFile(null);
                    setCheckingFile(false);
                    if (inputRef.current) inputRef.current.value = "";
                  }}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
                  aria-label="Remove PDF"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </section>

          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Details</h2>
            <Input
              label="Request title"
              value={title}
              onChange={(event) => {
                titleCustomizedRef.current = true;
                setTitle(event.target.value);
              }}
              placeholder="Mutual NDA"
              required
            />
            <Select
              label="Customer (optional)"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">No linked customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </Select>
            <Textarea
              label="Message (optional)"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Please review and sign this agreement."
              className="min-h-24"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Signing order"
                value={routingMode}
                onChange={(event) => setRoutingMode(event.target.value as "parallel" | "ordered")}
              >
                <option value="parallel">Everyone at once</option>
                <option value="ordered">In a set order</option>
              </Select>
              <Input
                label="Expires (optional)"
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </div>
          </section>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
            <div className="flex gap-3">
              <Bot size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
              <div>
                <div className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">
                  Prefer to delegate the setup?
                </div>
                <p className="mt-1 text-xs leading-5 text-indigo-700 dark:text-indigo-300">
                  Upload the PDF under{" "}
                  <Link className="font-medium underline" to={"/c/" + company.slug + "/resources"}>
                    Resources
                  </Link>
                  , share it with an AI Employee, and give them Prepare drafts access. They can
                  create a separate request with recipients and fields for you to review. They
                  cannot sign for anyone. Prepare drafts never emails anyone; Send to customers lets
                  the employee contact recipients without another Member click.
                </p>
              </div>
            </div>
          </div>

          <FormError message={error} />
          <div className="flex items-center justify-end gap-2">
            <Link to={routeBase}>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </Link>
            <Button type="submit" disabled={saving || checkingFile}>
              {saving && <Spinner size={15} />} Create draft
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
