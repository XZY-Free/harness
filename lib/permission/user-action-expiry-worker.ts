import { expireDueUserActionRequests } from "@/lib/permission/user-action-expiry-queries";

export function createUserActionExpiryWorker() {
  return {
    pollOnce: () => expireDueUserActionRequests({ limit: 50 }),
    stop: () => undefined,
  };
}
