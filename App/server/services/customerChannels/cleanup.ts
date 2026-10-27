import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";

/**
 * What happens to customer channels when something they point at goes away.
 *
 * A module of its own, importing nothing but the database, because the
 * integrations service calls it on every deleted Connection — and the rest of
 * this feature reaches back into the integrations service for credentials.
 * Keeping the cleanup here keeps that pair from becoming an import cycle.
 */

/** Every customer channel on a Connection that is being deleted, with its kept messages. */
export async function deleteCustomerChannelsForConnection(connectionId: string): Promise<void> {
  const rows = await AppDataSource.getRepository(CustomerChannel).find({
    where: { connectionId },
    select: { id: true },
  });
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  await AppDataSource.getRepository(CustomerChannelMessage).delete({ customerChannelId: In(ids) });
  await AppDataSource.getRepository(CustomerChannel).delete({ id: In(ids) });
}

/**
 * A deleted AI Employee stops working its channels. The channels stay linked
 * and keep their messages, the way a Phone number stays reserved, so an admin
 * can hand them to someone else without anything being lost.
 */
export async function detachEmployeeFromCustomerChannels(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(CustomerChannel).update({ employeeId }, { employeeId: null });
}

/** How many customer channels name this Customer — a hard delete refuses while any do. */
export async function countCustomerChannelsForCustomer(
  companyId: string,
  customerId: string,
): Promise<number> {
  return AppDataSource.getRepository(CustomerChannel).countBy({ companyId, customerId });
}
