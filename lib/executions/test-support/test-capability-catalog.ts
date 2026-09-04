import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";

/** 旧主题测试创建 ExecutionBinding 时使用的最小、有效、无业务能力目录。 */
export function testCapabilityCatalogBindingFields(invocationId: string) {
  const catalog = buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    tools: [],
    knowledgeSources: [],
    sourceRefs: ["test-fixture:empty-capability-catalog"],
    now: new Date("2026-09-04T00:00:00.000Z"),
  });
  return {
    capabilityCatalogJson: catalog.snapshot,
    capabilityCatalogDigest: catalog.digest,
    capabilityCatalogVersion: catalog.version,
    capabilityCatalogSourceRefs: catalog.sourceRefs,
    capabilityCatalogCreatedAt: catalog.createdAt,
  };
}
