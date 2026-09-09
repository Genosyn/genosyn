export function assertCodexThreadPosture(
  value: unknown,
  expected: { cwd: string; model: string },
): string {
  const response = asObject(value);
  const thread = asObject(response?.thread);
  const sandbox = asObject(response?.sandbox);
  const runtimeRoots = response?.runtimeWorkspaceRoots;
  const instructionSources = response?.instructionSources;
  if (!thread || !sandbox) {
    throw new Error("OpenAI Codex app-server did not honor Genosyn's requested thread isolation.");
  }
  const threadId = typeof thread.id === "string" && thread.id.length > 0 ? thread.id : null;
  const valid =
    threadId !== null &&
    thread.ephemeral === true &&
    thread.parentThreadId === null &&
    response?.model === expected.model &&
    response?.modelProvider === "openai" &&
    response?.cwd === expected.cwd &&
    thread.cwd === expected.cwd &&
    response?.approvalPolicy === "never" &&
    sandbox?.type === "readOnly" &&
    sandbox.networkAccess === false &&
    Array.isArray(runtimeRoots) &&
    runtimeRoots.length === 0 &&
    Array.isArray(instructionSources) &&
    instructionSources.length === 0;
  if (!valid) {
    throw new Error("OpenAI Codex app-server did not honor Genosyn's requested thread isolation.");
  }
  return threadId;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
