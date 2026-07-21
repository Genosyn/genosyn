import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/** Encrypted, single-use OAuth/OIDC handshake state shared by every replica. */
@Entity("auth_flow_states")
@Index(["tokenHash"], { unique: true })
@Index(["expiresAt"])
export class AuthFlowState {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  tokenHash!: string;

  @Column({ type: "varchar" })
  kind!: string;

  @Column({ type: "text" })
  payloadEncrypted!: string;

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
