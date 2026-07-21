import fs from "node:fs";
import path from "node:path";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Backup } from "../db/entities/Backup.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { config } from "../../config.js";
import { dataRoot } from "./paths.js";
import { getBackupSchedule } from "./backups.js";
import { getEffectiveGlobalSmtp } from "./globalEmailTransport.js";
import { getPublicUrl } from "./publicUrl.js";

/**
 * Instance Health — an install-wide "is the deployment itself healthy?" probe,
 * distinct from the company-scoped System Health roll-up in
 * `services/systemHealth.ts`. Where System Health watches a company's routines,
 * models, approvals and integrations, Instance Health tests the substrate every
 * company shares: the database connection, pending migrations, the writable
 * data directory, the backup story, and the Node runtime.
 *
 * Read-only. Powers the Admin → Instance Health page and the Admin → Overview
 * dashboard; both call {@link getInstanceHealthReport} so the two never
 * disagree. Not company-scoped — see `routes/admin.ts` for the auth rationale.
 */

export type InstanceSeverity = "ok" | "warn" | "error";

/** A single labelled fact rendered as a key/value row under a check. */
export type InstanceFact = { label: string; value: string; mono?: boolean };

export type InstanceCheck = {
  /** Stable key, e.g. "database". */
  id: string;
  title: string;
  /** What this check probes, in one sentence. */
  description: string;
  severity: InstanceSeverity;
  /** One-line current status. */
  summary: string;
  /** Supporting key/value facts. */
  facts: InstanceFact[];
};

/** Runtime + inventory metadata surfaced on the Overview dashboard. */
export type InstanceInfo = {
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  dbDriver: "sqlite" | "postgres";
  dataDir: string;
  publicUrl: string;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  counts: { companies: number; users: number; employees: number };
};

export type InstanceHealthReport = {
  generatedAt: string;
  status: InstanceSeverity;
  issueCount: number;
  checks: InstanceCheck[];
  instance: InstanceInfo;
};

const SEVERITY_RANK: Record<InstanceSeverity, number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

