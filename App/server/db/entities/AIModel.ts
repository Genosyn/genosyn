import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type Provider = "claude-code" | "codex" | "opencode";

@Entity("ai_models")
export class AIModel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  companyId!: string;

  @Column()
  name!: string;

  @Column()
  provider!: Provider;

  @Column()
  model!: string;

  @Column({ type: "text", default: "{}" })
  configJson!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
