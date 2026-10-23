import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  BackupCopy,
  BackupDestination,
  BackupHistoryItem,
  BackupSchedule,
  BackupVerification,
} from "./api.js";
import {
  activeRun,
  advancedSummary,
  copyViews,
  describeSchedule,
  destinationHealth,
  formatAge,
  formatBytes,
  formatClock,
  formatDay,
  formatHour,
  formatNextRun,
  formatWhen,
  isBusy,
  joinNames,
  KIND_HINT,
  KIND_LABEL,
  locationSentence,
  plainReason,
  retentionSentence,
  serverPlace,
  summarizeBackups,
  type FormatOptions,
} from "./backupStatus.js";

/** Formatting pinned to one locale and zone, so every sentence is exact. */
const GB: FormatOptions = { locale: "en-GB", timeZone: "UTC" };
/** Friday 23 October 2026, 10:00 UTC. */
const NOW = new Date("2026-10-23T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function destination(overrides: Partial<BackupDestination> = {}): BackupDestination {
  return {
    id: "synology",
    name: "Synology",
    kind: "smb",
    enabled: true,
    hint: "//nas.local/backups",
    path: null,
    host: "nas.local",
    port: 445,
    username: "backup",
    remoteDir: "",
    authMode: null,
    share: "backups",
    domain: "",
    encrypt: true,
    hasPassword: true,
    hasPrivateKey: false,
    configError: false,
    lastStatus: "ok",
    lastError: "",
    lastSyncedAt: ago(7 * HOUR),
    lastCheckedAt: null,
    lastAttemptAt: ago(7 * HOUR),
    failingSince: null,
    lastAlertedAt: null,
    createdAt: ago(60 * DAY),
    updatedAt: ago(60 * DAY),
    ...overrides,
  };
}

function copy(overrides: Partial<BackupCopy> = {}): BackupCopy {
  return {
    destinationId: "synology",
    status: "copied",
    error: "",
    startedAt: ago(7 * HOUR),
    copiedAt: ago(6.9 * HOUR),
    checkedAt: null,
    updatedAt: ago(6.9 * HOUR),
    ...overrides,
  };
}

function backup(overrides: Partial<BackupHistoryItem> = {}): BackupHistoryItem {
  return {
    id: "b1",
    filename: "backup-2026-10-23-030000.zip",
    sizeBytes: 1.2 * 1024 ** 3,
    kind: "scheduled",
    status: "completed",
    errorMessage: "",
    copiesTracked: true,
    createdAt: ago(7 * HOUR),
    completedAt: ago(7 * HOUR),
    onServer: true,
    inProgress: false,
    copies: [copy()],
    ...overrides,
  };
}

function schedule(overrides: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    enabled: true,
    frequency: "daily",
    hour: 3,
    dayOfWeek: 0,
    dayOfMonth: 1,
    cronExpr: "0 3 * * *",
    nextRunAt: "2026-10-24T03:00:00.000Z",
    timeZone: "UTC",
    lastRunAt: ago(7 * HOUR),
    retentionEnabled: true,
    retentionDays: 30,
    offBoxRetentionEnabled: false,
    offBoxRetentionDays: 90,
    updatedAt: ago(60 * DAY),
    ...overrides,
  };
}

function verification(
  problems: Array<{ key: string; severity?: "error" | "warn"; message?: string }> = [],
) {
  return {
    verifiedAt: ago(3 * HOUR),
    areas: [
      {
        id: "server",
        title: "This server",
        summary: "",
        problems: problems.map((problem) => ({
          key: problem.key,
          severity: problem.severity ?? "error",
          message: problem.message ?? `Problem ${problem.key}`,
        })),
      },
    ],
  } satisfies BackupVerification;
}

