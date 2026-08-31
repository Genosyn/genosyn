import React from "react";
import {
  Bot,
  Chrome,
  Globe2,
  Mailbox,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Video,
} from "lucide-react";
import { api, type RuntimeSettingsGroup, type RuntimeSettingsSnapshot } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Runtime. The operational knobs an operator used to change by editing
 * `config.ts` and restarting the container: the open-web tools, mail sync
 * pacing, meetings, the browser Genosyn drives itself, the agent's taint
 * policy / member browsers / tool discovery, containment — the circuit breaker
 * and the re-grade sweep — and the outbound network allowlist.
 *
 * Each section is one group, stored as a single JSON row in `app_settings` and
 * read through a 30s cache on the server, so a save reaches every replica
 * without a restart. Saving replaces the whole group — the form always submits
 * every value it showed — and a group with no stored row falls back to the
 * shipped defaults, which is what "Reset to defaults" puts it back to.
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

// ────────────────────────────── field model ────────────────────────────────
//
// The groups are the same kind of form several times over, so they are
// described as data rather than written out once each. A draft holds one
// entry per field keyed by its dotted path (`toolDiscovery.minCatalogueSize`
// is the only nested one): booleans stay booleans, everything else is the
// string the person is typing, so a half-entered number never rounds itself
// or reverts under the cursor.

type FieldSpec =
  | { kind: "boolean"; path: string; label: string; help?: string }
  | {
      kind: "int";
      path: string;
      label: string;
      min: number;
      max: number;
      /** Renders a live "≈ 10 MB" hint under a raw byte count. */
      bytes?: boolean;
      unit?: string;
      help?: string;
    }
  | {
      kind: "text";
      path: string;
      label: string;
      maxLength: number;
      placeholder?: string;
      mono?: boolean;
      help?: string;
    }
  | {
      /** A list, one entry per line in a textarea. The draft holds the raw
       *  text so a half-typed line never reorders or disappears mid-edit. */
      kind: "lines";
      path: string;
      label: string;
      maxEntries: number;
      maxLength: number;
      placeholder?: string;
      rows?: number;
      help?: string;
    }
  | {
      kind: "choice";
      path: string;
      label: string;
      options: { value: string; label: string }[];
      /** Present when the stored value is not a string — `headless` is
       *  `"auto" | boolean`, so the option values round-trip through these. */
      toValue?: (raw: string) => unknown;
      fromValue?: (value: unknown) => string;
      help?: string;
    };

type DraftValue = string | boolean;
type Draft = Record<string, DraftValue>;

type GroupSpec = {
  group: RuntimeSettingsGroup;
  title: string;
  icon: React.ReactNode;
  blurb: string;
  fields: FieldSpec[];
};

const HEADLESS_OPTIONS = [
  { value: "auto", label: "Auto — headed when a display is available" },
  { value: "true", label: "Always headless" },
  { value: "false", label: "Always headed" },
];

