import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type McpTransport = "stdio" | "http";

/**
 * Per-employee MCP (Model Context Protocol) server config. Before each spawn
 * (chat or routine), the runner materializes all enabled MCP servers for
 * this employee into a `.mcp.json` at their workspace root so the CLI picks
 * them up in standard Claude Code format.
 *
 * Transport options:
 *  - `stdio`: spawn a local process (`command` + `args` + `env`)
 *  - `http`:  hit a remote URL (`url`)
 */
@Entity("mcp_servers")
@Index(["employeeId", "name"], { unique: true })
export class McpServer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  transport!: McpTransport;

  /** stdio: the command to exec. Null for http. */
  @Column({ type: "varchar", nullable: true })
  command!: string | null;

  /** stdio: JSON-encoded string[]. Null for http. */
  @Column({ type: "text", nullable: true })
  argsJson!: string | null;

  /** JSON-encoded Record<string,string> of env vars. Nullable. */
  @Column({ type: "text", nullable: true })
  envJson!: string | null;

  /** http: server URL. Null for stdio. */
  @Column({ type: "varchar", nullable: true })
  url!: string | null;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