describe("words and times", () => {
  test("names join the way a sentence does", () => {
    assert.equal(joinNames([]), "");
    assert.equal(joinNames(["Synology"]), "Synology");
    assert.equal(joinNames(["this server", "Synology"]), "this server and Synology");
    assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
  });

  test("sizes read in the largest unit that fits", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MB");
    assert.equal(formatBytes(50 * 1024 ** 3), "50 GB");
    assert.equal(formatBytes(2 * 1024 ** 4), "2.0 TB");
    assert.equal(formatBytes(-1), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
  });

  test("a time says which day, relative to today, then the clock", () => {
    assert.equal(formatClock("2026-10-23T03:05:00Z", GB), "03:05");
    assert.equal(formatClock("not a date", GB), "");
    assert.equal(formatDay("2026-10-23T03:00:00Z", NOW, GB), "today");
    assert.equal(formatDay("2026-10-22T23:59:00Z", NOW, GB), "yesterday");
    assert.equal(formatDay("2026-10-24T03:00:00Z", NOW, GB), "tomorrow");
    assert.equal(formatDay("2026-10-19T03:00:00Z", NOW, GB), "Mon 19 Oct");
    assert.equal(formatDay("2025-10-20T03:00:00Z", NOW, GB), "20 Oct 2025");
    assert.equal(formatWhen("2026-10-23T03:00:00Z", NOW, GB), "Today at 03:00");
    assert.equal(formatWhen("2026-10-24T03:00:00Z", NOW, GB), "Tomorrow at 03:00");
    assert.equal(formatWhen("garbage", NOW, GB), "");
  });

  test("today and tomorrow are the reader's own days, not UTC's", () => {
    const tokyo: FormatOptions = { locale: "en-GB", timeZone: "Asia/Tokyo" };
    // 23:30 UTC on the 23rd is 08:30 on the 24th in Tokyo, where it is 19:00 on the 23rd.
    assert.equal(formatWhen("2026-10-23T23:30:00Z", NOW, tokyo), "Tomorrow at 08:30");
    assert.equal(formatWhen("2026-10-23T23:30:00Z", NOW, GB), "Today at 23:30");
  });

  test("an age is in the largest whole unit", () => {
    assert.equal(formatAge(ago(20_000), NOW), "just now");
    assert.equal(formatAge(ago(60_000), NOW), "1 minute ago");
    assert.equal(formatAge(ago(5 * 60_000), NOW), "5 minutes ago");
    assert.equal(formatAge(ago(HOUR), NOW), "1 hour ago");
    assert.equal(formatAge(ago(7 * HOUR), NOW), "7 hours ago");
    assert.equal(formatAge(ago(DAY), NOW), "1 day ago");
    assert.equal(formatAge(ago(13 * DAY), NOW), "13 days ago");
    assert.equal(formatAge(ago(21 * DAY), NOW), "3 weeks ago");
    assert.equal(formatAge(ago(120 * DAY), NOW), "4 months ago");
    assert.equal(formatAge(new Date(NOW.getTime() + HOUR).toISOString(), NOW), "just now");
    assert.equal(formatAge("garbage", NOW), "");
  });

  test("a schedule reads as a sentence, in the reader's way of writing a time", () => {
    assert.equal(formatHour(3, GB), "03:00");
    assert.equal(formatHour(15, { locale: "en-US" }), "03:00 PM");
    assert.equal(describeSchedule(schedule(), GB), "Every day at 03:00");
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", dayOfWeek: 1, hour: 22 }), GB),
      "Every Monday at 22:00",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "monthly", dayOfMonth: 15, hour: 0 }), GB),
      "On day 15 of every month at 00:00",
    );
  });

  test("the next run is told in the schedule's own time zone, like its hour", () => {
    const tokyo: FormatOptions = { locale: "en-GB", timeZone: "Asia/Tokyo" };
    const sched = schedule({ nextRunAt: "2026-10-24T03:00:00.000Z", timeZone: "UTC" });
    assert.equal(formatNextRun(sched, NOW, tokyo), "Tomorrow at 03:00", "not 12:00, Tokyo's time");
    assert.equal(formatNextRun(sched, NOW, GB), "Tomorrow at 03:00");
    assert.equal(
      formatNextRun({ ...sched, timeZone: "Europe/London" }, NOW, GB),
      "Tomorrow at 04:00",
      "London is an hour ahead of UTC in October",
    );
    assert.equal(formatNextRun({ ...sched, enabled: false }, NOW, GB), null);
    assert.equal(formatNextRun({ ...sched, nextRunAt: null }, NOW, GB), null);
    assert.equal(
      formatNextRun({ ...sched, timeZone: "Not/AZone" }, NOW, GB),
      "Tomorrow at 03:00",
      "a zone the browser doesn't know falls back to the reader's",
    );
  });

  test("a retention policy reads as a sentence", () => {
    assert.equal(retentionSentence(true, 30), "Backups older than 30 days are deleted");
    assert.equal(retentionSentence(true, 1), "Backups older than 1 day are deleted");
    assert.equal(retentionSentence(false, 30), "Backups are kept until you delete them");
  });
});