const GROUPS: GroupSpec[] = [
  {
    group: "web",
    title: "Web tools",
    icon: <Globe2 size={16} className="text-indigo-500" />,
    blurb: "The open-web tools an AI Employee uses to search, read a page, and download a file.",
    fields: [
      {
        kind: "boolean",
        path: "enabled",
        label: "Web tools enabled",
        help: "When off the tools stay visible and refuse with an explanation, so an employee can tell the person why rather than silently losing a capability.",
      },
      {
        kind: "choice",
        path: "searchProvider",
        label: "Search provider",
        options: [
          { value: "duckduckgo", label: "DuckDuckGo (no API key)" },
          { value: "disabled", label: "Disabled" },
        ],
        help: "Disabled turns search off and leaves page fetch and download working.",
      },
      { kind: "int", path: "maxSearchResults", label: "Max search results", min: 1, max: 50 },
      {
        kind: "int",
        path: "maxDocumentBytes",
        label: "Max document size",
        min: 1024,
        max: 200 * 1024 * 1024,
        bytes: true,
        help: "Ceiling on what one page fetch or download may pull.",
      },
      {
        kind: "int",
        path: "maxTextChars",
        label: "Max extracted text",
        min: 500,
        max: 1_000_000,
        unit: "characters",
        help: "Characters of page text handed to the model per fetch.",
      },
    ],
  },
  {
    group: "mail",
    title: "Mail sync",
    icon: <Mailbox size={16} className="text-indigo-500" />,
    blurb: "How hard the Gmail mailbox mirror works — the steady poll and the first import.",
    fields: [
      {
        kind: "int",
        path: "syncIntervalSec",
        label: "Sync interval",
        min: 10,
        max: 86_400,
        unit: "seconds",
        help: "How often an up-to-date mailbox re-checks for new mail.",
      },
      {
        kind: "int",
        path: "backfillThreadsPerPass",
        label: "Backfill threads per pass",
        min: 1,
        max: 5_000,
      },
      {
        kind: "int",
        path: "backfillPassSeconds",
        label: "Backfill pass budget",
        min: 1,
        max: 600,
        unit: "seconds",
        help: "A backfill pass stops at whichever of these two limits it reaches first.",
      },
      {
        kind: "int",
        path: "backfillDays",
        label: "Backfill window",
        min: 0,
        max: 36_500,
        unit: "days",
        help: "Only import mail newer than this on the first pass. 0 imports the whole mailbox.",
      },
    ],
  },
  {
    group: "meetings",
    title: "Meetings",
    icon: <Video size={16} className="text-indigo-500" />,
    blurb: "The calendar mirror and the transcription of recorded meetings.",
    fields: [
      {
        kind: "boolean",
        path: "enabled",
        label: "Meetings enabled",
        help: "Off leaves connected calendars in place and stops the sync heartbeat. Takes effect on the next tick — no restart.",
      },
      {
        kind: "int",
        path: "syncIntervalSeconds",
        label: "Calendar sync interval",
        min: 60,
        max: 86_400,
        unit: "seconds",
      },
      {
        kind: "text",
        path: "transcriptionModel",
        label: "Transcription model",
        maxLength: 200,
        placeholder: "whisper-1",
        mono: true,
        help: "The model name sent to the transcription endpoint.",
      },
      {
        kind: "int",
        path: "maxRecordingBytes",
        label: "Max recording size",
        min: 1024,
        max: 100 * 1024 * 1024,
        bytes: true,
        help: "Uploads above this are refused. The hard ceiling is 100 MB.",
      },
    ],
  },
  {
    group: "browser",
    title: "Browser",
    icon: <Chrome size={16} className="text-indigo-500" />,
    blurb:
      "The Chrome an AI Employee drives inside Genosyn's own container. A Member browser runs on that person's computer and is not affected.",
    fields: [
      {
        kind: "text",
        path: "executablePath",
        label: "Executable path",
        maxLength: 1024,
        placeholder: "/usr/bin/chromium",
        mono: true,
        help: "Absolute path to the Chrome or Chromium binary. Leave empty to autodetect.",
      },
      {
        kind: "choice",
        path: "headless",
        label: "Headless mode",
        options: HEADLESS_OPTIONS,
        toValue: (raw) => (raw === "auto" ? "auto" : raw === "true"),
        fromValue: (value) => (value === "auto" ? "auto" : value === true ? "true" : "false"),
      },
      {
        kind: "text",
        path: "locale",
        label: "Locale",
        maxLength: 64,
        placeholder: "en-US",
        help: "Reported to sites. Empty inherits Chrome's own.",
      },
      {
        kind: "text",
        path: "timezone",
        label: "Timezone",
        maxLength: 64,
        placeholder: "Europe/London",
        mono: true,
        help: "An IANA timezone name. Empty inherits Chrome's own.",
      },
      {
        kind: "boolean",
        path: "humanize",
        label: "Humanize input",
        help: "Type and click the way a person does. Leave on for sites with anti-bot defenses.",
      },
    ],
  },
  {
    group: "agent",
    title: "Agent",
    icon: <Bot size={16} className="text-indigo-500" />,
    blurb: "Runtime knobs on the agent loop that are not part of the boot security posture.",
    fields: [
      {
        kind: "choice",
        path: "taintPolicy",
        label: "Taint policy",
        options: [
          { value: "web", label: "Web — mark a turn tainted once it ingests web content" },
          { value: "off", label: "Off — no taint escalation" },
        ],
        help: "A tainted turn has read something the company did not write, so its privileged actions meet a human gate.",
      },
      {
        kind: "boolean",
        path: "memberBrowsersEnabled",
        label: "Member browsers enabled",
        help: "Let a Member connect a Chrome from their own computer for employees to drive. Multi-tenant installs force this off regardless of what is saved here.",
      },
      {
        kind: "boolean",
        path: "toolDiscovery.enabled",
        label: "Tool discovery enabled",
        help: "Show the model a working set and let it reach the rest through find_tools / call_tool, instead of every schema on every step.",
      },
      {
        kind: "int",
        path: "toolDiscovery.minCatalogueSize",
        label: "Minimum catalogue size",
        min: 0,
        max: 10_000,
        unit: "tools",
        help: "Below this many tools the whole catalogue is shown and discovery does not kick in.",
      },
    ],
  },
  {
    group: "containment",
    title: "Containment",
    icon: <ShieldAlert size={16} className="text-indigo-500" />,
    blurb:
      "When Genosyn stops a Routine by itself, and how it finishes grading Runs the runner never got to.",
    fields: [
      {
        kind: "int",
        path: "routineBreakerThreshold",
        label: "Routine breaker threshold",
        min: 0,
        max: 1_000,
        unit: "consecutive bad Runs",
        help: "After this many consecutive failed or off-goal Runs, the breaker stands the Routine down and an admin has to return it to work. 0 turns the breaker off, so a permanently broken Routine keeps firing on every slot.",
      },
      {
        kind: "int",
        path: "regradeAfterMinutes",
        label: "Re-grade after",
        min: 1,
        max: 10_080,
        unit: "minutes",
        help: "How long a finished Run may sit without a verdict before the sweep grades it. Long enough that it never races the check the runner is already running.",
      },
      {
        kind: "int",
        path: "regradePerPass",
        label: "Re-grades per pass",
        min: 0,
        max: 200,
        unit: "Runs",
        help: "Ceiling per heartbeat pass. Each re-grade spends a model turn, so this is the knob to lower during an incident.",
      },
    ],
  },
  {
    group: "network",
    title: "Outbound network",
    icon: <Network size={16} className="text-indigo-500" />,
    blurb:
      "Hosts Genosyn may reach even though they sit on a private network, such as a self-hosted Forgejo or a model endpoint on the LAN.",
    fields: [
      {
        kind: "lines",
        path: "privateHostAllowlist",
        label: "Private host allowlist",
        maxEntries: 100,
        maxLength: 253,
        rows: 5,
        placeholder: "git.internal\n10.0.0.5",
        help: "One hostname or IP literal per line, matched exactly. Everything Genosyn fetches otherwise has to resolve to a public address, so a host listed here is exempt from the check that would refuse it — which is what makes a self-hosted Forgejo or a local model endpoint reachable at all. That same exemption puts an internal service one connection form away from anything a Run can be talked into fetching, so the list is empty by default: add a host only when you mean employees to reach it. Hosts set in config.ts stay in force as well, and a multi-tenant install ignores this list entirely.",
      },
    ],
  },
];

