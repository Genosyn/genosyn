import React from "react";
import { Check, Copy, MessageCircle } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Textarea } from "@/components/ui/Textarea";
import { errorMessage } from "@/lib/errors";
import { supportApi, type SupportInbox, type SupportSettings } from "@/lib/support";
import {
  SUPPORT_CHAT_LIMITS,
  SUPPORT_CHAT_MAX_AI_TURNS_PER_DAY,
  SUPPORT_CHAT_MAX_MESSAGES_PER_HOUR,
} from "../../../shared/supportChat";

/**
 * A Support inbox's Chat widget: off until an owner or admin turns it on, and only on
 * the sites they name. The widget's limits apply across the whole company, so they sit
 * once under Advanced rather than on each inbox.
 */
export function ChatWidgetSection({
  companyId,
  inboxes,
  settings,
  onInboxesChanged,
  onSettingsSaved,
}: {
  companyId: string;
  inboxes: SupportInbox[];
  settings: SupportSettings;
  onInboxesChanged: () => void | Promise<void>;
  onSettingsSaved: (settings: SupportSettings) => void;
}) {
  return (
    <section>
      <SectionHeader
        title="Chat widget"
        icon={<MessageCircle size={15} />}
        description="Let visitors on your own site open a ticket from a chat window. Tickets follow the inbox's AI Employee and how far it goes."
      />
      {inboxes.length === 0 ? (
        <EmptyState
          icon={<MessageCircle />}
          title="Add a Support inbox first"
          description="A chat widget belongs to a Support inbox, which is where its tickets go."
        />
      ) : (
        <div className="space-y-2">
          {inboxes.map((inbox) => (
            <WidgetCard
              key={inbox.id}
              companyId={companyId}
              inbox={inbox}
              onChanged={onInboxesChanged}
            />
          ))}
          <ChatLimits
            companyId={companyId}
            settings={settings}
            onSaved={onSettingsSaved}
          />
        </div>
      )}
    </section>
  );
}

function linesOf(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function WidgetCard({
  companyId,
  inbox,
  onChanged,
}: {
  companyId: string;
  inbox: SupportInbox;
  onChanged: () => void | Promise<void>;
}) {
  const widget = inbox.chatWidget;
  const savedOrigins = widget.allowedOrigins.join("\n");
  const [enabled, setEnabled] = React.useState(widget.enabled);
  const [origins, setOrigins] = React.useState(savedOrigins);
  const [title, setTitle] = React.useState(widget.title);
  const [greeting, setGreeting] = React.useState(widget.greeting);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    setEnabled(widget.enabled);
    setOrigins(savedOrigins);
    setTitle(widget.title);
    setGreeting(widget.greeting);
  }, [widget.enabled, savedOrigins, widget.title, widget.greeting]);

  const dirty =
    enabled !== widget.enabled ||
    linesOf(origins).join("\n") !== savedOrigins ||
    title !== widget.title ||
    greeting !== widget.greeting;

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await supportApi(companyId).saveChatWidget(inbox.id, {
        enabled,
        allowedOrigins: linesOf(origins),
        title,
        greeting,
      });
      await onChanged();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the chat widget"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{inbox.name}</span>
        <Badge tone={widget.enabled ? "success" : "neutral"}>
          {widget.enabled ? "On" : "Off"}
        </Badge>
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <Checkbox
          label={`Turn on the chat widget for ${inbox.name}`}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          Turn on the chat widget
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Anyone on the sites below can write to you without signing in.
          </span>
        </span>
      </label>
      <div>
        <Textarea
          label="Sites it may appear on"
          rows={3}
          value={origins}
          placeholder="https://www.example.com"
          onChange={(event) => setOrigins(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          One per line, each with its https://. Other sites cannot embed it, and there are no
          wildcards: list each one.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Title (empty uses the inbox's sender name)"
          maxLength={SUPPORT_CHAT_LIMITS.titleChars}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          label="Greeting"
          rows={2}
          maxLength={SUPPORT_CHAT_LIMITS.greetingChars}
          placeholder={widget.defaultGreeting}
          value={greeting}
          onChange={(event) => setGreeting(event.target.value)}
        />
      </div>
      {widget.snippet && <Snippet snippet={widget.snippet} />}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <FormError message={error} className="mr-auto" />
        {saved && !dirty && <FormSuccess message="Saved" />}
        <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function Snippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
          Add this to your site, before the closing body tag
        </span>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs leading-5 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

function ChatLimits({
  companyId,
  settings,
  onSaved,
}: {
  companyId: string;
  settings: SupportSettings;
  onSaved: (settings: SupportSettings) => void;
}) {
  const [messages, setMessages] = React.useState(settings.chatMessagesPerHour);
  const [turns, setTurns] = React.useState(settings.chatAiTurnsPerDay);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const dirty =
    messages !== settings.chatMessagesPerHour || turns !== settings.chatAiTurnsPerDay;

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const { settings: next } = await supportApi(companyId).updateSettings({
        chatMessagesPerHour: messages,
        chatAiTurnsPerDay: turns,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the limits"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure
      title="Advanced"
      summary={`${settings.chatMessagesPerHour.toLocaleString()} messages an hour · ${settings.chatAiTurnsUsed.toLocaleString()} of ${settings.chatAiTurnsPerDay.toLocaleString()} AI turns used today`}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Messages an hour"
            type="number"
            min={1}
            max={SUPPORT_CHAT_MAX_MESSAGES_PER_HOUR}
            value={messages}
            onChange={(event) => setMessages(Number(event.target.value))}
          />
          <Input
            label="AI turns a day"
            type="number"
            min={0}
            max={SUPPORT_CHAT_MAX_AI_TURNS_PER_DAY}
            value={turns}
            onChange={(event) => setTurns(Number(event.target.value))}
          />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Across all your chat widgets. Past the first, visitors are asked to try again later. Past
          the second, tickets wait for a person, so an open page cannot run up your AI Model&apos;s
          bill. 0 AI turns means none.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <FormError message={error} className="mr-auto" />
          {saved && !dirty && <FormSuccess message="Saved" />}
          <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}
