import type { Kysely, Transaction } from "kysely";
import type { Database } from "./types";

export type DatabaseContext = Kysely<Database> | Transaction<Database>;