describe("where one backup lives", () => {
  test("the archive itself: here, gone, being written, unfinished or failed", () => {
    assert.deepEqual(serverPlace(backup()), {
      state: "on",
      label: "On this server",
      tone: "ok",
    });
    assert.equal(serverPlace(backup({ onServer: false })).label, "No longer on this server");
    assert.equal(
      serverPlace(backup({ status: "running", inProgress: true })).label,
      "Being written…",
    );
    assert.deepEqual(serverPlace(backup({ status: "running", inProgress: false })), {
      state: "unfinished",
      label: "Didn't finish",
      tone: "error",
    });
    assert.equal(serverPlace(backup({ status: "failed" })).tone, "error");
  });

  test("each off-box copy, in the destinations' order, with what happened to it", () => {
    const destinations = [
      destination(),
      destination({ id: "office", name: "Office NAS" }),
      destination({ id: "spare", name: "Spare disk" }),
      destination({ id: "old", name: "Old NAS" }),
      destination({ id: "cold", name: "Cold storage" }),
      destination({ id: "queue", name: "Queue" }),
    ];
    const views = copyViews(
      backup({
        copies: [
          copy({ destinationId: "queue", status: "pending" }),
          copy({ destinationId: "cold", status: "removed" }),
          copy({ destinationId: "old", status: "missing", checkedAt: ago(3 * HOUR) }),
          copy({
            destinationId: "spare",
            status: "failed",
            error: "Authentication failed — check the username, password, and domain",
          }),
          copy({ destinationId: "office", status: "copying", startedAt: ago(5 * 60_000) }),
          copy(),
        ],
      }),
      destinations,
      NOW,
      GB,
    );

    assert.deepEqual(
      views.map((view) => [view.name, view.state, view.tone, view.label]),
      [
        ["Synology", "copied", "ok", "On Synology"],
        ["Office NAS", "copying", "working", "Copying to Office NAS…"],
        ["Spare disk", "failed", "error", "Not on Spare disk: the copy failed"],
        ["Old NAS", "missing", "warn", "Not on Old NAS"],
        ["Cold storage", "removed", "muted", "Removed from Cold storage"],
        ["Queue", "pending", "working", "Waiting to copy to Queue"],
      ],
    );
    const byName = new Map(views.map((view) => [view.name, view]));
    assert.equal(byName.get("Synology")!.detail, "Copied today at 03:06");
    assert.equal(byName.get("Office NAS")!.detail, "Started 5 minutes ago");
    assert.equal(
      byName.get("Spare disk")!.detail,
      "Authentication failed — check the username, password, and domain",
      "a failed copy shows the destination's own reason",
    );
    assert.equal(
      byName.get("Old NAS")!.detail,
      "Daily verification didn't find it there today at 07:00.",
    );
    assert.equal(byName.get("Cold storage")!.detail, "Off-box retention deleted it there.");
    assert.deepEqual(
      views.filter((view) => view.canRetry).map((view) => view.name),
      ["Spare disk", "Old NAS"],
      "Try again is offered where the copy didn't arrive",
    );
  });

  test("a copy found by verification, not seen arriving, says so", () => {
    const [view] = copyViews(
      backup({ copies: [copy({ copiedAt: null, checkedAt: ago(2 * HOUR) })] }),
      [destination()],
      NOW,
      GB,
    );
    assert.equal(view.detail, "Found there by daily verification today at 08:00");
  });

  test("Try again needs the backup still here to send", () => {
    const [view] = copyViews(
      backup({ onServer: false, copies: [copy({ status: "failed", error: "Full" })] }),
      [destination()],
      NOW,
      GB,
    );
    assert.equal(view.canRetry, false);
  });

  test("a destination with no record: not copied if recorded all along, else not recorded", () => {
    const office = destination({ id: "office", name: "Office NAS", createdAt: ago(2 * HOUR) });
    const paused = destination({ id: "paused", name: "Paused", enabled: false });
    const tracked = copyViews(backup({ copies: [] }), [destination(), office, paused], NOW, GB);
    assert.deepEqual(
      tracked.map((view) => [view.name, view.state, view.label, view.detail]),
      [
        ["Synology", "not-copied", "Not copied to Synology", null],
        [
          "Office NAS",
          "not-copied",
          "Not copied to Office NAS",
          "Taken before Office NAS was added.",
        ],
      ],
      "a paused destination with no record is left out",
    );

    const uploaded = copyViews(backup({ kind: "uploaded", copies: [] }), [destination()], NOW, GB);
    assert.equal(uploaded[0].detail, "Uploaded backups aren't copied off-box on their own.");

    const legacy = copyViews(
      backup({ copiesTracked: false, copies: [] }),
      [destination()],
      NOW,
      GB,
    );
    assert.equal(legacy[0].state, "not-recorded");
    assert.equal(legacy[0].label, "Synology: not recorded");
    assert.match(legacy[0].detail ?? "", /Verify now/);
    assert.equal(legacy[0].tone, "muted");
  });

  test("a paused destination still shows a copy it has", () => {
    const views = copyViews(backup(), [destination({ enabled: false })], NOW, GB);
    assert.equal(views[0].state, "copied");
  });

  test("a backup that is running or failed has no copies to show", () => {
    assert.deepEqual(
      copyViews(backup({ status: "running", inProgress: true }), [destination()], NOW),
      [],
    );
    assert.deepEqual(copyViews(backup({ status: "failed" }), [destination()], NOW), []);
  });

  test("one sentence says where it is", () => {
    const sentence = (item: BackupHistoryItem, destinations = [destination()]) =>
      locationSentence(item, copyViews(item, destinations, NOW, GB));
    const office = destination({ id: "office", name: "Office NAS" });

    assert.equal(sentence(backup()), "On this server and Synology.");
    assert.equal(
      sentence(backup({ copies: [copy(), copy({ destinationId: "office" })] }), [
        destination(),
        office,
      ]),
      "On this server, Synology and Office NAS.",
    );
    assert.equal(
      sentence(backup({ copies: [copy({ status: "copying" })] })),
      "On this server, and being copied to Synology.",
    );
    assert.equal(
      sentence(backup({ copies: [copy({ status: "failed", error: "Full" })] })),
      "Only on this server: the copy to Synology failed.",
    );
    assert.equal(
      sentence(backup({ copies: [copy({ status: "missing" })] })),
      "Only on this server: it is no longer on Synology.",
    );
    assert.equal(
      sentence(backup({ copiesTracked: false, copies: [] })),
      "On this server. Where its off-box copies went wasn't recorded.",
    );
    assert.equal(sentence(backup({ copies: [] }), []), "Only on this server.");
    assert.equal(sentence(backup({ copies: [] })), "Only on this server.");
    assert.equal(
      sentence(backup({ onServer: false })),
      "Only on Synology: it is no longer on this server.",
    );
    assert.equal(
      sentence(backup({ onServer: false, copiesTracked: false, copies: [] })),
      "No longer on this server, and where its off-box copies went wasn't recorded.",
    );
    assert.equal(
      sentence(backup({ onServer: false, copies: [copy({ status: "removed" })] })),
      "No longer on this server, and not on any off-box destination.",
    );
    assert.equal(
      sentence(backup({ status: "failed", errorMessage: "Disk full", copies: [] })),
      "Not saved: Disk full",
    );
    assert.equal(
      sentence(backup({ status: "failed", errorMessage: "", copies: [] })),
      "Not saved: no reason was recorded",
    );
    assert.equal(
      sentence(backup({ status: "running", inProgress: true, copies: [] })),
      "Being written on this server…",
    );
    assert.equal(
      sentence(backup({ status: "running", inProgress: false, copies: [] })),
      "Genosyn stopped while writing it, so there is nothing to restore.",
    );
  });

  test("the page follows a backup being written, or any copy on its way", () => {
    assert.equal(isBusy([]), false);
    assert.equal(isBusy([backup()]), false);
    assert.equal(isBusy([backup({ status: "running", inProgress: true, copies: [] })]), true);
    assert.equal(isBusy([backup({ status: "running", inProgress: false, copies: [] })]), false);
    assert.equal(isBusy([backup({ copies: [copy({ status: "pending" })] })]), true);
    assert.equal(isBusy([backup({ copies: [copy({ status: "copying" })] })]), true);
    assert.equal(isBusy([backup({ copies: [copy({ status: "failed" })] })]), false);
  });
});

