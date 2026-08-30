import { type RuntimeType, runtimeConfig } from "@/lib/config";

/**
 * 解析平台配置的本地预览 Runtime 类型。
 *
 * Thread 与 Skill 不携带 Runtime 选择权；Harness 调度位置由正式 Runtime Route 冻结。
 * 本地预览只读取平台 runtimeConfig；非法配置由配置层直接拒绝。
 */
export function resolveConfiguredRuntimeType(): RuntimeType {
  return runtimeConfig.defaultType;
}