function worstSeverity(severities: InstanceSeverity[]): InstanceSeverity {
  return severities.reduce<InstanceSeverity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    "ok",
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function relativeAge(from: Date, now: number): string {
  const sec = Math.round((now - from.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.round(day / 30)}mo ago`;
}

/**
 * Probe the database: run a trivial round-trip query and time it. Reports the
 * driver, connection state, and (for SQLite) the on-disk file size.
 */
async function checkDatabase(): Promise<InstanceCheck> {
  const facts: InstanceFact[] = [
    { label: "Driver", value: config.db.driver },
  ];
  if (!AppDataSource.isInitialized) {
    return {
      id: "database",
      title: "Database connection",
      description: "The primary datastore every company reads and writes.",
      severity: "error",
      summary: "The database connection is not initialized.",
      facts: [...facts, { label: "Connected", value: "No" }],
    };
  }
  const startedAt = Date.now();
  try {
    await AppDataSource.query("SELECT 1");
    const latency = Date.now() - startedAt;
    facts.push({ label: "Connected", value: "Yes" });
    facts.push({ label: "Round-trip", value: `${latency} ms` });
    if (config.db.driver === "sqlite") {
      const abs = path.resolve(config.db.sqlitePath);
      facts.push({ label: "File", value: abs, mono: true });
      if (fs.existsSync(abs)) {
        facts.push({ label: "Size", value: formatBytes(fs.statSync(abs).size) });
      }
    } else if (config.db.postgresUrl) {
      // Never surface credentials — just the host so operators can confirm
      // which server they're pointed at.
      try {
        facts.push({ label: "Host", value: new URL(config.db.postgresUrl).host });
      } catch {
        // malformed url — skip the host fact rather than throw
      }
    }
    return {
      id: "database",
      title: "Database connection",
      description: "The primary datastore every company reads and writes.",
      severity: "ok",
      summary: `Connected — a test query returned in ${latency} ms.`,
      facts,
    };
  } catch (err) {
    return {
      id: "database",
      title: "Database connection",
      description: "The primary datastore every company reads and writes.",
      severity: "error",
      summary: `The database did not respond: ${(err as Error).message}`,
      facts: [...facts, { label: "Connected", value: "No" }],
    };
  }
}

/**
 * Report whether any schema migrations are still pending. Boot runs migrations
 * automatically, so a healthy instance has none — a pending count usually means
 * a boot-time migration failure that needs a look.
 */
async function checkMigrations(): Promise<InstanceCheck> {
  const total = AppDataSource.migrations.length;
  try {
    const pending = await AppDataSource.showMigrations();
    return {
      id: "migrations",
      title: "Schema migrations",
      description:
        "Pending TypeORM migrations. Boot applies these automatically; anything left pending points at a failed migration.",
      severity: pending ? "warn" : "ok",
      summary: pending
        ? "Migrations are pending — the schema may be out of date."
        : "The schema is up to date.",
      facts: [
        { label: "Total migrations", value: String(total) },
        { label: "Pending", value: pending ? "Yes" : "None" },
      ],
    };
  } catch (err) {
    return {
      id: "migrations",
      title: "Schema migrations",
      description:
        "Pending TypeORM migrations. Boot applies these automatically; anything left pending points at a failed migration.",
      severity: "warn",
      summary: `Could not determine migration state: ${(err as Error).message}`,
      facts: [{ label: "Total migrations", value: String(total) }],
    };
  }
}

/**
 * Confirm the data directory exists and is writable. Everything user-generated
 * — the SQLite file, per-employee credentials, uploads, backups — lives here,
 * so a read-only mount is a hard failure.
 */
function checkDataDirectory(): InstanceCheck {
  const root = dataRoot();
  const facts: InstanceFact[] = [{ label: "Path", value: root, mono: true }];
  const probe = path.join(root, `.health-check-${process.pid}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    facts.push({ label: "Writable", value: "Yes" });
    return {
      id: "data_directory",
      title: "Data directory",
      description:
        "The on-disk home for the database, uploads, credentials, and backups.",
      severity: "ok",
      summary: "The data directory exists and is writable.",
      facts,
    };
  } catch (err) {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {
      // best-effort cleanup
    }
    return {
      id: "data_directory",
      title: "Data directory",
      description:
        "The on-disk home for the database, uploads, credentials, and backups.",
      severity: "error",
      summary: `The data directory is not writable: ${(err as Error).message}`,
      facts: [...facts, { label: "Writable", value: "No" }],
    };
  }
}

/**
 * Summarize the backup story: is a schedule enabled, when did the last one
 * succeed, and did any recent run fail? A never-backed-up instance with no
 * schedule earns a warning — the operator should know their data isn't covered.
 */
async function checkBackups(now: number): Promise<InstanceCheck> {
  const repo = AppDataSource.getRepository(Backup);
  const [schedule, recent] = await Promise.all([
    getBackupSchedule(),
    repo.find({ order: { createdAt: "DESC" }, take: 50 }),
  ]);

  const total = recent.length;
  const lastCompleted = recent.find((b) => b.status === "completed") ?? null;
  const lastFailed = recent.find((b) => b.status === "failed") ?? null;

  const facts: InstanceFact[] = [
    {
      label: "Schedule",
      value: schedule.enabled
        ? `${schedule.frequency} at ${schedule.hour.toString().padStart(2, "0")}:00`
        : "Disabled",
    },
    { label: "Archives on record", value: String(total) },
  ];
  if (lastCompleted?.completedAt) {
    facts.push({
      label: "Last successful",
      value: `${relativeAge(new Date(lastCompleted.completedAt), now)} · ${formatBytes(lastCompleted.sizeBytes)}`,
    });
  } else {
    facts.push({ label: "Last successful", value: "Never" });
  }

  let severity: InstanceSeverity = "ok";
  let summary = "Backups are healthy.";
  if (!lastCompleted && !schedule.enabled) {
    severity = "warn";
    summary =
      "No backup has ever completed and no schedule is enabled — this instance is not protected.";
  } else if (!lastCompleted) {
    severity = "warn";
    summary =
      "A schedule is enabled but no backup has completed yet.";
  } else if (
    lastFailed &&
    (!lastCompleted.completedAt ||
      new Date(lastFailed.createdAt).getTime() >
        new Date(lastCompleted.completedAt).getTime())
  ) {
    severity = "warn";
    summary = "The most recent backup attempt failed.";
    facts.push({
      label: "Last error",
      value: lastFailed.errorMessage || "Unknown error",
    });
  } else if (!schedule.enabled) {
    summary =
      "Backups exist, but no recurring schedule is enabled — new data isn't being archived automatically.";
  } else {
    summary = "A schedule is enabled and the last backup succeeded.";
  }

  return {
    id: "backups",
    title: "Backups",
    description:
      "Install-wide archives of the entire data directory, plus the recurring schedule.",
    severity,
    summary,
    facts,
  };
}

/**
 * The global SMTP transport system-level emails (password resets, invites, …)
 * fall back to when a company has no EmailProvider row of its own. Resolved
 * from the Admin → Email transport override first, then the `config.ts` block.
 *
 * When nothing is configured, sends silently log to the console and never
 * reach a mailbox — a real deployment can't complete a password reset in that
 * state, so we surface it as a warning rather than pretending it's healthy.
 */
async function checkEmailTransport(): Promise<InstanceCheck> {
  const eff = await getEffectiveGlobalSmtp();
  const sourceLabel =
    eff.source === "database"
      ? "Admin dashboard"
      : eff.source === "config"
        ? "config.ts"
        : "None";
  return {
    id: "email_transport",
    title: "Email transport",
    description:
      "The global SMTP transport used for system-level sends (password resets, invites) when a company has no email provider of its own.",
    severity: eff.configured ? "ok" : "warn",
    summary: eff.configured
      ? `Global SMTP is configured via ${
          eff.source === "database" ? "the admin dashboard" : "config.ts"
        }.`
      : "No global SMTP configured — system emails (password resets, invites) log to the console and are not delivered. Configure it under Admin → Email transport.",
    facts: [
      {
        label: "Global SMTP",
        value: eff.configured ? eff.settings.host : "Not configured",
        mono: eff.configured,
      },
      { label: "Source", value: sourceLabel },
      { label: "From", value: eff.settings.from, mono: true },
    ],
  };
}

/**
 * Informational: whether the Web Push VAPID keypair has been minted. We read
 * the persisted setting directly rather than the mint-on-demand loader so the
 * health check stays side-effect free.
 */
async function checkWebPush(): Promise<InstanceCheck> {
  const repo = AppDataSource.getRepository(AppSetting);
  const pub = await repo.findOneBy({ key: "push.vapid.publicKey" });
  const configured = Boolean(pub?.value);
  return {
    id: "web_push",
    title: "Web Push",
    description:
      "The VAPID keypair that signs browser push notifications for the PWA. Auto-generated on first use.",
    severity: "ok",
    summary: configured
      ? "A VAPID keypair is present — push notifications can be delivered."
      : "No VAPID keypair yet — one is minted automatically the first time push is used.",
    facts: [{ label: "VAPID keys", value: configured ? "Present" : "Not yet minted" }],
  };
}

async function gatherInstanceInfo(): Promise<InstanceInfo> {
  const mem = process.memoryUsage();
  const [companies, users, employees] = await Promise.all([
    AppDataSource.getRepository(Company).count(),
    AppDataSource.getRepository(User).count(),
    AppDataSource.getRepository(AIEmployee).count(),
  ]);
  return {
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    uptimeSeconds: process.uptime(),
    dbDriver: config.db.driver,
    dataDir: dataRoot(),
    publicUrl: getPublicUrl(),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
    counts: { companies, users, employees },
  };
}

export async function getInstanceHealthReport(): Promise<InstanceHealthReport> {
  const now = Date.now();
  // Database first and on its own — every other check assumes a live
  // connection, so if it's down we still want the rest to run and report
  // their own state rather than throw.
  const [database, migrations, backups, emailTransport, webPush, instance] =
    await Promise.all([
      checkDatabase(),
      checkMigrations(),
      checkBackups(now),
      checkEmailTransport(),
      checkWebPush(),
      gatherInstanceInfo(),
    ]);

  const checks: InstanceCheck[] = [
    database,
    migrations,
    checkDataDirectory(),
    backups,
    emailTransport,
    webPush,
  ];

  return {
    generatedAt: new Date().toISOString(),
    status: worstSeverity(checks.map((c) => c.severity)),
    issueCount: checks.filter((c) => c.severity !== "ok").length,
    checks,
    instance,
  };
}