describe("how a destination is doing", () => {
  test("working, connected, untested, paused, failing, or unreadable", () => {
    assert.deepEqual(destinationHealth(destination(), NOW, GB), {
      tone: "ok",
      label: "Working · last copy 7 hours ago",
      detail: null,
      technical: null,
      failing: false,
    });
    assert.equal(
      destinationHealth(destination({ lastSyncedAt: null }), NOW, GB).label,
      "Connected · nothing copied yet",
    );
    assert.deepEqual(
      destinationHealth(destination({ lastSyncedAt: null, lastStatus: "unknown" }), NOW, GB),
      { tone: "muted", label: "Not tested yet", detail: null, technical: null, failing: false },
    );
    assert.deepEqual(destinationHealth(destination({ enabled: false }), NOW, GB), {
      tone: "muted",
      label: "Paused",
      detail: "New backups aren't copied here.",
      technical: null,
      failing: false,
    });

    const failing = destinationHealth(
      destination({
        lastStatus: "error",
        lastError: "The copy to nas.local didn't finish within 7.6 hours",
        failingSince: "2026-10-11T03:00:00.000Z",
        lastSyncedAt: "2026-10-10T03:20:00.000Z",
      }),
      NOW,
      GB,
    );
    assert.equal(failing.tone, "error");
    assert.equal(failing.failing, true);
    assert.equal(failing.label, "Copies failing since Sun 11 Oct at 03:00");
    assert.equal(
      failing.detail,
      "The copy to nas.local didn't finish within 7.6 hours. The last copy arrived 13 days ago.",
    );
    assert.equal(
      destinationHealth(
        destination({ failingSince: ago(DAY), lastSyncedAt: null, lastError: "" }),
        NOW,
        GB,
      ).detail,
      "No copy has arrived yet.",
    );

    assert.deepEqual(
      destinationHealth(destination({ lastStatus: "error", lastError: "Access denied" }), NOW, GB),
      {
        tone: "error",
        label: "Last test failed",
        detail: "Access denied",
        technical: null,
        failing: true,
      },
    );
    const unreadable = destinationHealth(destination({ configError: true }), NOW, GB);
    assert.equal(unreadable.label, "Its settings can't be read");
    assert.equal(unreadable.failing, true);
    assert.equal(
      destinationHealth(destination({ configError: true, enabled: false }), NOW, GB).failing,
      false,
      "a paused destination is no one's concern",
    );
  });
});

