import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import {
  getSlackChannel,
  listSlackMemberChannels,
  type SlackChannelSummary,
  type SlackConfig,
} from "../../integrations/providers/slack.js";
import {
  customerChannelInstructionsProblem,
  type CustomerChannelReplyMode,
} from "../../../shared/customerChannels.js";
import { normalizeInstructionsText } from "../../../shared/instructionsText.js";
import { decryptConnectionConfig } from "../integrations.js";
import { getActiveModel } from "../models.js";
import { isModelConnected } from "../providers.js";
import { workBlocked } from "../standdowns.js";

/**
 * Linking, changing and unlinking customer channels, and describing them.
 *
 * Every check that decides whether a channel can be linked lives here rather
 * than in the route: the Connection is a Slack one in this company, the
 * Customer and the AI Employee are this company's, the employee is granted
 * the Connection (it posts as that Slack app), and Slack itself says the app
 * is in the channel. The last one is asked of Slack at link time rather than
 * trusted from the picker, because a picker is a list someone could have
 * loaded an hour ago.
 */

/** Surfaces a customer channel can be linked on. */
export const CUSTOMER_CHANNEL_PROVIDERS = ["slack"] as const;

export class CustomerChannelError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "CustomerChannelError";
  }
}

export function customerChannelFailure(err: unknown): { status: number; message: string } | null {
  return err instanceof CustomerChannelError ? { status: err.status, message: err.message } : null;
}

function repo() {
  return AppDataSource.getRepository(CustomerChannel);
}

async function loadSlackConnection(
  companyId: string,
  connectionId: string,
): Promise<{ connection: IntegrationConnection; config: SlackConfig }> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
  });
  if (!connection) throw new CustomerChannelError("Connection not found.", 404);
  if (!(CUSTOMER_CHANNEL_PROVIDERS as readonly string[]).includes(connection.provider)) {
    throw new CustomerChannelError("Customer channels work on Slack Connections only.");
  }
  const config = decryptConnectionConfig(connection) as SlackConfig;
  if (!config.botToken) {
    throw new CustomerChannelError("This Slack Connection has no bot token. Reconnect it first.");
  }
  return { connection, config };
}

/** Turn a Slack failure into words for the person picking a channel. */
async function askSlack<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new CustomerChannelError(err instanceof Error ? err.message : String(err), 502);
  }
}

async function requireCustomer(companyId: string, customerId: string): Promise<Customer> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: customerId,
    companyId,
  });
  if (!customer) throw new CustomerChannelError("Customer not found.", 404);
  if (customer.archivedAt) {
    throw new CustomerChannelError(
      "That Customer is archived. Restore it before linking a channel.",
    );
  }
  return customer;
}

async function requireGrantedEmployee(
  companyId: string,
  employeeId: string,
  connectionId: string,
): Promise<AIEmployee> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new CustomerChannelError("AI Employee not found.", 404);
  const granted = await AppDataSource.getRepository(EmployeeConnectionGrant).countBy({
    employeeId,
    connectionId,
  });
  if (!granted) {
    throw new CustomerChannelError(
      `${employee.name} is not granted this Slack Connection. Grant it under Access first — the employee posts in the channel as this Slack app.`,
    );
  }
  return employee;
}

function cleanInstructions(value: string): string {
  const problem = customerChannelInstructionsProblem(value);
  if (problem) throw new CustomerChannelError(problem);
  return normalizeInstructionsText(value);
}

export type LinkableChannel = SlackChannelSummary & {
  /** The customer channel already using it, so the picker can say so. */
  linkedCustomerChannelId: string | null;
};

/** The channels the Slack app is in, for the picker. */
export async function listLinkableChannels(
  companyId: string,
  connectionId: string,
): Promise<LinkableChannel[]> {
  const { config } = await loadSlackConnection(companyId, connectionId);
  const channels = await askSlack(() => listSlackMemberChannels(config.botToken));
  const linked = await repo().find({
    where: { connectionId },
    select: { id: true, externalChannelId: true },
  });
  const byChannel = new Map(linked.map((row) => [row.externalChannelId, row.id]));
  return channels.map((channel) => ({
    ...channel,
    linkedCustomerChannelId: byChannel.get(channel.id) ?? null,
  }));
}

