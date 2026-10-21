import React from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, FileText, Paperclip, UploadCloud, X } from "lucide-react";

import { RESUME_EXTENSIONS, type OpeningQuestion } from "../../shared/recruiting";
import { CareersApiError, submitApplication } from "./api";
import {
  EMPTY_APPLICATION,
  answersPayload,
  formatBytes,
  newSubmissionId,
  resumeFileProblem,
  validateApplication,
  type ApplicationValues,
} from "./lib";
import type { PublicOpening, PublicSite } from "./types";
import { Spinner, accentButton, quietButton } from "./ui";

/**
 * Applying to one Opening. Everything is checked here first so a candidate
 * fixes a missing field without a round trip, and again on the server; a
 * submit carries a fresh id so a retried request never applies twice.
 */

const inputClass =
  "block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-[15px] text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-[color:var(--accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--accent-ring)] aria-[invalid=true]:border-rose-400";

function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between gap-3 text-sm font-medium text-slate-800">
        <span>{label}</span>
        {required ? null : <span className="text-xs font-normal text-slate-400">Optional</span>}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: string): string | undefined {
  if (error) return `${id}-error`;
  return hint ? `${id}-hint` : undefined;
}

function QuestionInput({
  question,
  value,
  error,
  onChange,
}: {
  question: OpeningQuestion;
  value: string | string[] | boolean | undefined;
  error?: string;
  onChange: (value: string | string[] | boolean) => void;
}) {
  const id = `question-${question.id}`;
  const shared = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, error, question.help || undefined),
  };
  switch (question.kind) {
    case "long_text":
      return (
        <textarea
          {...shared}
          rows={5}
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "yes_no":
      return (
        <div role="radiogroup" aria-label={question.label} className="flex gap-2" id={id}>
          {[
            { label: "Yes", answer: true },
            { label: "No", answer: false },
          ].map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="radio"
              aria-checked={value === choice.answer}
              onClick={() => onChange(choice.answer)}
              className={
                value === choice.answer
                  ? "rounded-xl border border-[color:var(--accent)] bg-[color:var(--accent-soft)] px-5 py-2 text-sm font-medium text-[color:var(--accent)]"
                  : "rounded-xl border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
      );
    case "single_select":
      return (
        <select
          {...shared}
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose one</option>
          {question.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-2" id={id} role="group" aria-label={question.label}>
          {question.options.map((option) => {
            const on = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? selected.filter((item) => item !== option) : [...selected, option])
                }
                className={
                  on
                    ? "rounded-full border border-[color:var(--accent)] bg-[color:var(--accent-soft)] px-3.5 py-1.5 text-sm font-medium text-[color:var(--accent)]"
                    : "rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                }
              >
                {option}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return (
        <input
          {...shared}
          type={question.kind === "number" ? "number" : question.kind === "url" ? "url" : "text"}
          inputMode={question.kind === "number" ? "decimal" : undefined}
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

function ResumeDrop({
  file,
  required,
  error,
  onFile,
}: {
  file: File | null;
  required: boolean;
  error?: string;
  onFile: (file: File | null) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const accept = RESUME_EXTENSIONS.join(",");
  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <FileText aria-hidden className="h-5 w-5 shrink-0 text-[color:var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
          <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
        </div>
        <button
          type="button"
          onClick={() => onFile(null)}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          aria-label="Remove resume"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const dropped = event.dataTransfer.files?.[0];
        if (dropped) onFile(dropped);
      }}
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
        dragging
          ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]"
          : error
            ? "border-rose-300 bg-rose-50/40"
            : "border-slate-200 bg-slate-50/60"
      }`}
    >
      <UploadCloud aria-hidden className="h-7 w-7 text-slate-400" />
      <p className="mt-3 text-sm text-slate-700">
        Drop your resume here, or{" "}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="font-semibold text-[color:var(--accent)] underline-offset-2 hover:underline"
        >
          browse
        </button>
      </p>
      <p className="mt-1 text-xs text-slate-500">PDF or Word, up to 10 MB{required ? "" : " · optional"}</p>
      <input
        ref={inputRef}
        id="resume"
        type="file"
        accept={accept}
        className="sr-only"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "resume-error" : undefined}
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
      />
    </div>
  );
}

export function ApplyForm({ site, opening }: { site: PublicSite; opening: PublicOpening }) {
  const [values, setValues] = React.useState<ApplicationValues>(() => ({
    ...EMPTY_APPLICATION,
    name: site.viewer.member ? site.viewer.name : "",
    email: site.viewer.member ? site.viewer.email : "",
  }));
  const [resume, setResume] = React.useState<File | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [honeypot, setHoneypot] = React.useState("");
  const submissionId = React.useRef<string>(newSubmissionId());
  const formRef = React.useRef<HTMLFormElement>(null);
  const { form, questions } = opening;

  function update<K extends keyof ApplicationValues>(key: K, value: ApplicationValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    const errorKey = key === "linkedinUrl" ? "linkedin" : key === "websiteUrl" ? "website" : key;
    setErrors((current) => {
      if (!current[errorKey as string]) return current;
      const next = { ...current };
      delete next[errorKey as string];
      return next;
    });
  }

  function setAnswer(questionId: string, value: string | string[] | boolean) {
    setValues((current) => ({ ...current, answers: { ...current.answers, [questionId]: value } }));
    setErrors((current) => {
      const key = `answers.${questionId}`;
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function chooseResume(file: File | null) {
    setResume(file);
    setErrors((current) => {
      const next = { ...current };
      delete next.resume;
      const problem = file ? resumeFileProblem(file) : null;
      if (problem) next.resume = problem;
      return next;
    });
  }

  function focusFirstError(found: Record<string, string>) {
    const order = ["name", "email", "phone", "location", "linkedin", "website", "resume", "coverLetter"];
    const first =
      order.find((key) => found[key]) ??
      Object.keys(found).find((key) => key.startsWith("answers.")) ??
      (found.consent ? "consent" : null);
    if (!first) return;
    const id = first.startsWith("answers.") ? `question-${first.slice(8)}` : first;
    window.requestAnimationFrame(() => {
      const element = document.getElementById(id);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (element instanceof HTMLElement && element.id !== "resume") element.focus({ preventScroll: true });
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const found = validateApplication(values, form, questions, resume);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError("Check the highlighted fields, then send your application.");
      focusFirstError(found);
      return;
    }
    setFormError("");
    setSubmitting(true);
    const body = new FormData();
    body.append("submissionId", submissionId.current);
    body.append("name", values.name);
    body.append("email", values.email);
    if (form.phone !== "hidden") body.append("phone", values.phone);
    if (form.location !== "hidden") body.append("location", values.location);
    if (form.linkedin !== "hidden") body.append("linkedinUrl", values.linkedinUrl);
    if (form.website !== "hidden") body.append("websiteUrl", values.websiteUrl);
    if (form.coverLetter !== "hidden") body.append("coverLetter", values.coverLetter);
    body.append("answers", JSON.stringify(answersPayload(questions, values.answers)));
    body.append("consent", values.consent ? "true" : "false");
    body.append("fax", honeypot);
    if (resume) body.append("resume", resume, resume.name);
    try {
      const result = await submitApplication(site.apiPath, opening.slug, body);
      setSentTo(result.email || values.email);
      window.scrollTo({ top: formRef.current?.offsetTop ? formRef.current.offsetTop - 24 : 0, behavior: "smooth" });
    } catch (error) {
      const fields = error instanceof CareersApiError ? error.fields : {};
      setErrors(fields);
      setFormError(error instanceof Error ? error.message : "Your application could not be sent. Try again.");
      focusFirstError(fields);
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo !== null) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm sm:p-12" role="status">
        <CheckCircle2 aria-hidden className="mx-auto h-12 w-12 text-[color:var(--accent)]" />
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">Application sent</h2>
        <p className="mx-auto mt-3 max-w-md text-base text-slate-600">
          Thank you for applying for {opening.title}. {sentTo ? `We emailed a confirmation to ${sentTo}. ` : ""}
          We will get back to you as soon as we can.
        </p>
        <div className="mt-8">
          <Link to="/" className={quietButton}>
            See other openings
          </Link>
        </div>
      </div>
    );
  }

  const fieldError = (key: string) => errors[key];

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="relative rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10"
    >
      <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Apply for this role</h2>
      <p className="mt-2 text-sm text-slate-500">
        It takes a few minutes. We will email you to confirm we received it.
      </p>

      {formError ? (
        <div role="alert" className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {formError}
        </div>
      ) : null}

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <Field id="name" label="Full name" required error={fieldError("name")}>
          <input
            id="name"
            autoComplete="name"
            className={inputClass}
            value={values.name}
            aria-invalid={fieldError("name") ? true : undefined}
            aria-describedby={describedBy("name", fieldError("name"))}
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>
        <Field id="email" label="Email" required error={fieldError("email")}>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className={inputClass}
            value={values.email}
            aria-invalid={fieldError("email") ? true : undefined}
            aria-describedby={describedBy("email", fieldError("email"))}
            onChange={(event) => update("email", event.target.value)}
          />
        </Field>
        {form.phone !== "hidden" ? (
          <Field id="phone" label="Phone" required={form.phone === "required"} error={fieldError("phone")}>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              className={inputClass}
              value={values.phone}
              aria-invalid={fieldError("phone") ? true : undefined}
              aria-describedby={describedBy("phone", fieldError("phone"))}
              onChange={(event) => update("phone", event.target.value)}
            />
          </Field>
        ) : null}
        {form.location !== "hidden" ? (
          <Field
            id="location"
            label="Where you are based"
            required={form.location === "required"}
            error={fieldError("location")}
          >
            <input
              id="location"
              autoComplete="address-level2"
              placeholder="City, country"
              className={inputClass}
              value={values.location}
              aria-invalid={fieldError("location") ? true : undefined}
              aria-describedby={describedBy("location", fieldError("location"))}
              onChange={(event) => update("location", event.target.value)}
            />
          </Field>
        ) : null}
        {form.linkedin !== "hidden" ? (
          <Field id="linkedin" label="LinkedIn" required={form.linkedin === "required"} error={fieldError("linkedin")}>
            <input
              id="linkedin"
              type="url"
              placeholder="https://www.linkedin.com/in/you"
              className={inputClass}
              value={values.linkedinUrl}
              aria-invalid={fieldError("linkedin") ? true : undefined}
              aria-describedby={describedBy("linkedin", fieldError("linkedin"))}
              onChange={(event) => update("linkedinUrl", event.target.value)}
            />
          </Field>
        ) : null}
        {form.website !== "hidden" ? (
          <Field
            id="website"
            label="Website or portfolio"
            required={form.website === "required"}
            error={fieldError("website")}
          >
            <input
              id="website"
              type="url"
              autoComplete="url"
              placeholder="https://"
              className={inputClass}
              value={values.websiteUrl}
              aria-invalid={fieldError("website") ? true : undefined}
              aria-describedby={describedBy("website", fieldError("website"))}
              onChange={(event) => update("websiteUrl", event.target.value)}
            />
          </Field>
        ) : null}
      </div>

      <div className="mt-6">
        <Field id="resume" label="Resume" required={form.resume === "required"} error={fieldError("resume")}>
          <ResumeDrop
            file={resume}
            required={form.resume === "required"}
            error={fieldError("resume")}
            onFile={chooseResume}
          />
        </Field>
      </div>

      {form.coverLetter !== "hidden" ? (
        <div className="mt-6">
          <Field
            id="coverLetter"
            label="Cover letter"
            required={form.coverLetter === "required"}
            hint="Why this role, and what you would bring to it."
            error={fieldError("coverLetter")}
          >
            <textarea
              id="coverLetter"
              rows={6}
              className={inputClass}
              value={values.coverLetter}
              aria-invalid={fieldError("coverLetter") ? true : undefined}
              aria-describedby={describedBy("coverLetter", fieldError("coverLetter"), "hint")}
              onChange={(event) => update("coverLetter", event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {questions.length > 0 ? (
        <div className="mt-10 border-t border-slate-100 pt-8">
          <h3 className="text-base font-semibold text-slate-900">A few questions</h3>
          <div className="mt-5 space-y-6">
            {questions.map((question) => (
              <Field
                key={question.id}
                id={`question-${question.id}`}
                label={question.label}
                required={question.required}
                hint={question.help || undefined}
                error={fieldError(`answers.${question.id}`)}
              >
                <QuestionInput
                  question={question}
                  value={values.answers[question.id]}
                  error={fieldError(`answers.${question.id}`)}
                  onChange={(value) => setAnswer(question.id, value)}
                />
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      {/* People never see this; form-filling bots fill it in. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="fax">Fax</label>
        <input
          id="fax"
          name="fax"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>

      <div className="mt-10 border-t border-slate-100 pt-8">
        <label className="flex items-start gap-3 text-sm text-slate-600">
          <input
            id="consent"
            type="checkbox"
            checked={values.consent}
            aria-invalid={fieldError("consent") ? true : undefined}
            onChange={(event) => update("consent", event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-[color:var(--accent)]"
          />
          <span>
            I agree that {site.name} may store and use my application to consider me for this role.
            {site.privacyPolicyUrl ? (
              <>
                {" "}
                <a href={site.privacyPolicyUrl} className="font-medium text-[color:var(--accent)] hover:underline">
                  Privacy policy
                </a>
              </>
            ) : null}
          </span>
        </label>
        {fieldError("consent") ? (
          <p className="mt-1.5 pl-7 text-xs font-medium text-rose-600">{fieldError("consent")}</p>
        ) : null}
        <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Paperclip aria-hidden className="h-3.5 w-3.5" />
            Your application goes only to {site.name}.
          </p>
          <button type="submit" className={accentButton} disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? "Sending…" : "Submit application"}
          </button>
        </div>
      </div>
    </form>
  );
}
