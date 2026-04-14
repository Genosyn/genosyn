import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type Provider = "claude-code" | "codex" | "opencode";

@Entity("ai_models")
export class AIModel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  provider!: Provider;

  @Column({ type: "varchar" })
  model!: string;

  @Column({ type: "text", default: "{}" })
  configJson!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
