// Dedicated entrypoint for the TypeORM CLI. It requires a file that exports
// exactly one DataSource -- nothing else. Application code imports from
// `server/db/datasource.ts` instead.
import { AppDataSource } from "./server/db/datasource.js";

export default AppDataSource;
