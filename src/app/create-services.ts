import { ContentReadService } from "../services/content-read";
import { ReaderContentStore } from "../storage/reader-content-store";
import type { Kysely } from "kysely";
import type { Database } from "../database/types";

export function createServices(database?: () => Kysely<Database> | undefined) {
  const readerContent = new ReaderContentStore(database);
  return {
    content: new ContentReadService(readerContent),
    flush: () => readerContent.flush(),
    dispose: () => readerContent.close(),
  };
}
