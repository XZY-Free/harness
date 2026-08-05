/**
 * §4.7: Projection 切换门槛单元测试。
 */

import { describe, it, expect } from "vitest";
import {
  canSwitchToProjectionExecution,
  type ProjectionCutoverConditions,
} from "./projection-cutover-readiness";

const ALL_PASS: ProjectionCutoverConditions = {
  noUnknownEventBacklog: true,
  unknownEventBacklogCount: 0,
  allProjectionsRebuilt: true,
  missingProjectionCount: 0,
  noUnexplainedDiffInWindow: true,
  inconsistentCountInWindow: 0,
  observationWindowHours: 24,
  allEvidenceIdsComplete: true,
  incompleteEvidenceCount: 0,
  bindingIntegrationTestsPassed: true,
  withdrawalPropagationTestsPassed: true,
};

describe("§4.7 canSwitchToProjectionExecution", () => {
  it("所有条件满足 → ready=true", () => {
    const result = canSwitchToProjectionExecution(ALL_PASS);
    expect(result.ready).toBe(true);
    expect(result.failingConditions).toHaveLength(0);
  });

  it("未知事件积压 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      noUnknownEventBacklog: false,
      unknownEventBacklogCount: 5,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions).toHaveLength(1);
    expect(result.failingConditions[0]).toContain("unknown_event_backlog");
  });

  it("Projection 未全量重建 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      allProjectionsRebuilt: false,
      missingProjectionCount: 3,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions[0]).toContain("missing_projections");
  });

  it("Shadow 差异 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      noUnexplainedDiffInWindow: false,
      inconsistentCountInWindow: 2,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions[0]).toContain("unexplained_diff");
  });

  it("证据 ID 不完整 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      allEvidenceIdsComplete: false,
      incompleteEvidenceCount: 10,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions[0]).toContain("incomplete_evidence");
  });

  it("Binding 测试未通过 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      bindingIntegrationTestsPassed: false,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions[0]).toContain("binding_integration_tests");
  });

  it("撤回传播测试未通过 → ready=false", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      withdrawalPropagationTestsPassed: false,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions[0]).toContain("withdrawal_propagation");
  });

  it("多个条件不满足 → 列出所有失败条件", () => {
    const result = canSwitchToProjectionExecution({
      ...ALL_PASS,
      noUnknownEventBacklog: false,
      unknownEventBacklogCount: 1,
      bindingIntegrationTestsPassed: false,
    });
    expect(result.ready).toBe(false);
    expect(result.failingConditions).toHaveLength(2);
  });
});
