import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type BrowserSessionStatus = "pending" | "live" | "closed" | "expired";
export type BrowserSessionCloseReason =
  | "idle"
  | "shutdown"
  | "error"
  | "manual"
  | null;

/**
 * One live-view session of the built-in `browser` MCP server. Created at
 * spawn time when an employee with `browserEnabled = true` is about to run
 * (chat or routine). Carries the bookkeeping the App needs to:
 *
 *   - Auth the MCP child's outbound WebSocket to the App
 *     (`mcpToken` — distinct from the per-spawn `GENOSYN_MCP_TOKEN`).
 *   - Auth viewer iframes opened by humans in the same company.
 *   - Show the live page URL/title in the panel header without forcing the
 *     viewer to subscribe just to render context.
 *
 * Frames are not stored in the DB — they live in the in-memory fanout hub
 * (`services/browserSessions.ts`) for the duration of the session. When the
 * MCP child closes (manual, idle watchdog, or process exit) the row flips
 * to `closed` with a reason; spawns whose token expires before any frame
 * arrives flip to `expired`.
 */
@Entity("browser_sessions")
@Index(["employeeId", "status"])
@Index(["mcpToken"], { unique: true })
export class BrowserSession {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  /** Conversation that triggered the spawn (when chat-spawned). */
  @Column({ type: "varchar", nullable: true })
  conversationId!: string | null;

  /** Run that triggered the spawn (when routine-spawned). */
  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  /**
   * Bearer token the MCP child uses on its outbound `/api/internal/mcp/
   * browser-sessions/:id/stream` WebSocket. Random hex, scoped to this
   * session only — distinct from the per-spawn `GENOSYN_MCP_TOKEN` so a
   * single token leak doesn't cross trust boundaries.
   */
  @Column({ type: "varchar" })
  mcpToken!: string;

  @Column({ type: "datetime" })
  mcpTokenExpiresAt!: Date;

  /**
   * Lifecycle:
   *   `pending`  — row created at spawn; MCP hasn't connected yet
   *   `live`     — MCP connected and streaming frames
   *   `closed`   — MCP closed cleanly (idle / shutdown / manual)
   *   `expired`  — token TTL passed without ever going live
   */
  @Column({ type: "varchar", default: "pending" })
  status!: BrowserSessionStatus;

  @Column({ type: "varchar", nullable: true })
  closeReason!: BrowserSessionCloseReason;

  /** Last-seen page URL, refreshed by the MCP on `Page.frameNavigated`. */
  @Column({ type: "text", default: "" })
  pageUrl!: string;

  /** Last-seen page title, refreshed alongside `pageUrl`. */
  @Column({ type: "varchar", nullable: true })
  pageTitle!: string | null;

  @Column({ type: "integer", default: 1280 })
  viewportWidth!: number;

  @Column({ type: "integer", default: 800 })
  viewportHeight!: number;

  /** Set when the first frame is ingested (status: pending → live). */
  @Column({ type: "datetime", nullable: true })
  startedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
