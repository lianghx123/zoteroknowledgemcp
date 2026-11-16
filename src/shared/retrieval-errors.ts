import { t } from "./localization";

export function retrievalErrorMessage(code: string): string {
  const key = code === "initializing" ? "initializing" : code === "credentials" ? "credentials" : code === "config" || code === "config-changed" ? "config"
    : code === "network" || /^http-(408|425|429|5\d\d)$/.test(code) ? "network"
      : /response|protocol|dimensions/.test(code) ? "protocol" : /vector|index|recovery-failed|service-closed/.test(code) ? "index" : "provider";
  return t(`vector-error-${key}`);
}
