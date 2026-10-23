import type { Block, CalloutKind } from "../../lib/noteMarkdown";

/** Typography for a rich-text block's editable. */
export function textClass(block: Block): string {
  switch (block.type) {
    case "heading":
      switch (block.level) {
        case 1:
          return "text-[1.875rem] font-bold leading-[1.25] tracking-tight text-slate-900 dark:text-slate-50";
        case 2:
          return "text-[1.5rem] font-semibold leading-[1.3] tracking-tight text-slate-900 dark:text-slate-50";
        case 3:
          return "text-[1.25rem] font-semibold leading-[1.35] text-slate-900 dark:text-slate-100";
        default:
          return "text-base font-semibold leading-[1.6] text-slate-900 dark:text-slate-100";
      }
    case "todo":
      return block.checked
        ? "text-base leading-[1.6] text-slate-400 line-through decoration-slate-300 dark:text-slate-500 dark:decoration-slate-600"
        : "text-base leading-[1.6] text-slate-800 dark:text-slate-100";
    case "quote":
      return "text-base leading-[1.6] text-slate-700 dark:text-slate-200";
    case "toggle":
      return "text-base leading-[1.6] text-slate-800 dark:text-slate-100";
    default:
      return "text-base leading-[1.6] text-slate-800 dark:text-slate-100";
  }
}

/** Space above a block, so headings breathe and list items pack. */
export function rowSpacing(block: Block, previous: Block | undefined): string {
  if (block.type === "heading") {
    if (!previous) return "pt-0.5";
    return block.level === 1 ? "pt-6" : block.level === 2 ? "pt-4" : "pt-3";
  }
  return "pt-[3px]";
}

/** The gutter sits level with the block's first line. */
export function gutterTop(block: Block): string {
  if (block.type === "heading") {
    return block.level === 1 ? "top-[0.55rem]" : block.level === 2 ? "top-[0.35rem]" : "top-[0.2rem]";
  }
  if (block.type === "callout") return "top-[0.85rem]";
  if (block.type === "code") return "top-2";
  return "top-[0.2rem]";
}

export function placeholderFor(block: Block, focused: boolean, onlyBlock: boolean): string | null {
  switch (block.type) {
    case "paragraph":
      if (onlyBlock) return "Write something, or press '/' for commands…";
      return focused ? "Press '/' for commands…" : null;
    case "heading":
      return `Heading ${block.level ?? 1}`;
    case "bulleted":
    case "numbered":
      return "List";
    case "todo":
      return "To-do";
    case "toggle":
      return "Toggle";
    case "quote":
      return "Empty quote";
    case "callout":
      return "Type something…";
    default:
      return null;
  }
}

export const CALLOUT_STYLES: Record<CalloutKind, { label: string; box: string; icon: string }> = {
  note: {
    label: "Note",
    box: "bg-sky-50 dark:bg-sky-500/10",
    icon: "text-sky-600 dark:text-sky-300",
  },
  tip: {
    label: "Tip",
    box: "bg-emerald-50 dark:bg-emerald-500/10",
    icon: "text-emerald-600 dark:text-emerald-300",
  },
  important: {
    label: "Important",
    box: "bg-violet-50 dark:bg-violet-500/10",
    icon: "text-violet-600 dark:text-violet-300",
  },
  warning: {
    label: "Warning",
    box: "bg-amber-50 dark:bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-300",
  },
  caution: {
    label: "Caution",
    box: "bg-rose-50 dark:bg-rose-500/10",
    icon: "text-rose-600 dark:text-rose-300",
  },
};

/** Bullets change shape by depth: • ◦ ▪ */
export function bulletClass(depth: number): string {
  const style = depth % 3;
  if (style === 1) return "rounded-full border-[1.5px] border-current bg-transparent";
  if (style === 2) return "rounded-[1px] bg-current";
  return "rounded-full bg-current";
}

export const CODE_LANGUAGES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "", label: "Plain text" },
  { id: "bash", label: "Bash" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "diff", label: "Diff" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "html", label: "HTML" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin" },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "python", label: "Python" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript" },
  { id: "yaml", label: "YAML" },
];
