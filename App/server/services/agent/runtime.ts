import { runOpenCodeTurn } from "./opencodeRuntime.js";

/** Shared execution boundary for employee turns and AI Model connection checks. */
export const agentRuntime = { run: runOpenCodeTurn };
