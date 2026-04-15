import { spawn } from "node:child_process";
import fs from "node:fs";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import {
  employeeDir,
  ensureDir,
  skillReadme,
  soulPath,
} from "./paths.js";
import { PROVIDERS } from "./providers.js";
import { readText } from "./files.js";
import { decryptSecret } from "../lib/secret.js";

/**
 * One-shot chat seam.
 *
 * The product surface is: a human sits at a keyboard and types at an AI
 * employee. We translate that into a single headless CLI invocation with a
 * prompt that carries the employee's SOUL + skills + recent conversation
 * turns + the latest user message. No streaming for v1 — we wait for the
 * CLI to exit and return stdout.
 *
 * Same degradation rules as `runner.ts`:
 *  - no model connected → `skipped` with an explanatory reply
 *  - CLI binary not installed → `skipped`
 *  - non-zero exit / spawn error → `error` with stderr tail
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { status: "ok"; reply: string }
  | { status: "skipped"; reply: string }
  | { status: "error"; reply: string };

export async function chatWithEmployee(
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
): Promise<ChatResult> {
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);
  const modelRepo = AppDataSource.getRepository(AIModel);
  const skillRepo = AppDataSource.getRepository(Skill);

  const emp = await empRepo.findOneBy({ id: employeeId, companyId });
  if (!emp) return { status: "error", reply: "Employee not found." };
  const co = await coRepo.findOneBy({ id: companyId });
  if (!co) return { status: "error", reply: "Company not found." };
  const model = await modelRepo.findOneBy({ employeeId: emp.id });
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });

  if (!model) {
    return {
      status: "skipped",
      reply: `${emp.name} has no AI Model connected. Open Settings on this employee to connect one.`,
    };
  }

  const prompt = composeChatPrompt({ co, emp, skills, history, message });
  const envResult = buildProviderEnv(co.slug, emp.slug, model);
  if (envResult.error !== undefined) return { status: "error", reply: envResult.error };
  const childEnv = envResult.env;

  const cwd = employeeDir(co.slug, emp.slug);
  ensureDir(cwd);

  const invocation = buildInvocation(model.provider, model.model, prompt);
  try {
    const stdout = await spawnAndCollect(invocation.cmd, invocation.args, {
      cwd,
      env: childEnv,
    });
    return { status: "ok", reply: stdout.trim() || "(no reply)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return {
        status: "skipped",
        reply: `\`${invocation.cmd}\` CLI is not installed on this server. Install it to chat with ${emp.name}.`,
      };
    }
    return { status: "error", reply: msg };
  }
}

function composeChatPrompt(args: {
  co: Company;
  emp: AIEmployee;
  skills: Skill[];
  history: ChatTurn[];
  message: string;
}): string {
  const { co, emp, skills, history, message } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you directly. Reply in your own voice, guided by your Soul and Skills below. Keep replies focused and grounded — ask clarifying questions when needed.`,
  );
  parts.push("\n## SOUL.md\n");
  parts.push(readText(soulPath(co.slug, emp.slug)));
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(readText(skillReadme(co.slug, emp.slug, s.slug)));
  }
  if (history.length > 0) {
    parts.push("\n## Conversation so far\n");
    for (const turn of history) {
      const who = turn.role === "user" ? "Teammate" : emp.name;
      parts.push(`**${who}:** ${turn.content}`);
    }
  }
  parts.push(`\n## New message\n**Teammate:** ${message}\n\n**${emp.name}:**`);
  return parts.join("\n");
}

function buildProviderEnv(
  coSlug: string,
  empSlug: string,
  model: AIModel,
): { env: NodeJS.ProcessEnv; error?: undefined } | { env?: undefined; error: string } {
  const spec = PROVIDERS[model.provider];
  const base = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    delete base[key];
  }

  if (model.authMode === "subscription") {
    const dir = spec.configDir(coSlug, empSlug);
    if (!fs.existsSync(spec.credsPath(coSlug, empSlug))) {
      return {
        error: `Subscription credentials not found. Sign ${model.provider} in from the Settings tab first.`,
      };
    }
    return { env: { ...base, [spec.configDirEnv]: dir } };
  }

  if (!spec.apiKeyEnv) {
    return { error: `${model.provider} doesn't support API key auth — use subscription.` };
  }
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(model.configJson || "{}");
  } catch {
    cfg = {};
  }
  const enc = typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  if (!enc) return { error: "No API key is set for this employee." };
  let key: string;
  try {
    key = decryptSecret(enc);
  } catch {
    return { error: "Stored API key could not be decrypted (sessionSecret may have rotated)." };
  }
  return { env: { ...base, [spec.apiKeyEnv]: key } };
}

function buildInvocation(
  provider: AIModel["provider"],
  modelStr: string,
  prompt: string,
): { cmd: string; args: string[] } {
  switch (provider) {
    case "claude-code":
      return { cmd: "claude", args: ["-p", prompt, "--model", modelStr] };
    case "codex":
      return { cmd: "codex", args: ["exec", "--model", modelStr, prompt] };
    case "opencode":
      return { cmd: "opencode", args: ["run", "--model", modelStr, prompt] };
  }
}

/**
 * Spawn the CLI and collect stdout. stderr is surfaced via the rejection so
 * the UI can show it without us needing a second field on the response.
 *
 * Cap at ~30s and 1MB to keep a stuck CLI from holding a request socket
 * open forever — chat is interactive, long-running work belongs in Routines.
 */
function spawnAndCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let out = "";
    let err = "";
    const cap = 1024 * 1024;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Chat timed out after 30s."));
    }, 30_000);
    child.stdout.on("data", (b: Buffer) => {
      if (out.length < cap) out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < cap) err += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} exited with code ${code}`));
    });
  });
}
