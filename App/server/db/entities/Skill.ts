import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("skills")
@Index(["employeeId", "slug"], { unique: true })
export class Skill {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  employeeId!: string;

  @Column()
  name!: string;

  @Column()
  slug!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
