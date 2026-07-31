import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.8 Stage D：部署 artifact 测试。
 *
 * 覆盖：artifact 完整性 / secret 脱敏 / 持久化。
 */

const queries = vi.hoisted(() => ({
  appendThreadEvent: vi.fn(),
  createDeployment: vi.fn(),
  getDeployment: vi.fn(),
  getLatestDeployedByThread: vi.fn(),
  listDeploymentsByThread: vi.fn(),
  updateDeployment: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => queries);

import type { Deployment } from "@/lib/db/schema";
import { clearThreadSecrets, registerSecretValues } from "@/lib/runtime/secret-redaction";
import { buildArtifact, persistArtifact, summarizeEnv } from "./artifact";

const TID = "test-artifact-thread";
const TEST_DIR = resolve(".test-deploy-artifact");

beforeEach(() => {
  vi.clearAllMocks();
  queries.appendThreadEvent.mockResolvedValue(undefined);
});

afterEach(async () => {
  clearThreadSecrets(TID);
  await rm(TEST_DIR, { recursive: true, force: true });
});

function mockDeployment(overrides?: Partial<Deployment>): Deployment {
  return {
    id: "dep-1",
    threadId: TID,
    environment: "staging",
    commitSha: "abc123",
    imageTag: "v1.0.0",
    artifactRef: "dep-1",
    cicdJobId: "job-123",
    cicdJobUrl: "https://cicd.example.com/jobs/123",
    status: "deployed",
    previousDeploymentId: null,
    deployedAt: new Date("2026-06-23T10:00:00Z"),
    rolledBackAt: null,
    errorMessage: null,
    createdAt: new Date("2026-06-23T09:55:00Z"),
    ...overrides,
  };
}

describe("buildArtifact", () => {
  it("从 Deployment 构造完整 artifact", () => {
    const dep = mockDeployment();
    const artifact = buildArtifact(dep, { API_KEY: "len=15" });

    expect(artifact.deploymentId).toBe("dep-1");
    expect(artifact.threadId).toBe(TID);
    expect(artifact.environment).toBe("staging");
    expect(artifact.commitSha).toBe("abc123");
    expect(artifact.imageTag).toBe("v1.0.0");
    expect(artifact.cicdJobId).toBe("job-123");
    expect(artifact.cicdJobUrl).toBe("https://cicd.example.com/jobs/123");
    expect(artifact.status).toBe("deployed");
    expect(artifact.envSummary).toEqual({ API_KEY: "len=15" });
  });

  it("回滚部署 artifact 含 previousDeploymentId", () => {
    const dep = mockDeployment({
      status: "rolled_back",
      previousDeploymentId: "dep-0",
      rolledBackAt: new Date("2026-06-23T11:00:00Z"),
    });
    const artifact = buildArtifact(dep);
    expect(artifact.status).toBe("rolled_back");
    expect(artifact.previousDeploymentId).toBe("dep-0");
    expect(artifact.rolledBackAt).toBe("2026-06-23T11:00:00.000Z");
  });
});

describe("summarizeEnv", () => {
  it("只记 key 名 + 值长度，不记值", () => {
    const env = { API_KEY: "sk-secret-12345", TOKEN: "tok-abc" };
    const summary = summarizeEnv(env, TID);
    expect(summary.API_KEY).toBe("len=15");
    expect(summary.TOKEN).toBe("len=7");
    // 不含原始值
    expect(JSON.stringify(summary)).not.toContain("sk-secret-12345");
    expect(JSON.stringify(summary)).not.toContain("tok-abc");
  });

  it("secret 值被脱敏后计算长度", () => {
    registerSecretValues(TID, ["sk-secret-12345"]);
    const env = { API_KEY: "sk-secret-12345" };
    const summary = summarizeEnv(env, TID);
    // 脱敏后 "sk-secret-12345" → "***"，长度 = 3
    expect(summary.API_KEY).toBe("len=3");
  });
});

describe("persistArtifact", () => {
  it("持久化 artifact 到文件", async () => {
    const dep = mockDeployment();
    const artifact = buildArtifact(dep);
    const filePath = await persistArtifact(artifact, TEST_DIR);

    expect(filePath).toContain(".snow/runtime");
    expect(filePath).toContain(TID);
    expect(filePath).toContain("dep-1.json");

    // 文件存在且可读
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.deploymentId).toBe("dep-1");
    expect(parsed.environment).toBe("staging");
  });
});