describe("the status summary", () => {
  const healthy = () => ({
    backups: [backup()],
    destinations: [destination()],
    schedule: schedule(),
    verification: verification(),
    now: NOW,
  });

  test("a healthy install says it is backed up, when, where, and what's next", () => {
    const summary = summarizeBackups(healthy(), GB);
    assert.equal(summary.tone, "ok");
    assert.equal(summary.headline, "Your data is backed up");
    assert.equal(summary.activity, null);
    assert.equal(summary.lastGood?.id, "b1");
    assert.equal(summary.lastGoodText, "Today at 03:00 (7 hours ago) · 1.2 GB");
    assert.equal(summary.whereText, "On this server and Synology.");
    assert.equal(summary.scheduleText, "Every day at 03:00 (UTC)");
    assert.equal(summary.nextText, "Tomorrow at 03:00");
    assert.equal(summary.verifiedText, "Today at 07:00: every backup in place");
    assert.deepEqual(summary.issues, []);
  });

  test("a backup being written leads, and says it carries on", () => {
    const running = backup({
      id: "now",
      status: "running",
      inProgress: true,
      createdAt: ago(2 * 60_000),
      copies: [],
    });
    const summary = summarizeBackups({ ...healthy(), backups: [running, backup()] }, GB);
    assert.equal(summary.tone, "working");
    assert.equal(summary.headline, "Backing up now…");
    assert.equal(summary.activity, "Started 2 minutes ago. It carries on if you leave this page.");
    assert.equal(summary.lastGood?.id, "b1", "the last good backup is still the finished one");
  });

  test("a run copying its finished backup off-box is copying, not backing up", () => {
    const delivering = backup({ inProgress: true, copies: [copy({ status: "copying" })] });
    const summary = summarizeBackups({ ...healthy(), backups: [delivering] }, GB);
    assert.equal(summary.headline, "Backed up, and copying it off-box now");
    assert.equal(summary.lastGood?.id, delivering.id, "written, so restorable already");
    assert.equal(activeRun([delivering])?.id, delivering.id, "Back up now waits for it");
    assert.equal(activeRun([backup()]), null);
    assert.equal(serverPlace(delivering).label, "On this server");
    assert.equal(isBusy([delivering]), true);
  });

  test("a backup being copied off-box says where it is going", () => {
    const summary = summarizeBackups(
      { ...healthy(), backups: [backup({ copies: [copy({ status: "copying" })] })] },
      GB,
    );
    assert.equal(summary.tone, "working");
    assert.equal(summary.headline, "Backed up, and copying it off-box now");
    assert.equal(summary.activity, "Copying the backup from today at 03:00 to Synology.");
    assert.equal(summary.whereText, "On this server, and being copied to Synology.");
  });

  test("an install with no backup at all says so", () => {
    const summary = summarizeBackups({ ...healthy(), backups: [] }, GB);
    assert.equal(summary.tone, "error");
    assert.equal(summary.headline, "Not backed up yet");
    assert.equal(summary.lastGoodText, "None yet");
    assert.equal(summary.whereText, "Nowhere yet");
    assert.equal(summary.lastGood, null);
  });

  test("a backup that only lives off-box still counts as the last good one", () => {
    const summary = summarizeBackups({ ...healthy(), backups: [backup({ onServer: false })] }, GB);
    assert.equal(summary.lastGood?.id, "b1");
    assert.equal(summary.whereText, "Only on Synology: it is no longer on this server.");
  });

  test("the last backup failing, or not finishing, needs attention", () => {
    const failed = backup({
      id: "failed",
      status: "failed",
      errorMessage: "Could not copy the database",
      createdAt: ago(HOUR),
      onServer: false,
      copies: [],
    });
    const summary = summarizeBackups({ ...healthy(), backups: [failed, backup()] }, GB);
    assert.equal(summary.tone, "error");
    assert.equal(summary.headline, "Backups need attention");
    assert.deepEqual(summary.issues, [
      {
        key: "last-failed",
        tone: "error",
        text: "The last backup failed: Could not copy the database",
      },
    ]);

    const unfinished = backup({
      id: "x",
      status: "running",
      inProgress: false,
      createdAt: ago(HOUR),
    });
    assert.deepEqual(
      summarizeBackups({ ...healthy(), backups: [unfinished, backup()] }, GB).issues.map(
        (i) => i.key,
      ),
      ["last-unfinished"],
    );

    // An older failure, with a good backup since, is history, not a problem.
    const older = backup({ id: "old", status: "failed", createdAt: ago(3 * DAY), copies: [] });
    assert.deepEqual(summarizeBackups({ ...healthy(), backups: [backup(), older] }, GB).issues, []);
    // A failed upload is not a failed backup.
    const upload = backup({ id: "up", kind: "uploaded", status: "failed", createdAt: ago(HOUR) });
    assert.deepEqual(
      summarizeBackups({ ...healthy(), backups: [upload, backup()] }, GB).issues,
      [],
    );
  });

  test("a destination backups aren't reaching needs attention, with its reason", () => {
    const summary = summarizeBackups(
      {
        ...healthy(),
        destinations: [
          destination({
            lastStatus: "error",
            lastError: "The copy to nas.local didn't finish within 7.6 hours",
            failingSince: "2026-10-11T03:00:00.000Z",
          }),
          destination({ id: "off", name: "Off", enabled: false, failingSince: ago(DAY) }),
          destination({ id: "test", name: "Office NAS", lastStatus: "error", lastError: "" }),
          destination({ id: "key", name: "Rotated", configError: true }),
        ],
      },
      GB,
    );
    assert.equal(summary.headline, "Backups need attention");
    assert.deepEqual(summary.issues, [
      {
        key: "failing:synology",
        tone: "error",
        text: "Backups aren't reaching Synology since Sun 11 Oct at 03:00: The copy to nas.local didn't finish within 7.6 hours",
      },
      { key: "failing:test", tone: "error", text: "Backups aren't reaching Office NAS." },
      {
        key: "settings:key",
        tone: "error",
        text: "Rotated's settings can't be read. Edit it and enter its password again.",
      },
    ]);
  });

  test("verification problems show, a few at a time, without repeating the schedule", () => {
    const summary = summarizeBackups(
      {
        ...healthy(),
        verification: verification([
          { key: "schedule-off", severity: "warn" },
          { key: "gone:a", message: "backup-a.zip is in History but its file is gone." },
          { key: "missed:b", message: "The backup scheduled for Tuesday never ran." },
          { key: "offbox-missing:c", severity: "warn" },
          { key: "unreadable:d" },
          { key: "unreadable:e", severity: "warn" },
        ]),
      },
      GB,
    );
    assert.deepEqual(
      summary.issues.map((issue) => [issue.key, issue.tone]),
      [
        ["verification:gone:a", "error"],
        ["verification:missed:b", "error"],
        ["verification:offbox-missing:c", "warn"],
        ["verification:more", "error"],
      ],
    );
    assert.equal(
      summary.issues[3].text,
      "Daily verification found 2 more problems: see Daily verification under Advanced.",
    );
    assert.equal(summary.verifiedText, "Today at 07:00: 6 problems found");
  });

  test("backups only on this server is a warning, and so is every destination paused", () => {
    const none = summarizeBackups({ ...healthy(), destinations: [] }, GB);
    assert.equal(none.tone, "warn");
    assert.equal(none.headline, "Backed up, with a warning");
    assert.equal(none.issues[0].key, "no-destination");
    assert.equal(none.whereText, "Only on this server.");

    const paused = summarizeBackups(
      { ...healthy(), destinations: [destination({ enabled: false })] },
      GB,
    );
    assert.equal(paused.issues[0].key, "all-paused");
  });

  test("automatic backups off is a warning; with no destination it is two", () => {
    const off = summarizeBackups(
      { ...healthy(), schedule: schedule({ enabled: false, nextRunAt: null }) },
      GB,
    );
    assert.equal(off.scheduleText, "Off");
    assert.equal(off.nextText, null);
    assert.deepEqual(
      off.issues.map((issue) => issue.key),
      ["schedule-off"],
    );

    const both = summarizeBackups(
      { ...healthy(), destinations: [], schedule: schedule({ enabled: false, nextRunAt: null }) },
      GB,
    );
    assert.equal(both.headline, "Backed up, with 2 warnings");
  });

  test("a last good backup older than the schedule promises is worth saying", () => {
    const old = backup({ createdAt: ago(3 * DAY) });
    const daily = summarizeBackups({ ...healthy(), backups: [old] }, GB);
    assert.deepEqual(daily.issues, [
      { key: "stale", tone: "warn", text: "The last good backup was taken 3 days ago." },
    ]);
    const weekly = summarizeBackups(
      { ...healthy(), backups: [old], schedule: schedule({ frequency: "weekly" }) },
      GB,
    );
    assert.deepEqual(weekly.issues, [], "three days is fine for a weekly schedule");
  });

  test("what hasn't loaded is left out, never invented", () => {
    const summary = summarizeBackups(
      {
        backups: [backup()],
        destinations: null,
        schedule: null,
        verification: undefined,
        now: NOW,
      },
      GB,
    );
    assert.equal(summary.headline, "Your data is backed up");
    assert.equal(summary.scheduleText, "…");
    assert.equal(summary.nextText, null);
    assert.equal(summary.verifiedText, "…");
    assert.equal(summary.whereText, "On this server.", "no destinations known, so none named");
    assert.deepEqual(summary.issues, []);

    const never = summarizeBackups({ ...healthy(), verification: null }, GB);
    assert.equal(never.verifiedText, "Not run yet");
  });
});