// ─────────────────────────── draft ⇄ value plumbing ────────────────────────

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
}

function seedDraft(fields: FieldSpec[], value: unknown): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const raw = readPath(value, field.path);
    if (field.kind === "boolean") draft[field.path] = Boolean(raw);
    else if (field.kind === "int") draft[field.path] = String(raw ?? "");
    else if (field.kind === "lines") draft[field.path] = Array.isArray(raw) ? raw.join("\n") : "";
    else if (field.kind === "choice") {
      draft[field.path] = field.fromValue ? field.fromValue(raw) : String(raw ?? "");
    } else draft[field.path] = String(raw ?? "");
  }
  return draft;
}

type BuildResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Turn a draft back into the group payload, reporting the first bad field. */
function buildValue(fields: FieldSpec[], draft: Draft): BuildResult {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = draft[field.path];
    if (field.kind === "boolean") {
      writePath(out, field.path, Boolean(raw));
      continue;
    }
    if (field.kind === "int") {
      const parsed = Number(String(raw).trim());
      if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
        return {
          ok: false,
          error: `${field.label} must be a whole number between ${field.min.toLocaleString()} and ${field.max.toLocaleString()}.`,
        };
      }
      writePath(out, field.path, parsed);
      continue;
    }
    if (field.kind === "lines") {
      // Normalized here as well as on the server, so the form shows the person
      // the same list the next GET will hand back rather than silently
      // rewriting what they typed after the save.
      const entries: string[] = [];
      for (const line of String(raw).split("\n")) {
        const entry = line.trim().toLowerCase().replace(/\.$/, "");
        if (!entry) continue;
        if (entry.length > field.maxLength) {
          return {
            ok: false,
            error: `Each entry in ${field.label.toLowerCase()} must be ${field.maxLength} characters or fewer.`,
          };
        }
        if (!entries.includes(entry)) entries.push(entry);
      }
      if (entries.length > field.maxEntries) {
        return {
          ok: false,
          error: `${field.label} takes at most ${field.maxEntries.toLocaleString()} entries.`,
        };
      }
      writePath(out, field.path, entries);
      continue;
    }
    if (field.kind === "choice") {
      const text = String(raw);
      writePath(out, field.path, field.toValue ? field.toValue(text) : text);
      continue;
    }
    const text = String(raw);
    if (text.length > field.maxLength) {
      return { ok: false, error: `${field.label} must be ${field.maxLength} characters or fewer.` };
    }
    writePath(out, field.path, text);
  }
  return { ok: true, value: out };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

