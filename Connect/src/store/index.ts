import { createMemoryStore } from "./memory.js";
import { createPostgresStore } from "./postgres.js";
import type { FlowStore } from "./types.js";

export type { FlowKey, FlowStore, StoredFlow } from "./types.js";
export { createMemoryStore } from "./memory.js";
export { createPostgresStore } from "./postgres.js";

export async function createStore(databaseUrl: string | null): Promise<FlowStore> {
  return databaseUrl ? createPostgresStore(databaseUrl) : createMemoryStore();
}
