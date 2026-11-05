import React from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { errorMessage } from "@/lib/errors";
import { chatConfirmApi } from "@/lib/support";
import type { ChatEmailConfirmation } from "../../shared/supportChat";

/**
 * Where a Chat widget visitor confirms an email address is theirs. Nothing is recorded
 * until a person presses the button: mail scanners follow every link in an email, and a
 * scanner's visit must not turn a stranger's typed address into a place replies go.
 */
export default function PublicSupportChatConfirm() {
  const { token = "" } = useParams<{ token: string }>();
  const [page, setPage] = React.useState<ChatEmailConfirmation | null>(null);
  const [invalid, setInvalid] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    chatConfirmApi
      .get(token)
      .then(setPage)
      .catch((err: unknown) => setInvalid(errorMessage(err, "This link is no longer valid.")));
  }, [token]);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setPage(await chatConfirmApi.confirm(token));
    } catch (err) {
      setError(errorMessage(err, "That did not go through. Please try again."));
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
        ) : page.state === "expired" ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This link has expired. Ask again from the chat if you still want replies by email.
          </p>
        ) : page.state === "confirmed" ? (
          <div className="text-center">
            <CheckCircle2 size={32} className="mx-auto text-emerald-500" aria-hidden="true" />
            <h1 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
              Thank you
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Replies from {page.companyName} you miss in the chat now go to {page.address}.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Get replies from {page.companyName} by email?
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Someone chatting with {page.companyName} asked for replies to go to {page.address}. If
              that was not you, close this page and nothing more will be sent.
            </p>
            <FormError message={error} className="mt-3" />
            <Button className="mt-4 w-full" loading={busy} onClick={() => void confirm()}>
              Confirm
            </Button>
          </>
        )}
      </Card>
    </main>
  );
}
