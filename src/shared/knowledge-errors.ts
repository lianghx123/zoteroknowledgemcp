import { t } from "./localization";
/** Expected operation failures whose messages are safe and useful in the UI. */
export class KnowledgeUserError extends Error {}

export function knowledgeErrorMessage(error: unknown, fallback = t("error-operation")): string {
  return error instanceof KnowledgeUserError ? error.message : fallback;
}
