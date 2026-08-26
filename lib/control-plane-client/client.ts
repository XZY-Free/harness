import { createAgentApiClient } from "./api/agents";
import { createArtifactApiClient } from "./api/artifacts";
import { createCredentialRefApiClient } from "./api/credentials";
import { createExecutionApiClient } from "./api/executions";
import { createProvisioningApiClient } from "./api/provisioning";
import { createPublicationApiClient } from "./api/publications";
import { createRouteApiClient } from "./api/routes";
import { createRuntimeApiClient } from "./api/runtimes";
import type { ApiClientConfig } from "./http-client";

/** Web Admin 与 Desktop Admin 共用的控制面客户端。 */
export function createControlPlaneClient(config: ApiClientConfig) {
  return {
    agents: createAgentApiClient(config),
    credentials: createCredentialRefApiClient(config),
    artifacts: createArtifactApiClient(config),
    executions: createExecutionApiClient(config),
    provisioning: createProvisioningApiClient(config),
    publications: createPublicationApiClient(config),
    routes: createRouteApiClient(config),
    runtimes: createRuntimeApiClient(config),
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
