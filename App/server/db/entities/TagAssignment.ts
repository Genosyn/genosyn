import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type TaggableResourceType =
  | "routine"
  | "skill"
  | "resource"
  | "project"
  | "base"
  | "notebook"
  | "note"
  | "pipeline"
  | "code_repository"
  | "chart"
  | "dashboard";

/**
 * Polymorphic join between a company Tag and one taggable resource.
 *
 * Resource ownership is verified by the tagging service before writes. A
 * conventional foreign key cannot target several tables, so delete paths use
 * the same service to remove assignments alongside their resource.
 */
@Entity("tag_assignments")
@Index(["tagId"])
@Index(["resourceType", "resourceId"])
@Index(["tagId", "resourceType", "resourceId"], { unique: true })
export class TagAssignment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  tagId!: string;

  @Column({ type: "varchar" })
  resourceType!: TaggableResourceType;

  @Column({ type: "varchar" })
  resourceId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