export type LinkCustomerChannelInput = {
  companyId: string;
  connectionId: string;
  externalChannelId: string;
  customerId: string;
  employeeId: string;
  replyMode: CustomerChannelReplyMode;
  instructions: string;
  userId: string | null;
};

export async function linkCustomerChannel(
  input: LinkCustomerChannelInput,
): Promise<CustomerChannel> {
  const { connection, config } = await loadSlackConnection(input.companyId, input.connectionId);
  await requireCustomer(input.companyId, input.customerId);
  await requireGrantedEmployee(input.companyId, input.employeeId, connection.id);
  const instructions = cleanInstructions(input.instructions);

  const existing = await repo().findOneBy({
    connectionId: connection.id,
    externalChannelId: input.externalChannelId,
  });
  if (existing) {
    throw new CustomerChannelError("That channel is already linked to a Customer.", 409);
  }

  const channel = await askSlack(() => getSlackChannel(config.botToken, input.externalChannelId));
  if (!channel) throw new CustomerChannelError("Slack does not recognise that channel.", 404);
  if (channel.isArchived) throw new CustomerChannelError("That Slack channel is archived.");
  if (!channel.isMember) {
    throw new CustomerChannelError(
      `The Slack app is not in #${channel.name || channel.id}. Invite it there with /invite, then try again.`,
    );
  }

  return repo().save(
    repo().create({
      companyId: input.companyId,
      provider: connection.provider,
      connectionId: connection.id,
      externalChannelId: channel.id,
      name: channel.name,
      shared: channel.isShared,
      customerId: input.customerId,
      employeeId: input.employeeId,
      replyMode: input.replyMode,
      instructions,
      lastMessageAt: null,
      lastNotedAt: null,
      notesAttemptedAt: null,
      notesError: "",
      createdById: input.userId,
    }),
  );
}

export type CustomerChannelPatch = {
  customerId?: string;
  employeeId?: string | null;
  replyMode?: CustomerChannelReplyMode;
  instructions?: string;
};

export async function requireCustomerChannel(
  companyId: string,
  id: string,
): Promise<CustomerChannel> {
  const row = await repo().findOneBy({ id, companyId });
  if (!row) throw new CustomerChannelError("Customer channel not found.", 404);
  return row;
}

export async function updateCustomerChannel(
  companyId: string,
  id: string,
  patch: CustomerChannelPatch,
): Promise<{ before: CustomerChannel; after: CustomerChannel }> {
  const row = await requireCustomerChannel(companyId, id);
  const before = { ...row };
  if (patch.customerId !== undefined && patch.customerId !== row.customerId) {
    await requireCustomer(companyId, patch.customerId);
    row.customerId = patch.customerId;
  }
  if (patch.employeeId !== undefined && patch.employeeId !== row.employeeId) {
    if (patch.employeeId) {
      await requireGrantedEmployee(companyId, patch.employeeId, row.connectionId);
    }
    row.employeeId = patch.employeeId;
  }
  if (patch.replyMode !== undefined) row.replyMode = patch.replyMode;
  if (patch.instructions !== undefined) row.instructions = cleanInstructions(patch.instructions);
  // A change of who works the channel, or of what they are told, is a fresh
  // start for the note writer: the last error described the old setup.
  row.notesError = "";
  const after = await repo().save(row);
  return { before, after };
}

export async function unlinkCustomerChannel(
  companyId: string,
  id: string,
): Promise<CustomerChannel> {
  const row = await requireCustomerChannel(companyId, id);
  // The notes already on the Customer's timeline stay: they are the record.
  // The kept messages were only working material for them.
  await AppDataSource.getRepository(CustomerChannelMessage).delete({ customerChannelId: row.id });
  await repo().delete({ id: row.id });
  return row;
}

export async function listCustomerChannels(
  companyId: string,
  filter: { connectionId?: string; customerId?: string } = {},
): Promise<CustomerChannel[]> {
  return repo().find({
    where: {
      companyId,
      ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    },
    order: { createdAt: "ASC" },
  });
}

/**
 * Why the employee will not write notes or answer here right now, or null
 * when it will. Messages are kept either way; this only decides AI work.
 */
