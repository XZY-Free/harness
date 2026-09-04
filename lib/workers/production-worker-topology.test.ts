import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type WorkerHealthState,
  checkWorkerDatabase,
  isWorkerLive,
  isWorkerReady,
} from "@/lib/workers/production-worker-process";
import {
  CANONICAL_PRODUCTION_ROLES,
  DURABLE_WORKER_ROLES,
  createProductionWorkerRole,
  parseDurableWorkerRole,
} from "@/lib/workers/production-worker-role";
import {
  type SourceDocument,
  checkWorkerProductionTopologyGate,
} from "@/scripts/architecture-gate-rules";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it, vi } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("canonical production worker topology", () => {
  it("每个 required role 都有独立 service、replicas 与统一 worker image", () => {
    const topology = loadYaml(read("deploy/production/compose.yaml")) as {
      services: Record<
        string,
        { deploy?: { replicas?: number }; environment?: Record<string, string> }
      >;
    };
    expect(Object.keys(topology.services).sort()).toEqual([...CANONICAL_PRODUCTION_ROLES].sort());
    for (const role of CANONICAL_PRODUCTION_ROLES) {
      expect(topology.services[role]?.deploy?.replicas).toBeGreaterThan(0);
    }
    for (const role of DURABLE_WORKER_ROLES) {
      expect(topology.services[role]?.environment?.WORKER_ROLE).toBe(role);
    }
    expect(read("docker/worker/Dockerfile")).toContain("scripts/workers/worker-entrypoint.ts");
    expect(read("package.json")).toContain('"worker:start"');
  });

  it("invalid role fail fast", () => {
    expect(() => parseDurableWorkerRole(undefined)).toThrow(/WORKER_ROLE/);
    expect(() => parseDurableWorkerRole("web-api")).toThrow(/WORKER_ROLE/);
    expect(() => parseDurableWorkerRole("unknown-worker")).toThrow(/WORKER_ROLE/);
  });

  it("统一 entrypoint 能为每个 durable role 构造且只构造一个 poller", () => {
    for (const role of DURABLE_WORKER_ROLES) {
      const worker = createProductionWorkerRole(parseDurableWorkerRole(role));
      expect(worker.role).toBe(role);
      expect(worker.pollOnce).toBeTypeOf("function");
      worker.stop();
    }
  });

  it("readiness 要求最近 poll 成功且 DB 可读写；liveness 能识别 loop crash", () => {
    const now = new Date("2026-09-05T00:00:10.000Z");
    const state: WorkerHealthState = {
      role: "tool-execution-worker",
      startedAt: new Date("2026-09-05T00:00:00.000Z"),
      lastLoopPulseAt: now,
      lastSuccessfulPollAt: now,
      loopCrashed: false,
    };
    expect(isWorkerReady(state, true, now)).toBe(true);
    expect(isWorkerReady(state, false, now)).toBe(false);
    expect(isWorkerLive({ ...state, loopCrashed: true }, now)).toBe(false);
  });

  it("startup check 在 DB 配置不可用时 fail fast", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(checkWorkerDatabase("runtime-dispatch-retry-worker")).rejects.toThrow(
      "DATABASE_URL 缺失",
    );
    vi.unstubAllEnvs();
  });

  it("architecture gate 覆盖 package/image/topology 与 retry 默认接线", () => {
    const paths = [
      "package.json",
      "Dockerfile",
      "docker/worker/Dockerfile",
      "deploy/production/compose.yaml",
      "scripts/workers/worker-entrypoint.ts",
      "lib/runtime/retry/runtime-dispatch-retry-worker.ts",
    ];
    const documents: SourceDocument[] = paths.map((path) => ({ path, source: read(path) }));
    expect(checkWorkerProductionTopologyGate(documents)).toEqual({ passed: true, failures: [] });
  });
});
