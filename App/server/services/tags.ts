import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { Chart } from "../db/entities/Chart.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { Resource } from "../db/entities/Resource.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Tag } from "../db/entities/Tag.js";
import { TagAssignment, TaggableResourceType } from "../db/entities/TagAssignment.js";
import { randomTagColor, TagColor } from "../lib/tagColors.js";

export const TAGGABLE_RESOURCE_TYPES = [
  "routine",
  "skill",
  "resource",
  "project",
  "base",
  "notebook",
  "note",
  "pipeline",
  "code_repository",
  "chart",
  "dashboard",
] as const satisfies readonly TaggableResourceType[];

export type CompanyTag = Tag & { usageCount: number };

export class TagConflictError extends Error {}

export class InvalidCompanyTagError extends Error {}

export function cleanTagName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeTagName(value: string): string {
  return cleanTagName(value).toLocaleLowerCase("en-US");
}

export async function listCompanyTags(companyId: string): Promise<CompanyTag[]> {
  const tags = await AppDataSource.getRepository(Tag).find({
    where: { companyId },
    order: { name: "ASC" },
  });
  if (tags.length === 0) return [];
  const assignments = await AppDataSource.getRepository(TagAssignment).find({
    where: { tagId: In(tags.map((tag) => tag.id)) },
  });
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    counts.set(assignment.tagId, (counts.get(assignment.tagId) ?? 0) + 1);
  }
  return tags.map((tag) => Object.assign(tag, { usageCount: counts.get(tag.id) ?? 0 }));
}

export async function createCompanyTag(
  companyId: string,
  rawName: string,
  color: TagColor = randomTagColor(),
): Promise<Tag> {
  const name = cleanTagName(rawName).slice(0, 50);
  const normalizedName = normalizeTagName(name);
  const repo = AppDataSource.getRepository(Tag);
  const existing = await repo.findOneBy({ companyId, normalizedName });
  if (existing) return existing;
  return repo.save(repo.create({ companyId, name, normalizedName, color }));
}

export async function updateCompanyTag(
  companyId: string,
  tagId: string,
  updates: { name?: string; color?: TagColor },
): Promise<Tag | null> {
  const repo = AppDataSource.getRepository(Tag);
  const tag = await repo.findOneBy({ id: tagId, companyId });
  if (!tag) return null;
  if (updates.name !== undefined) {
    const name = cleanTagName(updates.name).slice(0, 50);
    const normalizedName = normalizeTagName(name);
    const duplicate = await repo.findOneBy({ companyId, normalizedName });
    if (duplicate && duplicate.id !== tag.id) {
      throw new TagConflictError(`The tag "${duplicate.name}" already exists.`);
    }
    tag.name = name;
    tag.normalizedName = normalizedName;
  }
  if (updates.color !== undefined) tag.color = updates.color;
  await repo.save(tag);
  if (updates.name !== undefined) await syncLegacyResourceTagsForTag(tag.id);
  return tag;
}

export async function deleteCompanyTag(companyId: string, tagId: string): Promise<Tag | null> {
  const tagRepo = AppDataSource.getRepository(Tag);
  const tag = await tagRepo.findOneBy({ id: tagId, companyId });
  if (!tag) return null;
  const assignmentRepo = AppDataSource.getRepository(TagAssignment);
  const affectedResources = await assignmentRepo.find({
    where: { tagId, resourceType: "resource" },
  });
  await AppDataSource.transaction(async (manager) => {
    await manager.getRepository(TagAssignment).delete({ tagId });
    await manager.getRepository(Tag).delete({ id: tagId, companyId });
  });
  for (const assignment of affectedResources) {
    await syncLegacyResourceTags(assignment.resourceId);
  }
  return tag;
}