export async function customerChannelProblem(channel: CustomerChannel): Promise<string | null> {
  if (!channel.employeeId) return "No AI Employee works this channel. Pick one to resume notes.";
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: channel.employeeId,
    companyId: channel.companyId,
  });
  if (!employee) return "No AI Employee works this channel. Pick one to resume notes.";
  const granted = await AppDataSource.getRepository(EmployeeConnectionGrant).countBy({
    employeeId: employee.id,
    connectionId: channel.connectionId,
  });
  if (!granted) return `${employee.name} is no longer granted this Slack Connection.`;
  const blocked = workBlocked(channel.companyId, { employeeId: employee.id });
  if (blocked.blocked)
    return `AI work is stood down${blocked.reason ? `: ${blocked.reason}` : ""}.`;
  let model = null;
  try {
    model = await getActiveModel(employee.id);
  } catch {
    model = null;
  }
  if (!model || !isModelConnected(model)) return `${employee.name} has no connected AI Model.`;
  return null;
}

export type CustomerChannelDto = {
  id: string;
  provider: string;
  connectionId: string;
  externalChannelId: string;
  name: string;
  shared: boolean;
  customer: { id: string; name: string; slug: string } | null;
  employee: { id: string; name: string; slug: string; role: string } | null;
  replyMode: CustomerChannelReplyMode;
  instructions: string;
  lastMessageAt: string | null;
  lastNotedAt: string | null;
  notesError: string;
  /** Messages kept since the last notes. */
  pendingMessages: number;
  /** Why no AI work happens here right now; null when it does. */
  problem: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function serializeCustomerChannels(
  rows: CustomerChannel[],
): Promise<CustomerChannelDto[]> {
  if (rows.length === 0) return [];
  const customerIds = [...new Set(rows.map((row) => row.customerId))];
  const employeeIds = [
    ...new Set(rows.map((row) => row.employeeId).filter((id): id is string => Boolean(id))),
  ];
  const [customers, employees, pending] = await Promise.all([
    AppDataSource.getRepository(Customer).findBy({ id: In(customerIds) }),
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).findBy({ id: In(employeeIds) })
      : Promise.resolve([] as AIEmployee[]),
    AppDataSource.getRepository(CustomerChannelMessage)
      .createQueryBuilder("message")
      .select("message.customerChannelId", "customerChannelId")
      .addSelect("COUNT(*)", "count")
      .where("message.customerChannelId IN (:...ids)", { ids: rows.map((row) => row.id) })
      .andWhere("message.notedAt IS NULL")
      .groupBy("message.customerChannelId")
      .getRawMany<{ customerChannelId: string; count: string | number }>(),
  ]);
  const customerById = new Map(customers.map((row) => [row.id, row]));
  const employeeById = new Map(employees.map((row) => [row.id, row]));
  const pendingById = new Map(pending.map((row) => [row.customerChannelId, Number(row.count)]));

  return Promise.all(
    rows.map(async (row) => {
      const customer = customerById.get(row.customerId);
      const employee = row.employeeId ? employeeById.get(row.employeeId) : undefined;
      return {
        id: row.id,
        provider: row.provider,
        connectionId: row.connectionId,
        externalChannelId: row.externalChannelId,
        name: row.name,
        shared: row.shared,
        customer: customer ? { id: customer.id, name: customer.name, slug: customer.slug } : null,
        employee: employee
          ? { id: employee.id, name: employee.name, slug: employee.slug, role: employee.role }
          : null,
        replyMode: row.replyMode,
        instructions: row.instructions,
        lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
        lastNotedAt: row.lastNotedAt ? row.lastNotedAt.toISOString() : null,
        notesError: row.notesError,
        pendingMessages: pendingById.get(row.id) ?? 0,
        problem: await customerChannelProblem(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  );
}

/** Kept messages not yet in notes — the note writer's work list, oldest first. */
export async function pendingMessages(
  customerChannelId: string,
  limit: number,
): Promise<CustomerChannelMessage[]> {
  return AppDataSource.getRepository(CustomerChannelMessage).find({
    where: { customerChannelId, notedAt: IsNull() },
    order: { postedAt: "ASC" },
    take: limit,
  });
}
