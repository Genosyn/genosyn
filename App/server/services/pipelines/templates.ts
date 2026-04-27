import { RunEnv } from "./types.js";

/**
 * Template resolution for pipeline node config.
 *
 * Tokens look like `{{<source>.<path>...}}` where source is either a node id
 * (resolves against `env.nodeOutputs[id]`) or the literal `trigger` (resolves
 * against `env.trigger`). Path segments traverse objects; numeric segments
 * also traverse arrays. Missing paths render as the empty string.
 *
 * The whole-token form `"{{x.y}}"` (no surrounding text) preserves the
 * resolved type — handy for passing through arrays / numbers / booleans
 * without round-tripping through string. Mixed forms always stringify.
 */

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveValue(value: unknown, env: RunEnv): unknown {
  if (typeof value === "string") return resolveString(value, env);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveValue(v, env);
    }
    return out;
  }
  return value;
}

function resolveString(s: string, env: RunEnv): unknown {
  // Whole-token shortcut: keep types if the entire string is one token.
  const whole = s.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (whole) return lookup(whole[1], env);

  return s.replace(TOKEN_RE, (_full, expr: string) => {
    const v = lookup(expr, env);
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

function lookup(expr: string, env: RunEnv): unknown {
  const parts = expr.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const head = parts[0];
  let current: unknown;
  if (head === "trigger") {
    current = env.trigger;
  } else if (env.nodeOutputs[head] !== undefined) {
    current = env.nodeOutputs[head];
  } else {
    return null;
  }
  for (let i = 1; i < parts.length; i += 1) {
    if (current === null || current === undefined) return null;
    const seg = parts[i];
    if (Array.isArray(current)) {
      const idx = Number(seg);
      current = Number.isFinite(idx) ? current[idx] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return current ?? null;
}

/**
 * Resolve every template token inside a node config object. Returned as a
 * fresh object so the original graph is untouched.
 */
export function resolveConfig(
  config: Record<string, unknown>,
  env: RunEnv,
): Record<string, unknown> {
  return resolveValue(config, env) as Record<string, unknown>;
}
