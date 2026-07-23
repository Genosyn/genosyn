import type { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { Company } from "../../db/entities/Company.js";
import type { Skill } from "../../db/entities/Skill.js";
import { TOOL_DOMAINS } from "./tools/toolIndex.js";

/**
 * The one system prompt an AI employee gets, for both seams that run one.
 *
 * ## Why this stopped being two functions
 *
 * The chat seam and the routine runner each carried their own
 * `composeSystemPrompt` and `toolsBriefing`, identical below the opening line
 * and diverging everywhere else by accident. By the time they were merged the
 * runner's copy had silently lost `workspace_channels`, `base_tables`,
 * `base_fields`, the PDF form tools, and the mail `edit` and `suggest` ops —
 * not by decision, just by nobody editing both files. It had also dropped the
 * one sentence that encodes this project's vocabulary rule for the model
 * (Routines are never called "tasks").
 *
 * A hand-maintained list of tool names in prose will always drift from the tool
 * list. So the enumeration is generated from {@link TOOL_DOMAINS}, which is the
 * same source `find_tools` searches and which fails the build if it drifts from
 * the manifest. The prose that remains is the part that is genuinely
 * judgement — when to reach for a tool, and what not to do.
 */

export type PromptSurface = "chat" | "routine";

export function composeEmployeeSystemPrompt(args: {
  co: Company;
  emp: AIEmployee;
  skills: Skill[];
  memoryContext: string;
  codeReposContext: string;
  financeContext: string;
  /** The one line the two seams genuinely disagree on. */
  opening: string;
  surface: PromptSurface;
  /** Per-skill declared toolsets, keyed by skill id, for the Skill headings. */
  skillToolsets?: Map<string, string[]>;
}): string {
  const { co, emp, skills, memoryContext, codeReposContext, financeContext } = args;
  void co;
  const parts: string[] = [];

  parts.push(args.opening);
  parts.push(toolsBriefing(args.surface));
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  if (memoryContext) parts.push(memoryContext);
  if (codeReposContext) parts.push(codeReposContext);
  if (financeContext) parts.push(financeContext);

  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    const declared = args.skillToolsets?.get(s.id);
    if (declared && declared.length > 0) {
      // Shown so the model can see the playbook is wired to specific tools —
      // they are already loaded, so this is orientation, not an instruction.
      parts.push(`_Tools: ${declared.map((n) => `\`${n}\``).join(", ")}_\n`);
    }
    parts.push(s.body);
  }

  return parts.join("\n");
}

/**
 * The tools section.
 *
 * Three pieces are chat-only, because they describe things that only exist in a
 * chat: `#`-tagged resources, uploaded attachments, and the pre-write checklist
 * for a teammate's ambiguous request. A routine's brief is written in advance
 * and there is nobody to ask.
 */
export function toolsBriefing(surface: PromptSurface): string {
  const isChat = surface === "chat";

  const lines: string[] = [
    "",
    "## Tools",
    "You have tools available — reach for them instead of describing what you would do. " +
      "Describing an action you don't actually take is a lie the human will catch: a tool call " +
      "leaves a visible audit row, and prose-only claims are invisible.",
    "",
    "### Your visible tools are a working set, not everything you have",
    "Most of your tools are not in the list you can see. `find_tools` searches the full " +
      "catalogue by description and returns exact schemas; `call_tool` runs anything it finds. " +
      "**Before saying you cannot do something, call `find_tools`** — a capability you have not " +
      "been shown is not a capability you lack. It is cheap and idempotent, so call it whenever " +
      "you are unsure, and again if you have forgotten what it returned.",
    `Domains in the catalogue: ${domainLine()}.`,
    "",
    "### Always loaded",
    "- Coding: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, " +
      "rooted at your working directory (which holds any granted git repos under `repos/` and " +
      "`code-repos/`).",
    '- Routines — scheduled recurring AI work. Genosyn calls these **Routines**, never "tasks". ' +
      "`create_routine` to schedule one; `update_routine` to rename, re-schedule, rewrite, or " +
      "pause/resume one in place — **never create a duplicate to change one** — and " +
      "`delete_routine` to remove one for good.",
    "- One-off work: `create_project`, `create_todo`, `update_todo`.",
    "- `add_journal_entry` to log decisions on your own diary (the last ~7 days are " +
      "auto-injected into every prompt), and `memory` to curate durable facts that are also " +
      "auto-injected.",
    "- `send_chat_attachment` to send a generated file back as a download chip.",
    "- Parallel delegation: `delegate_parallel_work` runs independent briefs concurrently as " +
      "temporary copies of you, then returns their results for you to verify and synthesize. " +
      "Prefer independent research, analysis, and API calls. Workers share your working " +
      "directory, so partition file-writing briefs explicitly and never overlap git operations.",
    "- Browser tools (when enabled) and any company-configured MCP server tools.",
    "",
    "### Reaching the rest",
    "- Email, finance, Bases, notes, resources, charts, dashboards, workspace channels, " +
      "handoffs and your company's integrations all live in the catalogue. Call `find_tools` " +
      "with what you are trying to do — \"record a payment\", \"reply to that email\", \"read a " +
      'spreadsheet" — and it returns the exact tools and their arguments.',
    "- Grants still apply. If `find_tools` says you hold no grant for something, say so plainly " +
      "rather than working around it.",
    "- Mail: prefer creating a draft over sending" +
      (isChat ? " unless explicitly told to send." : " unless the brief explicitly allows sending."),
  ];

  if (isChat) {
    lines.push(
      "- Teammates can tag company resources in chat as Markdown links whose text starts with " +
        "`#` and whose URL starts with `/c/`. Treat each tagged link as an explicit work target: " +
        "read the route to identify its type and slug, use the matching Genosyn read/list tool to " +
        "load it, and work on that exact row. A tag does not bypass Grants or project membership; " +
        "if your tools deny access, say so instead of guessing.",
      "",
      'When the teammate uploads a file, you\'ll see a header like `[Attachment id=<uuid> ' +
        'filename="foo.pdf" size=… mime="…"]` at the top of their message. That `id=` is the ' +
        "`attachmentId` you pass to `read_pdf_fields` / `fill_pdf_form` / any tool that takes an " +
        "`attachmentId` — copy it verbatim.",
      "",
      "### Before calling any write tool (`create_routine`, `create_project`, `create_todo`, `update_todo`)",
      "Privately answer: (1) **Scope** — the objective in the teammate's exact words; " +
        '(2) **Inputs** — which data source/metric ("revenue" is not a metric — ARR, MRR, ' +
        "bookings, churn, NRR are); (3) **Output** — where the result goes; (4) **Audience** — " +
        "who reads it; (5) **Escalation** — what threshold makes it worth flagging. If any is " +
        "genuinely unknown after re-reading the conversation, **ask before calling the tool** — " +
        "a short bulleted list of concrete questions the teammate can answer in one pass. After " +
        "clarifying: call the tool (don't describe it), confirm briefly (the UI renders an " +
        "action pill), and quote the teammate's specifics inside the `brief`/`description` field.",
    );
  }

  return lines.join("\n");
}

/**
 * The domain names, generated.
 *
 * This is the half of the recall defence that lives in the prompt; the other
 * half is the catalogue footer `find_tools` returns on every call, including a
 * miss. Generated rather than typed out so it cannot drift from what
 * `find_tools` will actually search.
 */
function domainLine(): string {
  return Object.values(TOOL_DOMAINS)
    .map((d) => d.label)
    .join(" · ");
}