describe("reasons in plain words", () => {
  test("a raw error from this server reads as what happened, with the raw kept as detail", () => {
    assert.deepEqual(plainReason("ENOSPC: no space left on device, write", "server"), {
      text: "The server ran out of disk space. Free some space, or keep fewer backups here under Advanced.",
      technical: "ENOSPC: no space left on device, write",
    });
    for (const [raw, start] of [
      ["EACCES: permission denied, open '/data/Backup/x.zip.part'", "Genosyn isn't allowed to write"],
      ["EROFS: read-only file system, open '/data/Backup/x'", "The backup folder is on a disk"],
      ["EIO: i/o error, write", "The disk reported an error"],
      ["EMFILE: too many open files, open '/data/x'", "Too many files were open"],
      ["ENOENT: no such file or directory, stat '/data/companies/a'", "A file went missing"],
      ["EDQUOT: disk quota exceeded, write", "The server's disk quota ran out"],
    ] as const) {
      const reason = plainReason(raw, "server");
      assert.ok(reason?.text.startsWith(start), `${raw} → ${reason?.text}`);
      assert.equal(reason?.technical, raw);
    }
  });

  test("a raw error from a destination reads as what happened there", () => {
    const cases: Array<[string, string]> = [
      ["connect ECONNREFUSED 10.0.0.5:22", "The destination refused the connection. Check its host and port."],
      ["getaddrinfo ENOTFOUND nas.local", "The destination's host name couldn't be found."],
      ["connect EHOSTUNREACH 10.0.0.5:445", "The destination couldn't be reached on the network."],
      ["Timed out while waiting for handshake", "The destination stopped answering."],
      ["Keepalive timeout", "The destination stopped answering."],
      ["read ECONNRESET", "The connection to the destination dropped."],
      ["connect: Connection lost before handshake", "The connection to the destination dropped."],
      ["All configured authentication methods failed", "The destination refused the username, password or key."],
      ["put: Permission denied (publickey) /backups", "The destination refused the username, password or key."],
      ["EACCES: permission denied, mkdir '/mnt/nas/genosyn'", "Genosyn isn't allowed to write to the destination's folder."],
      ["EEXIST: file already exists, mkdir '/mnt/nas'", "The destination's folder is a file, not a folder."],
      ["ENOTDIR: not a directory, open '/mnt/nas/x'", "The destination's folder is a file, not a folder."],
      ["ENOSPC: no space left on device, copyfile", "The destination ran out of space. Free some there, or turn on off-box retention under Advanced."],
      ["NT_STATUS_IO_TIMEOUT", "The SMB share refused the request."],
    ];
    for (const [raw, text] of cases) {
      assert.deepEqual(plainReason(raw, "destination"), { text, technical: raw }, raw);
    }
  });

  test("Genosyn's own sentences pass through, and nothing is no reason", () => {
    for (const plain of [
      "Authentication failed — check the username, password, and domain",
      "The share on nas.local is full — free some space there, or turn on off-box retention",
      "The copy to nas.local didn't finish within 7.6 hours — the link moved under 2 MB/s",
      "Genosyn stopped while writing this backup (a restart, an upgrade or a crash), so it didn't finish.",
    ]) {
      assert.deepEqual(plainReason(plain, "destination"), { text: plain, technical: null });
      assert.deepEqual(plainReason(plain, "server"), { text: plain, technical: null });
    }
    assert.equal(plainReason("", "server"), null);
    assert.equal(plainReason("   ", "destination"), null);
    assert.equal(plainReason(null, "server"), null);
  });

  test("History, the summary and destinations all say it plainly", () => {
    const enospc = backup({
      status: "failed",
      errorMessage: "ENOSPC: no space left on device, write",
      onServer: false,
      copies: [],
      createdAt: ago(HOUR),
    });
    assert.equal(
      locationSentence(enospc, []),
      "Not saved: The server ran out of disk space. Free some space, or keep fewer backups here under Advanced.",
    );
    const summary = summarizeBackups(
      { backups: [enospc, backup()], destinations: [destination()], schedule: schedule(), verification: verification(), now: NOW },
      GB,
    );
    assert.equal(
      summary.issues[0].text,
      "The last backup failed: The server ran out of disk space. Free some space, or keep fewer backups here under Advanced.",
    );

    const [failedCopy] = copyViews(
      backup({ copies: [copy({ status: "failed", error: "read ECONNRESET" })] }),
      [destination()],
      NOW,
      GB,
    );
    assert.equal(failedCopy.detail, "The connection to the destination dropped.");
    assert.equal(failedCopy.technical, "read ECONNRESET");

    const health = destinationHealth(
      destination({
        lastStatus: "error",
        lastError: "getaddrinfo ENOTFOUND nas.local",
        failingSince: ago(DAY),
        lastSyncedAt: null,
      }),
      NOW,
      GB,
    );
    assert.equal(health.detail, "The destination's host name couldn't be found. No copy has arrived yet.");
    assert.equal(health.technical, "getaddrinfo ENOTFOUND nas.local");
    const failing = summarizeBackups(
      {
        backups: [backup()],
        destinations: [destination({ lastStatus: "error", lastError: "connect ECONNREFUSED 10.0.0.5:22" })],
        schedule: schedule(),
        verification: verification(),
        now: NOW,
      },
      GB,
    );
    assert.equal(
      failing.issues[0].text,
      "Backups aren't reaching Synology: The destination refused the connection. Check its host and port.",
    );
  });

  test("each kind of backup says what it is", () => {
    assert.equal(KIND_LABEL.scheduled, "Automatic");
    assert.equal(KIND_LABEL.manual, "Manual");
    assert.equal(KIND_LABEL.uploaded, "Uploaded");
    assert.match(KIND_HINT.scheduled, /schedule/);
    assert.match(KIND_HINT.manual, /Back up now/);
    assert.match(KIND_HINT.uploaded, /Uploaded under Advanced/);
  });
});

describe("what Advanced holds", () => {
  test("says how long backups are kept in both places, and how verification went", () => {
    assert.equal(
      advancedSummary(schedule(), verification(), NOW),
      "Keep 30 days here, everything off-box · verified 3 hours ago",
    );
    assert.equal(
      advancedSummary(
        schedule({ retentionEnabled: false, offBoxRetentionEnabled: true, offBoxRetentionDays: 1 }),
        null,
        NOW,
      ),
      "Keep everything here, 1 day off-box · not verified yet",
    );
    assert.equal(
      advancedSummary(schedule(), verification([{ key: "a" }]), NOW),
      "Keep 30 days here, everything off-box · verification found 1 problem",
    );
    assert.equal(advancedSummary(null, undefined, NOW), "");
  });
});
