/**
 * Governance Config 正式领域（关口02 02-6 · 冻结方案 §5 / §54-P2）。
 *
 * 唯一实施基线：docs/V12/01/SnowHarness_专题01_关口02_02-6_Policy_Permission_最终冻结实施方案.md。
 *
 * 关键不变量（§5.4）：
 * - INITIAL_GOVERNANCE_CONFIG 全仓只存在一份，唯一用途 = 创建 Tenant initial
 *   GovernanceConfigRevision。
 * - 运行期 DB 缺失/非 published/digest 错/跨租户/非法 → fail-closed，绝不 return
 *   INITIAL_GOVERNANCE_CONFIG。
 * - 发布前必须 validateGovernanceConfig（非法 config 拒绝发布）。
 */
import type { GovernanceConfig } from "@/lib/persistence/schema/governance-config";

/**
 * GovernanceConfigSet 正式稳定 key（冻结方案 §5.1）。全仓唯一，正式 = "runtime-execution"。
 */
export const GOVERNANCE_CONFIG_SET_KEY = "runtime-execution";

/**
 * 初始 Governance 配置（§5.2 / §5.4）。全仓唯一份，唯一用途 = 创建 Tenant initial
 * GovernanceConfigRevision。禁止作为运行期回退值。
 */
export const INITIAL_GOVERNANCE_CONFIG: GovernanceConfig = {
  protectedPaths: [],
  commandDenyList: [],
  formatOnWrite: false,
  verifyBeforeDelivery: true,
  harnessLoopLimits: {
    maxLoopSteps: 12,
    maxAgentCalls: 3,
    maxToolCalls: 8,
    maxKnowledgeSearches: 6,
    maxConsecutiveSameAction: 2,
  },
};

/** 校验失败异常（§55.1 invalid config）。 */
export class GovernanceConfigValidationError extends Error {
  readonly code = "GOVERNANCE_CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "GovernanceConfigValidationError";
  }
}

/**
 * 校验 GovernanceConfig 形状（§5.2 / §55.1）。
 * - protectedPaths / commandDenyList：字符串数组。
 * - formatOnWrite / verifyBeforeDelivery：布尔。
 *
 * 非法 → 抛 GovernanceConfigValidationError。发布事务内调用，拒绝非法配置发布。
 */
export function validateGovernanceConfig(config: unknown): asserts config is GovernanceConfig {
  if (!config || typeof config !== "object") {
    throw new GovernanceConfigValidationError("GovernanceConfig 必须是对象");
  }
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c.protectedPaths) || !c.protectedPaths.every((p) => typeof p === "string")) {
    throw new GovernanceConfigValidationError("protectedPaths 必须是字符串数组");
  }
  if (!Array.isArray(c.commandDenyList) || !c.commandDenyList.every((p) => typeof p === "string")) {
    throw new GovernanceConfigValidationError("commandDenyList 必须是字符串数组");
  }
  if (typeof c.formatOnWrite !== "boolean") {
    throw new GovernanceConfigValidationError("formatOnWrite 必须是布尔");
  }
  if (typeof c.verifyBeforeDelivery !== "boolean") {
    throw new GovernanceConfigValidationError("verifyBeforeDelivery 必须是布尔");
  }
  if (c.harnessLoopLimits !== undefined) {
    if (!c.harnessLoopLimits || typeof c.harnessLoopLimits !== "object") {
      throw new GovernanceConfigValidationError("harnessLoopLimits 必须是对象");
    }
    for (const key of [
      "maxLoopSteps",
      "maxAgentCalls",
      "maxToolCalls",
      "maxKnowledgeSearches",
      "maxConsecutiveSameAction",
    ]) {
      const value = (c.harnessLoopLimits as Record<string, unknown>)[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        throw new GovernanceConfigValidationError(`harnessLoopLimits.${key} 必须是正整数`);
      }
    }
  }
}
