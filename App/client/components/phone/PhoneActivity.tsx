import React from "react";
import {
  Bot,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Send,
  UserRound,
} from "lucide-react";
import { errorMessage } from "../../lib/errors";
import {
  callStatusLabel,
  formatDuration,
  isLiveCall,
  phoneApi,
  type PhoneCallRow,
  type PhoneNumberRow,
  type PhoneText,
} from "../../lib/phone";
import {
  MAX_CALL_BRIEF_LENGTH,
  MAX_CALL_OPENING_LENGTH,
  MAX_TEXT_MESSAGE_LENGTH,
  extractVerificationCodes,
} from "../../../shared/phone";
import { useLiveRefetch } from "../CompanySocket";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { FormError } from "../ui/FormError";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { useDialog } from "../ui/Dialog";
import { clsx } from "../ui/clsx";

/**
 * A number's texts and calls, newest first, with a call's transcript a click
 * away. Refreshes itself on the live-sync spine, so an arriving code or a call
 * in progress shows up without a reload.
 */

type Tab = "texts" | "calls";

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function PhoneActivity({
  companyId,
  number,
}: {
  companyId: string;
  number: PhoneNumberRow;
}) {
  const [tab, setTab] = React.useState<Tab>("texts");
  const [texts, setTexts] = React.useState<PhoneText[] | null>(null);
  const [calls, setCalls] = React.useState<PhoneCallRow[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [composing, setComposing] = React.useState(false);
  const [testCalling, setTestCalling] = React.useState(false);
  const [openCallId, setOpenCallId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        phoneApi.texts(companyId, number.id),
        phoneApi.calls(companyId, number.id),
      ]);
      setTexts(t);
      setCalls(c);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load this number's activity"));
      setTexts((current) => current ?? []);
      setCalls((current) => current ?? []);
    }
  }, [companyId, number.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);
  useLiveRefetch("phone", reload, number.id);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-sm dark:border-slate-700">
          {(
            [
              ["texts", "Texts", texts?.length],
              ["calls", "Calls", calls?.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={clsx(
                "rounded-md px-3 py-1.5 font-medium",
                tab === value
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              {label}
              {typeof count === "number" && count > 0 ? (
                <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {number.capabilities.sms && (
            <Button size="sm" variant="secondary" onClick={() => setComposing(true)}>
              <Send size={13} /> Send a text
            </Button>
          )}
          {number.capabilities.voice && number.employee && (
            <Button size="sm" variant="secondary" onClick={() => setTestCalling(true)}>
              <PhoneOutgoing size={13} /> Test call
            </Button>
          )}
        </div>
      </div>

      <FormError message={loadError} />

      {tab === "texts" ? (
        texts === null ? (
          <Spinner />
        ) : texts.length === 0 ? (
          <EmptyState
            title="No texts yet"
            description="Texts sent to this number — verification codes included — appear here as they arrive."
          />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {texts.map((t) => (
              <TextRow key={t.id} text={t} />
            ))}
          </ul>
        )
      ) : calls === null ? (
        <Spinner />
      ) : calls.length === 0 ? (
        <EmptyState
          title="No calls yet"
          description="Calls the AI Employee answers or places appear here, each with its transcript."
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {calls.map((c) => (
            <CallRow key={c.id} call={c} onOpen={() => setOpenCallId(c.id)} />
          ))}
        </ul>
      )}

      <SendTextModal
        open={composing}
        companyId={companyId}
        number={number}
        onClose={() => setComposing(false)}
        onSent={() => {
          setComposing(false);
          setTab("texts");
          void reload();
        }}
      />
      <TestCallModal
        open={testCalling}
        companyId={companyId}
        number={number}
        onClose={() => setTestCalling(false)}
        onPlaced={(call) => {
          setTestCalling(false);
          setTab("calls");
          setOpenCallId(call.id);
          void reload();
        }}
      />
      <CallTranscriptModal
        companyId={companyId}
        callId={openCallId}
        onClose={() => setOpenCallId(null)}
      />
    </div>
  );
}

function TextRow({ text }: { text: PhoneText }) {
  const inbound = text.direction === "inbound";
  const codes = inbound ? extractVerificationCodes(text.body) : [];
  const failed = text.status === "failed" || text.status === "undelivered";
  return (
    <li className="flex gap-3 px-3 py-2.5 text-sm">
      <span
        className={clsx(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          inbound
            ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            : "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300",
        )}
        title={inbound ? "Received" : "Sent"}
      >
        {inbound ? (
          <MessageSquare size={12} />
        ) : text.sentBy === "member" ? (
          <UserRound size={12} />
        ) : (
          <Bot size={12} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {inbound ? `From ${text.fromDisplay}` : `To ${text.toDisplay}`}
          </span>
          <span>{when(text.occurredAt)}</span>
          {!inbound && (
            <span className={failed ? "text-red-600 dark:text-red-400" : ""}>
              {text.sentBy === "auto_reply" ? "Automatic reply · " : ""}
              {text.status}
            </span>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100">
          {text.body || (text.mediaCount > 0 ? "(picture message)" : "")}
        </p>
        {codes.length > 0 && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Code{codes.length > 1 ? "s" : ""}:{" "}
            {codes.map((code) => (
              <code
                key={code}
                className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800 dark:bg-slate-800 dark:text-slate-100"
              >
                {code}
              </code>
            ))}
          </p>
        )}
        {failed && text.errorMessage && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{text.errorMessage}</p>
        )}
      </div>
    </li>
  );
}

function CallRow({ call, onOpen }: { call: PhoneCallRow; onOpen: () => void }) {
  const inbound = call.direction === "inbound";
  const live = isLiveCall(call);
  const missed = ["busy", "no-answer", "failed", "canceled"].includes(call.status);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <span
          className={clsx(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            live
              ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300"
              : missed
                ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
          )}
        >
          {inbound ? <PhoneIncoming size={12} /> : <PhoneOutgoing size={12} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {inbound ? call.fromDisplay : call.toDisplay}
          </span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {inbound
              ? "Incoming"
              : call.placedBy === "member"
                ? "Test call"
                : "Placed by the AI Employee"}
            {call.brief ? ` · ${call.brief}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
          <span
            className={clsx(
              "block font-medium",
              live && "text-emerald-600 dark:text-emerald-300",
              missed && "text-red-600 dark:text-red-400",
            )}
          >
            {callStatusLabel(call)}
            {call.durationSec !== null && call.durationSec > 0
              ? ` · ${formatDuration(call.durationSec)}`
              : ""}
          </span>
          <span className="block">{when(call.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}

function SendTextModal({
  open,
  companyId,
  number,
  onClose,
  onSent,
}: {
  open: boolean;
  companyId: string;
  number: PhoneNumberRow;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTo("");
      setBody("");
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send a text"
      description={`From ${number.display}. Sent by you, not the AI Employee.`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await phoneApi.sendText(companyId, number.id, { to, body });
          onSent();
        } catch (err) {
          setError(errorMessage(err, "Could not send the text"));
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!to.trim() || !body.trim()}>
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        <Input
          label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+15550101234"
          autoFocus
        />
        <Textarea
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          className="min-h-[100px]"
          maxLength={MAX_TEXT_MESSAGE_LENGTH}
        />
      </div>
    </Modal>
  );
}

function TestCallModal({
  open,
  companyId,
  number,
  onClose,
  onPlaced,
}: {
  open: boolean;
  companyId: string;
  number: PhoneNumberRow;
  onClose: () => void;
  onPlaced: (call: PhoneCallRow) => void;
}) {
  const name = number.employee?.name ?? "The AI Employee";
  const [to, setTo] = React.useState("");
  const [brief, setBrief] = React.useState("");
  const [openingLine, setOpeningLine] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTo("");
      setBrief(
        "This is a test call from the company's Genosyn setup. Say hello, confirm the line sounds clear, answer one or two questions about yourself, then say goodbye.",
      );
      setOpeningLine("");
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Place a test call"
      description={`${name} calls the number you enter from ${number.display} and talks, guided only by the brief.`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          onPlaced(await phoneApi.placeTestCall(companyId, number.id, { to, brief, openingLine }));
        } catch (err) {
          setError(errorMessage(err, "Could not place the call"));
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!to.trim() || !brief.trim()}>
            <Phone size={13} /> Call
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        <Input
          label="Call this number"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Your phone, e.g. +15550101234"
          autoFocus
        />
        <Textarea
          label="Brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          className="min-h-[100px]"
          maxLength={MAX_CALL_BRIEF_LENGTH}
        />
        <Input
          label="Opening line (optional)"
          value={openingLine}
          onChange={(e) => setOpeningLine(e.target.value)}
          maxLength={MAX_CALL_OPENING_LENGTH}
          placeholder={`Hi, this is ${name}, an AI assistant.`}
        />
      </div>
    </Modal>
  );
}

export function CallTranscriptModal({
  companyId,
  callId,
  onClose,
}: {
  companyId: string;
  callId: string | null;
  onClose: () => void;
}) {
  const [call, setCall] = React.useState<PhoneCallRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hangingUp, setHangingUp] = React.useState(false);
  const dialog = useDialog();

  const load = React.useCallback(async () => {
    if (!callId) return;
    try {
      setCall(await phoneApi.call(companyId, callId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the call"));
    }
  }, [companyId, callId]);

  React.useEffect(() => {
    setCall(null);
    setError(null);
    void load();
  }, [load]);
  useLiveRefetch("phone", load, call?.phoneNumberId ?? null);

  // The live frame is coalesced; a call in progress also polls, so its
  // transcript reads like a conversation rather than in bursts.
  const live = call ? isLiveCall(call) : false;
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [live, load]);

  const transcript = call?.transcript ?? [];
  return (
    <Modal
      open={callId !== null}
      onClose={onClose}
      title={
        call
          ? call.direction === "inbound"
            ? `Call from ${call.fromDisplay}`
            : `Call to ${call.toDisplay}`
          : "Call"
      }
      description={
        call
          ? [
              callStatusLabel(call),
              call.durationSec ? formatDuration(call.durationSec) : "",
              call.endReason,
              new Date(call.createdAt).toLocaleString(),
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      size="lg"
      footer={
        live ? (
          <Button
            type="button"
            variant="danger"
            loading={hangingUp}
            onClick={async () => {
              if (!call) return;
              setHangingUp(true);
              try {
                await phoneApi.hangUp(companyId, call.id);
                await load();
              } catch (err) {
                void dialog.error(err, { title: "Couldn’t end the call" });
              } finally {
                setHangingUp(false);
              }
            }}
          >
            {!hangingUp && <PhoneOff size={13} />} End call
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        {call?.brief && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
            <span className="mb-0.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Brief
            </span>
            <span className="whitespace-pre-wrap">{call.brief}</span>
          </div>
        )}
        {call?.errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400">{call.errorMessage}</p>
        )}
        {!call && !error ? (
          <Spinner />
        ) : transcript.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {live ? "Waiting for the conversation to start…" : "Nothing was said on this call."}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {transcript.map((turn, index) => {
              const employee = turn.speaker === "employee";
              return (
                <li
                  key={`${turn.at}-${index}`}
                  className={clsx("flex", employee ? "justify-end" : "justify-start")}
                >
                  <div
                    className={clsx(
                      "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                      employee
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
                    )}
                  >
                    {turn.digits && (
                      <span className="mb-0.5 block text-xs opacity-80">Pressed {turn.digits}</span>
                    )}
                    {turn.text}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Modal>
  );
}
