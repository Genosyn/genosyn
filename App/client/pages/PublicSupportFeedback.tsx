import React from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, Star } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { errorMessage } from "@/lib/errors";
import { feedbackApi, type FeedbackPage } from "@/lib/support";

const SCORE_WORDS = ["", "Very poor", "Poor", "Okay", "Good", "Excellent"];

/**
 * The page a customer rates a ticket on. Their link is the only credential, and
 * nothing is recorded until they press the button: mail scanners follow every link
 * in an email, and a scanner's visit must not count as anyone's opinion.
 */
export default function PublicSupportFeedback() {
  const { token = "" } = useParams<{ token: string }>();
  const [page, setPage] = React.useState<FeedbackPage | null>(null);
  const [invalid, setInvalid] = React.useState("");
  const [score, setScore] = React.useState<number | null>(null);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sent, setSent] = React.useState(false);

  React.useEffect(() => {
    feedbackApi
      .get(token)
      .then((loaded) => {
        setPage(loaded);
        setScore(loaded.score);
        setComment(loaded.comment);
      })
      .catch((err: unknown) => setInvalid(errorMessage(err, "This link is invalid.")));
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (score === null) return;
    setBusy(true);
    setError("");
    try {
      setPage(await feedbackApi.rate(token, score, comment));
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, "Your rating did not go through. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Card className="w-full max-w-md p-6">
        {invalid ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{invalid}</p>
        ) : !page ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : page.expired ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This link has expired. Reply to the email if there is anything else {page.companyName}{" "}
            can help with.
          </p>
        ) : sent ? (
          <div className="text-center">
            <CheckCircle2 size={32} className="mx-auto text-emerald-500" aria-hidden="true" />
            <h1 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
              Thank you
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {page.companyName} has your rating.
            </p>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              How did {page.companyName} do?
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {page.subject} ({page.reference})
            </p>
            <div
              className="mt-5 flex justify-center gap-1"
              role="radiogroup"
              aria-label="Your rating"
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={score === value}
                  aria-label={`${value} of 5: ${SCORE_WORDS[value]}`}
                  onClick={() => setScore(value)}
                  className="rounded-lg p-1.5 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:hover:bg-slate-800"
                >
                  <Star
                    size={30}
                    aria-hidden="true"
                    className={clsx(
                      score !== null && value <= score
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300 dark:text-slate-600",
                    )}
                  />
                </button>
              ))}
            </div>
            <p className="mt-1 h-5 text-center text-sm text-slate-500 dark:text-slate-400">
              {score !== null ? SCORE_WORDS[score] : ""}
            </p>
            <div className="mt-3">
              <Textarea
                label="Anything to add? (optional)"
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            <FormError message={error} className="mt-3" />
            <Button type="submit" className="mt-4 w-full" loading={busy} disabled={score === null}>
              Send
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
