import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Instance-level key/value settings the server generates and persists for
 * itself — not user-editable config (that lives in `config.ts`) and not
 * company data. First use: the VAPID keypair for Web Push, generated once
 * at first boot so self-hosted operators get push notifications with zero
 * setup.
 */
@Entity("app_settings")
export class AppSetting {
  @PrimaryColumn({ type: "varchar" })
  key!: string;

  @Column({ type: "text" })
  value!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