/** Byte counts are edited raw so nothing rounds; this is the readable echo. */
function humanBytes(raw: DraftValue): string | null {
  const bytes = Number(String(raw).trim());
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 * 1024)
    return `≈ ${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `≈ ${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

// ──────────────────────────────── the page ─────────────────────────────────

export function AdminRuntime() {
  const [data, setData] = React.useState<RuntimeSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setData(await api.get<RuntimeSettingsSnapshot>("/api/admin/runtime-settings"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the runtime settings"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return (
      <>
        <TopBar title="Runtime" />
        {loadError ? (
          <FormError message={loadError} />
        ) : (
          <Card>
            <CardBody>
              <Spinner />
            </CardBody>
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Runtime"
        right={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FormError message={loadError} />

        <Card>
          <CardBody>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Operational settings for the whole installation. They are stored in the database, not
              in{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                config.ts
              </code>
              , so a change applies within about 30 seconds on every replica with no restart. Each
              section saves on its own; a section still on its shipped values can be left alone.
            </p>
          </CardBody>
        </Card>

        {GROUPS.map((spec) => (
          <GroupCard
            key={spec.group}
            spec={spec}
            value={data[spec.group]}
            overridden={data.overridden[spec.group]}
            onSnapshot={setData}
          />
        ))}
      </div>
    </>
  );
}

function GroupCard({
  spec,
  value,
  overridden,
  onSnapshot,
}: {
  spec: GroupSpec;
  value: unknown;
  overridden: boolean;
  onSnapshot: (next: RuntimeSettingsSnapshot) => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => seedDraft(spec.fields, value));
  const [saving, setSaving] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialog = useDialog();

  // Re-seed only when *this* group's values actually changed. A save on one
  // card replaces the whole snapshot object, and re-seeding on identity would
  // throw away edits someone had in progress in another card.
  const serialized = JSON.stringify(value);
  const latest = React.useRef({ fields: spec.fields, value });
  latest.current = { fields: spec.fields, value };
  React.useEffect(() => {
    setDraft(seedDraft(latest.current.fields, latest.current.value));
    setError(null);
  }, [serialized]);

  const built = buildValue(spec.fields, draft);
  const dirty = !built.ok || !sameValue(built.value, value);
  const busy = saving || resetting;

  const save = async () => {
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      onSnapshot(
        await api.put<RuntimeSettingsSnapshot>(
          `/api/admin/runtime-settings/${spec.group}`,
          built.value,
        ),
      );
    } catch (err) {
      setError(errorMessage(err, `Could not save the ${spec.title.toLowerCase()} settings`));
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = async () => {
    const ok = await dialog.confirm({
      title: `Reset ${spec.title.toLowerCase()} to defaults?`,
      message:
        "This deletes the stored values for this section and puts it back on the shipped defaults.",
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    setError(null);
    setResetting(true);
    try {
      onSnapshot(
        await api.del<RuntimeSettingsSnapshot>(`/api/admin/runtime-settings/${spec.group}`),
      );
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t reset ${spec.title.toLowerCase()}` });
    } finally {
      setResetting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 shrink-0">{spec.icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{spec.title}</h2>
                <StateBadge overridden={overridden} />
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{spec.blurb}</p>
            </div>
          </div>
          {overridden && (
            <Button size="sm" variant="ghost" onClick={resetToDefaults} disabled={busy}>
              <RotateCcw size={12} />
              {resetting ? "Resetting…" : "Reset to defaults"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardBody>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty) void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {spec.fields.map((field) => (
              <Field
                key={field.path}
                group={spec.group}
                field={field}
                value={draft[field.path]}
                disabled={busy}
                onChange={(next) => setDraft({ ...draft, [field.path]: next })}
              />
            ))}
          </div>

          <FormError message={error} />

          <div className="flex justify-end pt-1">
            <Button type="submit" size="sm" disabled={!dirty || busy}>
              <Save size={14} /> {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function StateBadge({ overridden }: { overridden: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        overridden
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
      )}
    >
      {overridden ? "Customized" : "Defaults"}
    </span>
  );
}

function Field({
  group,
  field,
  value,
  disabled,
  onChange,
}: {
  group: RuntimeSettingsGroup;
  field: FieldSpec;
  value: DraftValue;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
}) {
  const id = `runtime-${group}-${field.path.replace(/\./g, "-")}`;

  if (field.kind === "boolean") {
    return (
      <div className="sm:col-span-2">
        <label className="inline-flex items-start gap-2 text-sm" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="font-medium">{field.label}</span>
        </label>
        {field.help && <FieldHelp>{field.help}</FieldHelp>}
      </div>
    );
  }

  if (field.kind === "choice") {
    return (
      <div className="sm:col-span-2">
        <label className={LABEL_CLASS} htmlFor={id}>
          {field.label}
        </label>
        <Select
          id={id}
          className={FIELD_CLASS}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {field.help && <FieldHelp>{field.help}</FieldHelp>}
      </div>
    );
  }

  if (field.kind === "lines") {
    return (
      <div className="sm:col-span-2">
        <label className={LABEL_CLASS} htmlFor={id}>
          {field.label}
        </label>
        <textarea
          id={id}
          className={TEXTAREA_CLASS}
          rows={field.rows ?? 4}
          spellCheck={false}
          placeholder={field.placeholder}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <FieldHelp>
          {field.help ? `${field.help} ` : ""}
          One per line, up to {field.maxEntries.toLocaleString()} entries of{" "}
          {field.maxLength.toLocaleString()} characters each. Empty means none.
        </FieldHelp>
      </div>
    );
  }

  if (field.kind === "int") {
    const echo = field.bytes ? humanBytes(value) : null;
    return (
      <div>
        <label className={LABEL_CLASS} htmlFor={id}>
          {field.label}
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className={FIELD_CLASS}
          min={field.min}
          max={field.max}
          step={1}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <FieldHelp>
          {field.help ? `${field.help} ` : ""}
          {field.min.toLocaleString()}–{field.max.toLocaleString()}
          {field.unit ? ` ${field.unit}` : field.bytes ? " bytes" : ""}
          {echo ? ` · ${echo}` : ""}
        </FieldHelp>
      </div>
    );
  }

  return (
    <div>
      <label className={LABEL_CLASS} htmlFor={id}>
        {field.label}
      </label>
      <input
        id={id}
        className={clsx(FIELD_CLASS, field.mono && "font-mono")}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.help && <FieldHelp>{field.help}</FieldHelp>}
    </div>
  );
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{children}</p>;
}
