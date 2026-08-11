import type { AgentTool } from "../types.js";
import { bashTool } from "./codingBash.js";
import { editFileTool, listDirTool, readFileTool, writeFileTool } from "./codingFiles.js";
import { globTool, grepTool } from "./codingSearch.js";
import type { CodingToolContext } from "./codingShared.js";

/**
 * The built-in coding toolset — bash + focused file and search tools — shared
 * by every in-process model runtime. The facade keeps the public contract in a
 * single place while each implementation module owns one concern.
 */

export type { CodingToolContext } from "./codingShared.js";

/** Names used by callers that validate availability without building tools. */
export const CODING_TOOL_NAMES = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
] as const;

export function codingTools(ctx: CodingToolContext): AgentTool[] {
  return [
    bashTool(ctx),
    readFileTool(ctx),
    writeFileTool(ctx),
    editFileTool(ctx),
    listDirTool(ctx),
    globTool(ctx),
    grepTool(ctx),
  ];
}
