import {
  type EnterpriseUserAdapterRegistry,
  getEnterpriseUserAdapter,
} from "@/lib/identity/enterprise-user-adapter";

/** Process bootstrap readiness gate; private deployment adapters register before this call. */
export function assertEnterpriseUserAdapterReady(registry?: EnterpriseUserAdapterRegistry): void {
  if (registry) {
    registry.resolve();
    return;
  }
  getEnterpriseUserAdapter();
}
