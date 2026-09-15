import React from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardCheck, LockKeyhole, Send } from "lucide-react";

import { Logo } from "@/components/Logo";
import { FormQuestionInput } from "@/components/forms/FormQuestionInput";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api, type BaseColor, type PublicBaseForm } from "@/lib/api";
import {
  initialPublicFormValues,
  preparePublicFormSubmission,
  publicFormRequiredProgress,
  type PublicFormValue,
  type PublicFormValues,
} from "@/lib/baseForms";
import { errorMessage } from "@/lib/errors";

const ACCENT: Record<BaseColor, string> = {
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

export default function PublicForm() {
  const { token = "" } = useParams<{ token: string }>();
  const endpoint = `/api/forms/${encodeURIComponent(token)}`;
  const [form, setForm] = React.useState<PublicBaseForm | null>(null);
  const [values, setValues] = React.useState<PublicFormValues>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [completed, setCompleted] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const submissionIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setCompleted(false);
    setDirty(false);
    submissionIdRef.current = null;
    void api
      .get<PublicBaseForm>(endpoint)
      .then((next) => {
        if (cancelled) return;
        setForm(next);
        setValues(initialPublicFormValues(next.questions));
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(errorMessage(cause, "This form is unavailable."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  React.useEffect(() => {
    if (!dirty || completed) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [completed, dirty]);

  function changeValue(questionId: string, value: PublicFormValue) {
    setValues((current) => ({ ...current, [questionId]: value }));
    setDirty(true);
    setSubmitError(null);
    setFieldErrors((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
  }

  function focusQuestion(questionId: string) {
    window.requestAnimationFrame(() => {
      const card = document.getElementById(`public-form-question-${questionId}`);
      card?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
      const control = document.getElementById(`form-question-control-${questionId}`);
      if (control instanceof HTMLElement) {
        const focusable = control.matches("input,textarea,button,select")
          ? control
          : control.querySelector<HTMLElement>("input,textarea,button,select");
        focusable?.focus({ preventScroll: true });
      }
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || submitting || !form.acceptingResponses) return;
    const prepared = preparePublicFormSubmission(
      form.questions,
      values,
      submissionIdRef.current,
    );
    setFieldErrors(prepared.errors);
    if (!prepared.ok) {
      setSubmitError("Complete the highlighted questions, then submit again.");
      focusQuestion(prepared.firstInvalidQuestionId);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      submissionIdRef.current = prepared.body.submissionId;
      await api.post<{ ok: true }>(`${endpoint}/responses`, prepared.body);
      setCompleted(true);
      setDirty(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      setSubmitError(errorMessage(cause, "Your response could not be submitted."));
    } finally {
      setSubmitting(false);
    }
  }

  function anotherResponse() {
    if (!form) return;
    submissionIdRef.current = null;
    setValues(initialPublicFormValues(form.questions));
    setFieldErrors({});
    setSubmitError(null);
    setCompleted(false);
    setDirty(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (loading) {
    return (
      <PublicFormShell>
        <div className="flex min-h-[70vh] items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={22} /> Opening form…
        </div>
      </PublicFormShell>
    );
  }

  if (!form || loadError) {
    return (
      <PublicFormShell>
        <TerminalCard
          icon={<AlertTriangle size={24} />}
          title="This form is unavailable"
          description="Ask the sender for a new link, or check that you copied the whole address."
          tone="danger"
        />
      </PublicFormShell>
    );
  }

  if (!form.acceptingResponses) {
    return (
      <PublicFormShell companyName={form.companyName}>
        <TerminalCard
          icon={<LockKeyhole size={24} />}
          title="This form is not accepting responses"
          description="The owner has closed submissions for now. You can close this page."
          tone="neutral"
        />
      </PublicFormShell>
    );
  }

  if (completed) {
    return (
      <PublicFormShell companyName={form.companyName}>
        <TerminalCard
          icon={<CheckCircle2 size={25} />}
          title={form.successTitle || "Thanks — response received"}
          description={form.successMessage || "Your response has been recorded."}
          tone="success"
          focusTitle
          action={
            form.allowAnotherResponse ? (
              <Button onClick={anotherResponse}>Submit another response</Button>
            ) : undefined
          }
        />
      </PublicFormShell>
    );
  }

  const progress = publicFormRequiredProgress(form.questions, values);

  return (
    <PublicFormShell companyName={form.companyName}>
      <main className="px-4 py-7 sm:px-6 sm:py-10">
        <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" noValidate>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950">
            <div className={clsx("h-2", ACCENT[form.color] ?? ACCENT.indigo)} />
            <div className="p-6 sm:p-8">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {form.companyName}
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-slate-100">
                {form.title}
              </h1>
              {form.description && (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {form.description}
                </p>
              )}
              <div className="mt-5 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                <span>{progress.required ? "* Required" : "No required questions"}</span>
                {progress.required > 0 && (
                  <span className="tabular-nums">
                    {progress.completed} of {progress.required} required
                  </span>
                )}
              </div>
              {progress.required > 0 && (
                <div
                  role="progressbar"
                  aria-label="Required questions completed"
                  aria-valuemin={0}
                  aria-valuemax={progress.required}
                  aria-valuenow={progress.completed}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                >
                  <div
                    className={clsx("h-full rounded-full transition-[width]", ACCENT[form.color])}
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              )}
            </div>
          </section>

          {form.questions.map((question, index) => {
            const invalid = !!fieldErrors[question.id];
            const choiceQuestion = question.type === "select" || question.type === "multiselect";
            const labelId = `form-question-label-${question.id}`;
            const descriptionId = question.description
              ? `form-question-description-${question.id}`
              : undefined;
            const errorId = invalid ? `form-question-error-${question.id}` : undefined;
            const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
            const questionLabel = (
              <>
                {question.label}
                {question.required && <span className="ml-1 text-rose-500">*</span>}
              </>
            );
            return (
              <section
                id={`public-form-question-${question.id}`}
                key={question.id}
                className={clsx(
                  "scroll-m-6 rounded-2xl border bg-white p-5 shadow-sm transition sm:p-6 dark:bg-slate-950",
                  invalid
                    ? "border-rose-300 ring-2 ring-rose-500/10 dark:border-rose-800"
                    : "border-slate-200 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-500/10 dark:border-slate-700 dark:focus-within:border-indigo-700",
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium tabular-nums text-slate-400">
                    {index + 1}
                  </span>
                  {choiceQuestion ? (
                    <div
                      id={labelId}
                      className="text-sm font-semibold leading-6 text-slate-900 sm:text-base dark:text-slate-100"
                    >
                      {questionLabel}
                    </div>
                  ) : (
                    <label
                      id={labelId}
                      htmlFor={`form-question-control-${question.id}`}
                      className="text-sm font-semibold leading-6 text-slate-900 sm:text-base dark:text-slate-100"
                    >
                      {questionLabel}
                    </label>
                  )}
                </div>
                {question.description && (
                  <p
                    id={descriptionId}
                    className="ml-6 mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400"
                  >
                    {question.description}
                  </p>
                )}
                <div className="ml-0 mt-4 sm:ml-6">
                  <FormQuestionInput
                    question={question}
                    value={values[question.id]}
                    onChange={(value) => changeValue(question.id, value)}
                    disabled={submitting}
                    invalid={invalid}
                    ariaLabelledBy={choiceQuestion ? labelId : undefined}
                    ariaDescribedBy={describedBy}
                  />
                  {invalid && (
                    <p
                      id={errorId}
                      role="alert"
                      className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400"
                    >
                      {fieldErrors[question.id]}
                    </p>
                  )}
                </div>
              </section>
            );
          })}

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-700 dark:bg-slate-950">
            <FormError message={submitError} className="mb-4" />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button type="submit" disabled={submitting || form.questions.length === 0}>
                {submitting ? <Spinner size={15} /> : <Send size={15} />}
                {submitting ? "Submitting…" : form.submitLabel || "Submit"}
              </Button>
              <div className="flex items-center gap-1.5 text-[11px] leading-5 text-slate-400 dark:text-slate-500">
                <ClipboardCheck size={13} /> Your response will be recorded by {form.companyName}.
              </div>
            </div>
            {form.questions.length === 0 && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                This form has no questions yet.
              </p>
            )}
          </section>
        </form>
      </main>
    </PublicFormShell>
  );
}

function PublicFormShell({
  companyName,
  children,
}: {
  companyName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-slate-800 dark:bg-slate-950">
        <Logo className="h-7 w-auto" />
        <div className="max-w-[55vw] truncate text-xs font-medium text-slate-500 dark:text-slate-400">
          {companyName ? `Form by ${companyName}` : "Public form"}
        </div>
      </header>
      {children}
    </div>
  );
}

function TerminalCard({
  icon,
  title,
  description,
  tone,
  action,
  focusTitle = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tone: "success" | "danger" | "neutral";
  action?: React.ReactNode;
  focusTitle?: boolean;
}) {
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  React.useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  return (
    <div className="mx-auto flex min-h-[75vh] max-w-lg items-center px-5 py-12">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-950">
        <span
          className={clsx(
            "mx-auto flex h-12 w-12 items-center justify-center rounded-full",
            tone === "success"
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
              : tone === "danger"
                ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300",
          )}
        >
          {icon}
        </span>
        <h1
          ref={titleRef}
          tabIndex={focusTitle ? -1 : undefined}
          className="mt-4 text-xl font-semibold text-slate-900 outline-none dark:text-slate-100"
        >
          {title}
        </h1>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-500 dark:text-slate-400">
          {description}
        </p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}
