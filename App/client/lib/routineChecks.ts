import type { EffectCheckSpec, RoutineCheck, RoutineCheckKind } from "./api";

/**
 * Client-side reads and writes of a **Check**'s stored `spec`.
 *
 * The column is one text field holding two unrelated things — a shell command
 * verbatim, or a JSON `EffectCheckSpec` — because the alternative was a second
 * nullable column per kind. That trade puts the parsing somewhere, and here is
 * the right somewhere: the editor and the settings row both need it, and a
 * component that reaches into `JSON.parse` inline is a component nothing can
 * test.
 *
 * These are deliberately a *reading* of the server's rules, never a
 * replacement for them. `services/routineChecks.ts` re-validates everything
 * this file builds, and it is the one that decides. What the two share is the
 * refusal to be permissive: an effect spec that does not parse produces null
 * here and fails its check there, because the only safe reading of an unknown
 * assertion is that it did not pass.
 */

/**
 * Read a stored `effect` spec, or null when it cannot be read.
 *
 * Null rather than a default-filled object on purpose. A spec whose `action`
 * is missing is a Check whose meaning nobody knows, and quietly substituting a
 * plausible one would put a sentence on the settings row describing an
 * assertion the server will never make.
 */
export function readEffectSpec(raw: string): EffectCheckSpec | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const spec = decoded as Partial<EffectCheckSpec>;
  if (typeof spec.action !== "string" || spec.action.trim() === "") return null;
  return {
    action: spec.action,
    targetType:
      typeof spec.targetType === "string" && spec.targetType ? spec.targetType : undefined,
    min: typeof spec.min === "number" ? spec.min : 1,
    max: typeof spec.max === "number" ? spec.max : undefined,
  };
}

/** How a timeout reads on a settings row — `2m`, not `120s`. */
function formatSeconds(sec: number): string {
  if (sec > 0 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec > 0 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/**
 * One line of English for a stored Check, mirroring the sentence the server
 * folds into the Run brief.
 *
 * An unreadable spec says so rather than rendering as something reasonable.
 * The row is the last place a human sees a Check before it starts deciding
 * whether Runs are green, so a definition nobody can read has to be visible
 * here or it is invisible everywhere.
 */
export function describeCheck(check: Pick<RoutineCheck, "kind" | "spec" | "timeoutSec">): string {
  if (check.kind === "command") {
    const command = check.spec.trim();
    if (!command) return "No command is set, so this check will not pass.";
    return `The command \`${command}\` must exit 0, within ${formatSeconds(check.timeoutSec)}.`;
  }
  const spec = readEffectSpec(check.spec);
  if (!spec) return "Its definition cannot be read, so this check will not pass.";
  const what = `\`${spec.action}\`${spec.targetType ? ` on ${spec.targetType}` : ""}`;
  return spec.max === undefined
    ? `The effect ledger must record at least ${spec.min} ${what}.`
    : `The effect ledger must record between ${spec.min} and ${spec.max} ${what}.`;
}

/** What the editor form holds. Numbers stay strings — a half-typed `1` in a
 *  number field must not round itself or revert under the cursor. */
export type CheckSpecDraft = {
  kind: RoutineCheckKind;
  command: string;
  action: string;
  targetType: string;
  min: string;
  max: string;
};

export type CheckSpecResult = { ok: true; spec: string } | { ok: false; error: string };

/**
 * Turn the editor's fields into the `spec` string the route stores, or say
 * which field is wrong.
 *
 * The window checks are here rather than only on the server for one reason:
 * `max` below `min` describes a Check that no number could satisfy, and the
 * person typing it is the only one who knows what they meant. Finding out at
 * the next Run — as a red row on a Run report — is the wrong moment.
 */
export function buildCheckSpec(draft: CheckSpecDraft): CheckSpecResult {
  if (draft.kind === "command") {
    const command = draft.command.trim();
    if (!command) return { ok: false, error: "A command check needs a command." };
    return { ok: true, spec: command };
  }

  const action = draft.action.trim();
  if (!action) {
    return {
      ok: false,
      error: "An effect check needs an action to count, such as mail.send.",
    };
  }

  // An empty box is refused rather than read as zero. `Number("")` is 0, and a
  // minimum of zero is a Check that passes on a Run which did nothing at all —
  // the one outcome this whole primitive exists to stop being called green.
  // Zero is still a legitimate minimum when somebody types it, paired with a
  // maximum, to assert that something must *not* happen.
  const minText = draft.min.trim();
  const min = Number(minText);
  if (minText === "" || !Number.isInteger(min) || min < 0) {
    return { ok: false, error: "The minimum must be a whole number, zero or more." };
  }

  const hasMax = draft.max.trim() !== "";
  const max = hasMax ? Number(draft.max.trim()) : undefined;
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    return { ok: false, error: "The maximum must be a whole number, zero or more." };
  }
  if (max !== undefined && max < min) {
    return {
      ok: false,
      error: "The maximum must be at least the minimum — no count could satisfy that window.",
    };
  }

  const targetType = draft.targetType.trim();
  return {
    ok: true,
    spec: JSON.stringify({
      action,
      ...(targetType ? { targetType } : {}),
      min,
      ...(max === undefined ? {} : { max }),
    }),
  };
}

/**
 * The draft an editor opens with. A new Check starts as an `effect` one: it
 * needs no sandbox, so it is the kind that works on every installation.
 */
export function checkSpecDraft(check: RoutineCheck | null): CheckSpecDraft {
  const spec = check?.kind === "effect" ? readEffectSpec(check.spec) : null;
  return {
    kind: check?.kind ?? "effect",
    command: check?.kind === "command" ? check.spec : "",
    action: spec?.action ?? "",
    targetType: spec?.targetType ?? "",
    min: String(spec?.min ?? 1),
    max: spec?.max === undefined ? "" : String(spec.max),
  };
}
