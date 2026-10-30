import React from "react";
import {
  Bot,
  Chrome,
  CloudOff,
  Globe2,
  Landmark,
  Mailbox,
  MailCheck,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Video,
} from "lucide-react";
import {
  api,
  type HostedSignInReport,
  type RuntimeSettingsGroup,
  type RuntimeSettingsSnapshot,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Disclosure } from "../components/ui/Disclosure";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";
import {
  customizedPaths,
  describeCustomized,
  readPath,
  sameValue,
} from "../lib/runtimeSettingsSummary";

/**
 * Admin → Runtime. The operational knobs an operator used to change by editing
 * `config.ts` and restarting the container: the open-web tools, mail sync
 * pacing, meetings, the browser Genosyn drives itself, the agent's taint
 * policy / member browsers / tool discovery, the re-grade sweep, and the
 * outbound network allowlist — plus how often Banking syncs connected bank
 * accounts and cards.
 *
 * Each section is one group, stored as a single JSON row in `app_settings` and
 * read through a 30s cache on the server, so a save reaches every replica
 * without a restart. Saving replaces the whole group — the form always submits
 * every value it showed — and a group with no stored row falls back to the
 * shipped defaults, which is what "Reset to defaults" puts it back to.
 *
 * Nearly every install leaves nearly every section alone, so each one is a
 * single collapsed line saying "Defaults" or how many values were changed; the
 * form, Save and Reset appear when it is opened. The rare field most installs
 * never touch (`advanced`) sits behind its own Advanced disclosure inside its
 * section.
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

type FieldVariant =
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

type FieldSpec = FieldVariant & {
  /**
   * Tucked behind the section's own Advanced disclosure. For a setting that
   * almost nobody has a reason to change, and that is risky to change blindly.
   */
  advanced?: boolean;
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
          { value: "searxng", label: "SearXNG (self-hosted)" },
          { value: "disabled", label: "Disabled" },
        ],
        help: "DuckDuckGo can start challenging a busy server, which stops search for a while. SearXNG asks several engines from your own instance. Disabled turns search off and leaves page fetch and download working.",
      },
      {
        kind: "text",
        path: "searxngUrl",
        label: "SearXNG URL",
        maxLength: 2048,
        placeholder: "http://searxng:8080",
        mono: true,
        help: "Used when the provider is SearXNG. Enable the json format under search.formats in its settings.yml. A private address must also be on the private host allow list under Network.",
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
    group: "oauth",
    title: "Hosted sign-in",
    icon: <Mailbox size={16} className="text-indigo-500" />,
    blurb: "Genosyn Connect signs this installation in to OAuth Integrations such as Gmail, so nobody has to register an OAuth app first. An app registered at Admin → Integrations, or a client supplied on a Connection, is used instead whenever there is one. This does not change how Members log into Genosyn.",
    fields: [
      {
        kind: "boolean",
        path: "hostedSignInEnabled",
        label: "Use Genosyn Connect",
        help: "Sign in through the service below whenever no OAuth app is registered here for an Integration it supports. Turning this off stops new sign-ins through it; Connections it already made keep renewing through the service that issued them.",
      },
      {
        kind: "text",
        path: "hostedSignInUrl",
        label: "Sign-in service URL",
        advanced: true,
        maxLength: 2048,
        placeholder: "https://connect.genosyn.com",
        mono: true,
        help: "Change this only to a Genosyn Connect you run yourself or trust with Integration sign-ins and token renewal. Your data — mail, files, events — goes directly between this installation and the provider, never through the service. Use an HTTPS origin with no path; HTTP is allowed on localhost for development.",
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
    group: "banking",
    title: "Bank sync",
    icon: <Landmark size={16} className="text-indigo-500" />,
    blurb:
      "How often Finance → Banking brings in new transactions from the Brex, Mercury, Ramp, Wise and Stripe accounts each company connected. CSV accounts are imported by hand.",
    fields: [
      {
        kind: "boolean",
        path: "syncEnabled",
        label: "Sync bank accounts and cards automatically",
        help: "Off stops the background sync on this server. Each account's Sync now still works. Takes effect on the next tick — no restart.",
      },
      {
        kind: "int",
        path: "syncIntervalMinutes",
        label: "Sync every",
        min: 5,
        max: 1_440,
        unit: "minutes",
        help: "How often an account that synced fine asks its provider for new transactions. One that failed tries again sooner when the provider was only busy, and backs off when the token or Connection needs a person.",
      },
    ],
  },
  {
    group: "emailVerification",
    title: "Email verification",
    icon: <MailCheck size={16} className="text-indigo-500" />,
    blurb:
      "The in-house email finder and verifier an AI Employee uses to find and check a Contact's address, instead of a paid service. Syntax, MX and classification checks always run; the SMTP callout below is what confirms the mailbox itself.",
    fields: [
      {
        kind: "boolean",
        path: "enabled",
        label: "Email verification enabled",
        help: "When off, the verify and find tools stay visible and refuse with an explanation, so an employee can say why.",
      },
      {
        kind: "boolean",
        path: "smtpProbe",
        label: "Confirm mailboxes over SMTP",
        help: "Opens the mail-server conversation up to the recipient check to confirm a mailbox exists. This makes outbound connections on port 25 and uses your sending reputation, and many hosted networks block port 25 — turn it off to rely on syntax, MX and pattern ranking alone. Always off on multi-tenant installs.",
      },
      {
        kind: "text",
        path: "probeFromAddress",
        label: "Probe sender address",
        advanced: true,
        maxLength: 320,
        placeholder: "verify@yourdomain.com",
        mono: true,
        help: "The MAIL FROM used in a check. Leave blank to send the standard null sender. An address on a domain you control, with matching reverse DNS, is least likely to be blocked.",
      },
      {
        kind: "int",
        path: "probeTimeoutMs",
        label: "Probe timeout",
        advanced: true,
        min: 1_000,
        max: 30_000,
        unit: "ms",
        help: "How long to wait on one mail server before giving up and reporting the mailbox as unconfirmed.",
      },
      {
        kind: "int",
        path: "maxCandidates",
        label: "Max patterns per lookup",
        advanced: true,
        min: 1,
        max: 25,
        help: "How many name patterns (first.last, flast, …) the finder tries for one person before stopping.",
      },
    ],
  },
  {
    group: "modelAvailability",
    title: "Unavailable AI Models",
    icon: <CloudOff size={16} className="text-indigo-500" />,
    blurb:
      "When an AI Model's service can't be reached, fails, is overloaded or keeps every key rate-limited, its work waits instead of failing: Runs pause, chat messages wait to be answered, and everything carries on by itself once a check finds the model answering again.",
    fields: [
      {
        kind: "int",
        path: "failureThreshold",
        label: "Mark unavailable after",
        min: 1,
        max: 20,
        unit: "failures in a row",
        help: "Requests in a row that must fail with a server error, an overload or a timeout before the model counts as unavailable. One refused connection or unknown host is always enough, and so is a piece of work that ran out of retries.",
      },
      {
        kind: "int",
        path: "firstCheckSeconds",
        label: "First check after",
        min: 5,
        max: 600,
        unit: "seconds",
        help: "How soon a cheap check asks the model again once it is unavailable. Each check that finds it still down doubles the wait, with a little jitter.",
      },
      {
        kind: "int",
        path: "maxCheckIntervalMinutes",
        label: "Longest wait between checks",
        advanced: true,
        min: 1,
        max: 60,
        unit: "minutes",
        help: "The doubling stops here. A retry-after the model's service asked for is honoured up to an hour. Owners and admins can press Check now on the AI Model's card at any time.",
      },
      {
        kind: "int",
        path: "resumeIntervalSeconds",
        label: "Start waiting Runs every",
        advanced: true,
        min: 0,
        max: 300,
        unit: "seconds",
        help: "Once a model is back, the Runs that waited start one at a time, this far apart, for ten minutes — paused Runs first — so they don't all land on it at once. 0 starts them together.",
      },
    ],
  },
  {
    group: "browser",
    title: "Browser",
    icon: <Chrome size={16} className="text-indigo-500" />,
    blurb:
      "The Chrome an AI Employee drives inside Genosyn's own container, and how long Routine browser recordings are kept. A Member browser runs on that person's computer; only the recording window applies to it.",
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
        help: "Type and click the way a person does. Leave on for sites with anti-bot defenses. The Google Meet notetaker needs it: Meet refuses a guest that does not.",
      },
      {
        kind: "int",
        path: "recordingRetentionDays",
        label: "Keep browser recordings",
        min: 0,
        max: 3650,
        unit: "days",
        help: "Routine browser recordings, from Genosyn's browser and Member browsers alike, are deleted this many days after they finish. The Run and its log stay. 0 keeps them forever.",
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
        kind: "int",
        path: "maxConcurrentTurnsPerCompany",
        label: "Concurrent AI turns per company",
        min: 1,
        max: 100,
        unit: "turns",
        help: "Shared SaaS only. Limits simultaneous AI work across every replica, including delegated work. Additional requests receive a busy message and can be retried later.",
      },
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
      "How Genosyn finishes grading Runs the runner never got to.",
    fields: [
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
  const [refreshing, setRefreshing] = React.useState(false);

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

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <TopBar
        title="Runtime"
        right={
          <Button variant="secondary" onClick={refresh} loading={refreshing}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FormError message={loadError} />

        <Card>
          <CardBody>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              How the whole installation runs. A change takes effect within about 30 seconds, with
              no restart. Each section says on its closed line whether anything in it differs from
              the defaults; open one to change it, and it saves on its own. A section still on its
              defaults can be left alone.
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

  // The collapsed line describes what the installation is running, so it counts
  // the saved values, not the draft; the Unsaved chip says when the form is
  // ahead of them.
  const customized = customizedPaths(
    spec.group,
    value,
    spec.fields.map((field) => field.path),
  );
  const customizedLabels = spec.fields
    .filter((field) => customized.includes(field.path))
    .map((field) => field.label);
  const mainFields = spec.fields.filter((field) => !field.advanced);
  const advancedFields = spec.fields.filter((field) => field.advanced);
  const advancedCustomized = advancedFields.filter((field) =>
    customized.includes(field.path),
  ).length;
  const renderField = (field: FieldSpec) => (
    <Field
      key={field.path}
      group={spec.group}
      field={field}
      value={draft[field.path]}
      disabled={busy}
      onChange={(next) => setDraft({ ...draft, [field.path]: next })}
    />
  );

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
    <Disclosure
      variant="card"
      heading="h2"
      title={
        <>
          <span className="shrink-0">{spec.icon}</span>
          <span className="min-w-0 truncate">{spec.title}</span>
          {dirty && (
            <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              Unsaved
            </span>
          )}
        </>
      }
      summary={
        <span title={customizedLabels.length > 0 ? customizedLabels.join(", ") : undefined}>
          {describeCustomized(customized.length)}
        </span>
      }
    >
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{spec.blurb}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) void save();
        }}
      >
        {spec.group === "oauth" && <HostedSignInStatus key={serialized} />}

        <div className="grid gap-3 sm:grid-cols-2">{mainFields.map(renderField)}</div>

        {advancedFields.length > 0 && (
          <Disclosure
            variant="row"
            title="Advanced"
            summary={describeCustomized(advancedCustomized)}
          >
            <div className="grid gap-3 sm:grid-cols-2">{advancedFields.map(renderField)}</div>
          </Disclosure>
        )}

        <FormError message={error} />

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {overridden ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={resetToDefaults}
              loading={resetting}
              disabled={busy}
            >
              <RotateCcw size={12} />
              {resetting ? "Resetting…" : "Reset to defaults"}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" size="sm" loading={saving} disabled={!dirty || busy}>
            <Save size={14} /> {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

/**
 * Whether Genosyn Connect answers this installation, and for which products.
 *
 * "Google sign-in is unavailable" on the Email page can mean the service was
 * turned off here, cannot be reached from this network, or does not offer
 * Gmail; this says which, beside the settings that change it. Re-mounted
 * (and so re-checked) whenever the saved settings change.
 */
function HostedSignInStatus() {
  const [report, setReport] = React.useState<HostedSignInReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    api
      .get<HostedSignInReport>("/api/admin/hosted-sign-in")
      .then((next) => {
        if (live) setReport(next);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err, "Could not check Genosyn Connect"));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) return <FormError message={error} />;
  if (!report) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" role="status">
        <Spinner size={12} /> Checking Genosyn Connect…
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-xs dark:divide-slate-800 dark:border-slate-700">
      {report.apps.map((app) => {
        const ok = app.status === "available";
        const text =
          app.status === "available"
            ? `${report.url} signs in to ${app.integrations
                .map((integration) => `${integration.name} (${integration.groups.join(", ")})`)
                .join("; ")}.`
            : app.status === "registered"
              ? "This instance's own app at Admin → Integrations is used instead."
              : app.status === "disabled"
                ? "Turned off. Only an app registered at Admin → Integrations can sign in."
                : app.status === "unreachable"
                  ? `This installation cannot reach ${report.url}. It needs outbound HTTPS to the service.`
                  : `${report.url} does not offer ${app.name} sign-in right now.`;
        return (
          <li key={app.app} className="flex items-start gap-2 px-3 py-2" role="status">
            <span
              aria-hidden
              className={clsx(
                "mt-1 inline-block h-2 w-2 shrink-0 rounded-full",
                ok || app.status === "registered" ? "bg-emerald-500" : "bg-amber-500",
              )}
            />
            <span className="min-w-0 text-slate-600 dark:text-slate-300">
              <span className="font-medium text-slate-800 dark:text-slate-100">{app.name}</span>{" "}
              — {text}
            </span>
          </li>
        );
      })}
    </ul>
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
