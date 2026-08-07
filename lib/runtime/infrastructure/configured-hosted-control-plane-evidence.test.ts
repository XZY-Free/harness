import { createConfiguredHostedControlPlaneEvidenceProvider } from "@/lib/runtime/infrastructure/configured-hosted-control-plane-evidence";
import { describe, expect, it, vi } from "vitest";

const CONFIG = {
  endpoint: "https://evidence.example.test",
  token: "test-service-token",
  builderKeys: { "builder:hosted": "public-key" },
  timeoutMs: 1_000,
};

describe("ConfiguredHostedControlPlaneEvidenceProvider", () => {
  it("从可信服务解析制品元数据，并按受管引用独立读取证明文档", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/hosted-artifacts:resolve")) {
        return jsonResponse({
          artifact_digest: `sha256:${"a".repeat(64)}`,
          artifact_ref: `oci://registry/agent@sha256:${"a".repeat(64)}`,
          dsse_envelope_ref: "managed://hosted/agent/dsse-envelope",
          sbom_ref: "managed://hosted/agent/sbom",
          provenance_ref: "managed://hosted/agent/provenance",
          builder_identity: "builder:hosted",
        });
      }
      const body = JSON.parse(String(init?.body)) as { document_type: string };
      if (body.document_type === "dsse_envelope") {
        return jsonResponse({
          document: {
            payloadType: "application/vnd.in-toto+json",
            payload: "e30=",
            signatures: [{ keyid: "builder:hosted", sig: "signature" }],
          },
        });
      }
      if (body.document_type === "sbom") {
        return jsonResponse({ document: { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [] } });
      }
      return jsonResponse({
        document: {
          sourceRevision: "git:release",
          buildPipeline: "ci/hosted",
          dependencyLockFile: "pnpm-lock.yaml:sha256:digest",
          buildTime: "2026-08-03T00:00:00.000Z",
        },
      });
    });
    const provider = createConfiguredHostedControlPlaneEvidenceProvider({
      config: CONFIG,
      fetchImpl,
    });

    const evidence = await provider.loadArtifactEvidence({
      tenantId: "tenant-1",
      artifactType: "agent_revision",
    });

    await expect(
      evidence.managedStore.readDsseEnvelope(evidence.dsseEnvelopeRef),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(evidence.managedStore.readSbom(evidence.sbomRef)).resolves.toEqual({
      bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [],
    });
    await expect(
      evidence.managedStore.readProvenance(evidence.provenanceRef),
    ).resolves.toMatchObject({ sourceRevision: "git:release" });
    expect(evidence.builderKeys).toEqual(CONFIG.builderKeys);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("把幂等键和精确 RuntimeRevision 绑定发送给独立 Runner", async () => {
    const dsseEnvelope = JSON.stringify({ payloadType: "application/vnd.in-toto+json" });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("hosted-run:revision-1");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        runtime_revision_id: "revision-1",
        runtime_artifact_digest: `sha256:${"b".repeat(64)}`,
      });
      return jsonResponse({ dsse_envelope: dsseEnvelope });
    });
    const provider = createConfiguredHostedControlPlaneEvidenceProvider({
      config: CONFIG,
      fetchImpl,
    });

    await expect(
      provider.runRuntimeConformance({
        tenantId: "tenant-1",
        runtimeRevisionId: "revision-1",
        idempotencyKey: "hosted-run:revision-1",
        runtimeArtifactDigest: `sha256:${"b".repeat(64)}`,
        runtimeConfigDigest: `sha256:${"c".repeat(64)}`,
        protocolContractRevision: "agent-runtime-protocol@1",
      }),
    ).resolves.toEqual({ dsseEnvelope });
  });

  it("缺少服务地址、Token 或 Builder 信任锚时失败关闭", async () => {
    const provider = createConfiguredHostedControlPlaneEvidenceProvider({
      config: { endpoint: "", token: "", builderKeys: {}, timeoutMs: 1_000 },
      fetchImpl: vi.fn(),
    });

    await expect(
      provider.loadArtifactEvidence({ tenantId: "tenant-1", artifactType: "runtime_revision" }),
    ).rejects.toThrow("Hosted 控制面证据源未配置");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
