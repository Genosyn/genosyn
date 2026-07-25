import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Company } from "../../db/entities/Company.js";
import { Deal } from "../../db/entities/Deal.js";
import { Notification } from "../../db/entities/Notification.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { createNotification } from "../notifications.js";

type DueReminder = {
  companyId: string;
  userId: string;
  entityId: string;
  title: string;
  body: string;
  path: (companySlug: string) => string;
};

function displayDue(value: Date | null): string {
  return value ? `Due ${value.toISOString()}` : "Open the follow-up queue for details.";
}

/**
 * Deliver due Revenue reminders to human assignees/owners. The composite
 * entity id includes the reminder timestamp, which makes each scheduled
 * reminder idempotent while allowing a rescheduled reminder to fire again.
 *
 * AI Employees consume the same due work from `list_follow_ups`; they do not
 * receive human bell/push notifications.
 */
export async function dispatchDueFollowUpReminders(now = new Date()): Promise<number> {
  const [tasks, deals, partnerships] = await Promise.all([
    AppDataSource.getRepository(Activity)
      .createQueryBuilder("activity")
      .where("activity.kind = 'task'")
      .andWhere("activity.taskStatus = 'open'")
      .andWhere("activity.assignedUserId IS NOT NULL")
      .andWhere("activity.reminderAt IS NOT NULL")
      .andWhere("activity.reminderAt <= :now", { now })
      .getMany(),
    AppDataSource.getRepository(Deal)
      .createQueryBuilder("deal")
      .where("deal.status = 'open'")
      .andWhere("deal.archivedAt IS NULL")
      .andWhere("deal.ownerId IS NOT NULL")
      .andWhere("deal.followUpReminderAt IS NOT NULL")
      .andWhere("deal.followUpReminderAt <= :now", { now })
      .getMany(),
    AppDataSource.getRepository(Partnership)
      .createQueryBuilder("partnership")
      .where("partnership.archivedAt IS NULL")
      .andWhere("partnership.ownerId IS NOT NULL")
      .andWhere("partnership.reminderAt IS NOT NULL")
      .andWhere("partnership.reminderAt <= :now", { now })
      .getMany(),
  ]);
  const reminders: DueReminder[] = [
    ...tasks.map((task) => ({
      companyId: task.companyId,
      userId: task.assignedUserId!,
      entityId: `task:${task.id}:${task.reminderAt!.toISOString()}`,
      title: task.subject || "Revenue follow-up",
      body: displayDue(task.dueAt),
      path: (slug: string) =>
        task.dealId
          ? `/c/${slug}/revenue/deals/${task.dealId}`
          : task.partnershipId
            ? `/c/${slug}/revenue/partnerships/${task.partnershipId}`
            : task.contactId
              ? `/c/${slug}/revenue/contacts/${task.contactId}`
              : `/c/${slug}/revenue/follow-ups`,
    })),
    ...deals.map((deal) => ({
      companyId: deal.companyId,
      userId: deal.ownerId!,
      entityId: `deal:${deal.id}:${deal.followUpReminderAt!.toISOString()}`,
      title: `Follow up on ${deal.title}`,
      body: deal.nextStep || displayDue(deal.nextFollowUpAt),
      path: (slug: string) => `/c/${slug}/revenue/deals/${deal.id}`,
    })),
    ...partnerships.map((partnership) => ({
      companyId: partnership.companyId,
      userId: partnership.ownerId!,
      entityId: `partnership:${partnership.id}:${partnership.reminderAt!.toISOString()}`,
      title: `Follow up with ${partnership.name}`,
      body: displayDue(partnership.nextFollowUpAt),
      path: (slug: string) => `/c/${slug}/revenue/partnerships/${partnership.id}`,
    })),
  ];
  if (reminders.length === 0) return 0;
  const companyIds = [...new Set(reminders.map((reminder) => reminder.companyId))];
  const companies = await AppDataSource.getRepository(Company).find({
    where: { id: In(companyIds) },
  });
  const slugById = new Map(companies.map((company) => [company.id, company.slug]));
  let created = 0;
  for (const reminder of reminders) {
    const existing = await AppDataSource.getRepository(Notification).findOneBy({
      companyId: reminder.companyId,
      userId: reminder.userId,
      kind: "revenue_follow_up",
      entityKind: "revenue_follow_up",
      entityId: reminder.entityId,
    });
    const slug = slugById.get(reminder.companyId);
    if (existing || !slug) continue;
    await createNotification({
      companyId: reminder.companyId,
      userId: reminder.userId,
      kind: "revenue_follow_up",
      title: reminder.title,
      body: reminder.body,
      link: reminder.path(slug),
      actorKind: "system",
      entityKind: "revenue_follow_up",
      entityId: reminder.entityId,
    });
    created += 1;
  }
  return created;
}
