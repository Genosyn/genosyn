/**
 * Tiny in-memory log accumulator with a hard byte cap. Mirrors the LogBuffer
 * used by the routine runner so a runaway pipeline can't blow up its row.
 */
export const PIPELINE_LOG_MAX_BYTES = 256 * 1024;

export class PipelineLog {
  private parts: string[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly cap: number = PIPELINE_LOG_MAX_BYTES) {}

  line(s: string): void {
    this.write(s + "\n");
  }

  write(s: string): void {
    if (!s || this.truncated) return;
    const b = Buffer.byteLength(s, "utf8");
    if (this.size + b <= this.cap) {
      this.parts.push(s);
      this.size += b;
      return;
    }
    const remaining = this.cap - this.size;
    if (remaining > 0) {
      this.parts.push(s.slice(0, remaining));
      this.size += Buffer.byteLength(s.slice(0, remaining), "utf8");
    }
    this.parts.push(`\n[truncated — output exceeded ${this.cap} bytes]\n`);
    this.truncated = true;
  }

  value(): string {
    return this.parts.join("");
  }
}
