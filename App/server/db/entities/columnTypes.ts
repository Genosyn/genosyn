import { config } from "../../../config.js";

/** TypeORM has no single explicit timestamp type accepted by both drivers. */
export const dateTimeColumnType = config.db.driver === "postgres" ? "timestamptz" : "datetime";
