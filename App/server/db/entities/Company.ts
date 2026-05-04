import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type BrowserBackend = "local" | "browserbase";

@Entity("companies")
export class Company {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", unique: true })
  slug!: string;

  @Column({ type: "varchar" })
  ownerId!: string;

  /**
   * Which browser backend the company's AI employees use when
   * `AIEmployee.browserEnabled` is on.
   *
   *   * `local` (default) — headless Chromium bundled in the App container.
   *   * `browserbase` — open a session against api.browserbase.com using
   *     the company's `browserbaseApiKey` + `browserbaseProjectId`. Useful
   *     for self-hosters who don't want to bundle Chromium, or for sites
   *     that need a residential IP / persistent cookie store.
   */
  @Column({ type: "varchar", default: "local" })
  browserBackend!: BrowserBackend;

  /**
   * AES-256-GCM encrypted Browserbase API key (via `lib/secret.ts`).
   * Stored encrypted because the key authenticates billing actions; decrypt
   * just-in-time when materializing MCP env vars.
   */
  @Column({ type: "text", nullable: true })
  browserbaseApiKeyEnc!: string | null;

  /** Browserbase project id — opaque to us, passed straight through. */
  @Column({ type: "varchar", nullable: true })
  browserbaseProjectId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
