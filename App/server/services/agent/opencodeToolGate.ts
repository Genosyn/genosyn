import type { Part } from "@opencode-ai/sdk/v2";
import { OPENCODE_MCP } from "./opencodeConfig.js";

type WaitingCall = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Order the MCP execution channel behind the model's streamed tool event. */
export class OpenCodeToolGate {
  private observed = new Set<string>();
  private ready = new Map<string, number>();
  private waiting = new Map<string, WaitingCall[]>();
  private closed = false;
  private abort = () => this.close();

  constructor(private signal?: AbortSignal) {
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.close();
  }

  observe(part: Part): void {
    if (
      this.closed ||
      part.type !== "tool" ||
      !part.tool.startsWith(`${OPENCODE_MCP}_`) ||
      part.state.status !== "running" ||
      this.observed.has(part.id)
    )
      return;
    this.observed.add(part.id);
    const call = this.waiting.get(part.tool)?.shift();
    if (call) {
      clearTimeout(call.timer);
      call.resolve();
    } else this.ready.set(part.tool, (this.ready.get(part.tool) ?? 0) + 1);
  }

  enter(wireName: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The Genosyn turn has ended."));
    const name = `${OPENCODE_MCP}_${wireName}`;
    const ready = this.ready.get(name) ?? 0;
    if (ready > 0) {
      this.ready.set(name, ready - 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const call: WaitingCall = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = this.waiting.get(name);
          if (pending)
            this.waiting.set(
              name,
              pending.filter((item) => item !== call),
            );
          reject(
            new Error(
              "OpenCode did not report the Genosyn tool call before its execution deadline.",
            ),
          );
        }, 30_000),
      };
      this.waiting.set(name, [...(this.waiting.get(name) ?? []), call]);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    for (const calls of this.waiting.values())
      for (const call of calls) {
        clearTimeout(call.timer);
        call.reject(new Error("The Genosyn turn has ended."));
      }
    this.waiting.clear();
    this.ready.clear();
    this.observed.clear();
  }
}
