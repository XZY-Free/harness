/**
 * 从唯一正式配置构建 Runtime Conformance DSSE Verifier。
 *
 * 唯一职责：runtimeConformanceConfig.runnerSigningIdentities →
 * RunnerSigningIdentityRegistry → createDSSEConformanceVerifier()。
 * 独立 recorder（recordRuntimeConformanceRun）与 Registration 内联 Conformance
 * 必须共用本构造，禁止任何调用方再自建第二套 Registry 解析规则。
 */
import { runtimeConformanceConfig } from "@/lib/config";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";

/** 每次调用时从正式配置构建（不冻结模块加载时刻的环境状态）。 */
export function createConfiguredRuntimeConformanceVerifier() {
  return createDSSEConformanceVerifier({
    runnerIdentityRegistry: new RunnerSigningIdentityRegistry(
      runtimeConformanceConfig.runnerSigningIdentities,
    ),
  });
}