export async function tagsByResourceIds(
  companyId: string,
  resourceType: TaggableResourceType,
  resourceIds: string[],
): Promise<Map<string, Tag[]>> {
  const result = new Map<string, Tag[]>();
  for (const id of resourceIds) result.set(id, []);
  if (resourceIds.length === 0) return result;
  const assignments = await AppDataSource.getRepository(TagAssignment).find({
    where: { resourceType, resourceId: In(resourceIds) },
  });
  if (assignments.length === 0) return result;
  const tags = await AppDataSource.getRepository(Tag).find({
    where: { companyId, id: In([...new Set(assignments.map((a) => a.tagId))]) },
  });
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  for (const assignment of assignments) {
    const tag = tagById.get(assignment.tagId);
    if (tag) result.get(assignment.resourceId)?.push(tag);
  }
  for (const rows of result.values()) rows.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function tagsForResource(
  companyId: string,
  resourceType: TaggableResourceType,
  resourceId: string,
): Promise<Tag[]> {
  return (await tagsByResourceIds(companyId, resourceType, [resourceId])).get(resourceId) ?? [];
}

export async function validateCompanyTagIds(
  companyId: string,
  rawTagIds: string[],
): Promise<Tag[]> {
  const tagIds = [...new Set(rawTagIds)];
  const tags = tagIds.length
    ? await AppDataSource.getRepository(Tag).find({ where: { companyId, id: In(tagIds) } })
    : [];
  if (tags.length !== tagIds.length) {
    throw new InvalidCompanyTagError("One or more tags do not belong to this company");
  }
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return tags;
}

async function directResourceBelongsToCompany(
  companyId: string,
  resourceType: Exclude<TaggableResourceType, "routine" | "skill">,
  resourceId: string,
): Promise<boolean> {
  switch (resourceType) {
    case "resource":
      return !!(await AppDataSource.getRepository(Resource).findOneBy({
        id: resourceId,
        companyId,
      }));
    case "project":
      return !!(await AppDataSource.getRepository(Project).findOneBy({
        id: resourceId,
        companyId,
      }));
    case "base":
      return !!(await AppDataSource.getRepository(Base).findOneBy({ id: resourceId, companyId }));
    case "notebook":
      return !!(await AppDataSource.getRepository(Notebook).findOneBy({
        id: resourceId,
        companyId,
      }));
    case "note":
      return !!(await AppDataSource.getRepository(Note).findOneBy({ id: resourceId, companyId }));
    case "pipeline":
      return !!(await AppDataSource.getRepository(Pipeline).findOneBy({
        id: resourceId,
        companyId,
      }));
    case "code_repository":
      return !!(await AppDataSource.getRepository(CodeRepository).findOneBy({
        id: resourceId,
        companyId,
      }));
    case "chart":
      return !!(await AppDataSource.getRepository(Chart).findOneBy({ id: resourceId, companyId }));
    case "dashboard":
      return !!(await AppDataSource.getRepository(Dashboard).findOneBy({
        id: resourceId,
        companyId,
      }));
  }
}

export async function taggableResourceExists(
  companyId: string,
  resourceType: TaggableResourceType,
  resourceId: string,
): Promise<boolean> {
  if (resourceType === "routine") {
    const row = await AppDataSource.getRepository(Routine).findOneBy({ id: resourceId });
    if (!row) return false;
    return !!(await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: row.employeeId,
      companyId,
    }));
  }
  if (resourceType === "skill") {
    const row = await AppDataSource.getRepository(Skill).findOneBy({ id: resourceId });
    if (!row) return false;
    return !!(await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: row.employeeId,
      companyId,
    }));
  }
  return directResourceBelongsToCompany(companyId, resourceType, resourceId);
}

export async function replaceResourceTags(
  companyId: string,
  resourceType: TaggableResourceType,
  resourceId: string,
  rawTagIds: string[],
): Promise<Tag[]> {
  const tagIds = [...new Set(rawTagIds)];
  const exists = await taggableResourceExists(companyId, resourceType, resourceId);
  if (!exists) throw new Error("Resource not found");
  const tags = await validateCompanyTagIds(companyId, tagIds);
  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(TagAssignment);
    await repo.delete({ resourceType, resourceId });
    if (tagIds.length) {
      await repo.save(tagIds.map((tagId) => repo.create({ tagId, resourceType, resourceId })));
    }
  });
  if (resourceType === "resource") {
    await AppDataSource.getRepository(Resource).update(
      { id: resourceId, companyId },
      { tags: tags.map((tag) => tag.name).join(", ") },
    );
  }
  return tags;
}

export async function replaceResourceTagNames(
  companyId: string,
  resourceType: TaggableResourceType,
  resourceId: string,
  names: string,
): Promise<Tag[]> {
  const parsed = [
    ...new Set(
      names
        .split(",")
        .map((name) => cleanTagName(name).slice(0, 50))
        .filter(Boolean),
    ),
  ].slice(0, 20);
  const tags: Tag[] = [];
  for (const name of parsed) tags.push(await createCompanyTag(companyId, name));
  return replaceResourceTags(
    companyId,
    resourceType,
    resourceId,
    tags.map((tag) => tag.id),
  );
}

export async function deleteTagAssignments(
  resourceType: TaggableResourceType,
  resourceId: string,
): Promise<void> {
  await AppDataSource.getRepository(TagAssignment).delete({ resourceType, resourceId });
}

async function syncLegacyResourceTags(resourceId: string): Promise<void> {
  const resource = await AppDataSource.getRepository(Resource).findOneBy({ id: resourceId });
  if (!resource) return;
  const tags = await tagsForResource(resource.companyId, "resource", resource.id);
  await AppDataSource.getRepository(Resource).update(
    { id: resource.id },
    { tags: tags.map((tag) => tag.name).join(", ") },
  );
}

async function syncLegacyResourceTagsForTag(tagId: string): Promise<void> {
  const assignments = await AppDataSource.getRepository(TagAssignment).find({
    where: { tagId, resourceType: "resource" },
  });
  for (const assignment of assignments) await syncLegacyResourceTags(assignment.resourceId);
}

/** Import M18's original comma-separated Resource tags into the shared catalog. */
export async function backfillLegacyResourceTags(): Promise<void> {
  const resources = await AppDataSource.getRepository(Resource).find({
    where: { tags: Not("") },
  });
  for (const resource of resources) {
    const existing = await AppDataSource.getRepository(TagAssignment).count({
      where: { resourceType: "resource", resourceId: resource.id },
    });
    if (existing === 0) {
      await replaceResourceTagNames(resource.companyId, "resource", resource.id, resource.tags);
    }
  }
}

/** Assign a stable random palette entry to tags created before colors shipped. */
export async function backfillTagColors(): Promise<void> {
  const repo = AppDataSource.getRepository(Tag);
  const tags = await repo.find({ where: { color: IsNull() } });
  for (const tag of tags) {
    tag.color = randomTagColor();
  }
  if (tags.length > 0) await repo.save(tags);
}
