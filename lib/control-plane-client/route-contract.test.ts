import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACTS = [
  ["agents.ts", "/admin/api/agents", "app/admin/api/agents/route.ts", "GET"],
  ["agents.ts", "/admin/api/agents/${agentId}", "app/admin/api/agents/[agentId]/route.ts", "GET"],
  [
    "agents.ts",
    "/admin/api/agents/${agentId}/revisions",
    "app/admin/api/agents/[agentId]/revisions/route.ts",
    "GET",
  ],
  [
    "agents.ts",
    "/admin/api/agent-revisions/${revisionId}",
    "app/admin/api/agent-revisions/[revisionId]/route.ts",
    "GET",
  ],
  [
    "agents.ts",
    "/admin/api/agents/${agentId}/revisions",
    "app/admin/api/agents/[agentId]/revisions/route.ts",
    "POST",
  ],
  [
    "agents.ts",
    "/admin/api/agent-revisions/${revisionId}/publish",
    "app/admin/api/agent-revisions/[revisionId]/publish/route.ts",
    "POST",
  ],
  [
    "agents.ts",
    "/admin/api/agent-revisions/${revisionId}/withdraw",
    "app/admin/api/agent-revisions/[revisionId]/withdraw/route.ts",
    "POST",
  ],
  [
    "artifacts.ts",
    "/admin/api/artifact-attestations",
    "app/admin/api/artifact-attestations/route.ts",
    "GET",
  ],
  [
    "artifacts.ts",
    "/admin/api/artifact-attestations/${attestationId}",
    "app/admin/api/artifact-attestations/[attestationId]/route.ts",
    "GET",
  ],
  [
    "artifacts.ts",
    "/admin/api/artifact-attestations/verify",
    "app/admin/api/artifact-attestations/verify/route.ts",
    "POST",
  ],
  [
    "artifacts.ts",
    "/admin/api/artifact-attestations/${attestationId}/revoke",
    "app/admin/api/artifact-attestations/[attestationId]/revoke/route.ts",
    "POST",
  ],
  [
    "executions.ts",
    "/admin/api/invocations/${invocationId}/execution-binding",
    "app/admin/api/invocations/[invocationId]/execution-binding/route.ts",
    "GET",
  ],
  [
    "provisioning.ts",
    "/admin/api/hosted-provisioning",
    "app/admin/api/hosted-provisioning/route.ts",
    "POST",
  ],
  [
    "provisioning.ts",
    "/admin/api/hosted-provisioning/${requestId}",
    "app/admin/api/hosted-provisioning/[requestId]/route.ts",
    "GET",
  ],
  ["publications.ts", "/admin/api/publications?", "app/admin/api/publications/route.ts", "GET"],
  [
    "publications.ts",
    "/admin/api/publications/${recordId}",
    "app/admin/api/publications/[recordId]/route.ts",
    "GET",
  ],
  ["publications.ts", "/admin/api/withdrawals?", "app/admin/api/withdrawals/route.ts", "GET"],
  [
    "publications.ts",
    "/admin/api/withdrawals/${recordId}",
    "app/admin/api/withdrawals/[recordId]/route.ts",
    "GET",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-route-sets/${routeSetId}",
    "app/admin/api/deployment-route-sets/[routeSetId]/route.ts",
    "GET",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-route-sets/${routeSetId}/routes",
    "app/admin/api/deployment-route-sets/[routeSetId]/routes/route.ts",
    "GET",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-routes/${routeId}",
    "app/admin/api/deployment-routes/[routeId]/route.ts",
    "GET",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-route-sets/${routeSetId}/activation",
    "app/admin/api/deployment-route-sets/[routeSetId]/activation/route.ts",
    "PUT",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-routes/${routeId}/disable",
    "app/admin/api/deployment-routes/[routeId]/disable/route.ts",
    "POST",
  ],
  [
    "routes.ts",
    "/admin/api/deployment-route-sets",
    "app/admin/api/deployment-route-sets/route.ts",
    "POST",
  ],
  ["runtimes.ts", "/admin/api/runtimes", "app/admin/api/runtimes/route.ts", "GET"],
  [
    "runtimes.ts",
    "/admin/api/runtimes/${runtimeId}",
    "app/admin/api/runtimes/[runtimeId]/route.ts",
    "GET",
  ],
  [
    "runtimes.ts",
    "/admin/api/runtimes/${runtimeId}/revisions",
    "app/admin/api/runtimes/[runtimeId]/revisions/route.ts",
    "GET",
  ],
  [
    "runtimes.ts",
    "/admin/api/runtime-revisions/${revisionId}",
    "app/admin/api/runtime-revisions/[revisionId]/route.ts",
    "GET",
  ],
  [
    "runtimes.ts",
    "/admin/api/runtime-revisions/${revisionId}/publish",
    "app/admin/api/runtime-revisions/[revisionId]/publish/route.ts",
    "POST",
  ],
  [
    "runtimes.ts",
    "/admin/api/runtime-revisions/${revisionId}/withdraw",
    "app/admin/api/runtime-revisions/[revisionId]/withdraw/route.ts",
    "POST",
  ],
  [
    "runtimes.ts",
    "/admin/api/runtime-revisions/${revisionId}/conformance",
    "app/admin/api/runtime-revisions/[revisionId]/conformance/route.ts",
    "POST",
  ],
  [
    "runtimes.ts",
    "/admin/api/conformance-runs/${runId}",
    "app/admin/api/conformance-runs/[runId]/route.ts",
    "GET",
  ],
] as const;

describe("control plane client route contract", () => {
  it.each(CONTRACTS)("%s 的 %s 存在真实 %s %s handler", (api, path, route, method) => {
    const apiSource = readFileSync(
      join(process.cwd(), "lib/control-plane-client/api", api),
      "utf8",
    );
    const routeSource = readFileSync(join(process.cwd(), route), "utf8");
    expect(apiSource).toContain(path);
    expect(routeSource).toMatch(new RegExp(`export\\s+async\\s+function\\s+${method}\\b`));
  });
});
