import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository, type RepositoryKind } from "../db/entities/Repository.js";
import {
  RepositoryWorkSession,
  REVISABLE_WORK_SESSION_STATUSES,
  type RepositoryWorkSessionStatus,
} from "../db/entities/RepositoryWorkSession.js";
import { clip } from "./repositoryAiOverview.js";

export type HomeRepositoryWork = {
  id: string;
  title: string;
  status: RepositoryWorkSessionStatus;
  filesChanged: number;
  insertions: number;
  deletions: number;
  updatedAt: string;
  repository: { id: string; name: string; slug: string; kind: RepositoryKind };
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
};

/**
 * The same attention queue as each Repository's AI work inbox, across the
 * company. Every Member may read sessions, regardless of who requested them.
 * Archived work is filed away; running work and accepted or discarded work
 * need no next move. The remaining states accept a Member's review or reply.
 *
 * Read only persisted summaries. An unreachable remote must never hide work
 * needing attention, and Home has no need for a checkout or full transcript.
 */
export async function listHomeRepositoryWork(params: {
  companyId: string;
  offset?: number;
  limit?: number;
}): Promise<{ items: HomeRepositoryWork[]; total: number }> {
  const { companyId, offset = 0, limit = 8 } = params;
  const [sessions, total] = await AppDataSource.getRepository(RepositoryWorkSession)
    .createQueryBuilder("session")
    .innerJoin(
      Repository,
      "repository",
      "repository.id = session.repositoryId AND repository.companyId = :companyId",
      { companyId },
    )
    .where({
      companyId,
      status: In(REVISABLE_WORK_SESSION_STATUSES),
      archivedAt: IsNull(),
    })
    .select([
      "session.id",
      "session.repositoryId",
      "session.employeeId",
      "session.title",
      "session.instruction",
      "session.status",
      "session.filesChanged",
      "session.insertions",
      "session.deletions",
      "session.updatedAt",
    ])
    .orderBy("session.updatedAt", "DESC")
    .addOrderBy("session.id", "ASC")
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  if (sessions.length === 0) return { items: [], total };

  const [repositories, employees] = await Promise.all([
    AppDataSource.getRepository(Repository).find({
      where: { companyId, id: In([...new Set(sessions.map((session) => session.repositoryId))]) },
      select: ["id", "name", "slug", "kind"],
    }),
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId, id: In([...new Set(sessions.map((session) => session.employeeId))]) },
      select: ["id", "name", "slug", "avatarKey"],
    }),
  ]);
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

  const items = sessions.flatMap((session): HomeRepositoryWork[] => {
    // A repository may have been removed between the two reads. Do not offer
    // a broken destination, or hydrate a company-mismatched employee.
    const repository = repositoryById.get(session.repositoryId);
    if (!repository) return [];
    const employee = employeeById.get(session.employeeId);
    return [
      {
        id: session.id,
        title: clip(session.title.trim() || session.instruction, 200) || "Untitled work session",
        status: session.status,
        filesChanged: session.filesChanged,
        insertions: session.insertions,
        deletions: session.deletions,
        updatedAt: session.updatedAt.toISOString(),
        repository: {
          id: repository.id,
          name: repository.name,
          slug: repository.slug,
          kind: repository.kind,
        },
        employee: employee
          ? {
              id: employee.id,
              name: employee.name,
              slug: employee.slug,
              avatarKey: employee.avatarKey ?? null,
            }
          : null,
      },
    ];
  });

  return { items, total };
}
