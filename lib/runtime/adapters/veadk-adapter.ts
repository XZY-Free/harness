/**
 * VeADK Runtime Adapter（S05-C05 参考实现）。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/runtime-control-plane.md S05-C05
 *
 * 职责：
 * - VeADK Adapter 是 HostedAdapter 的薄包装，证明 VeADK app/user/session/Event 映射可行性。
 * - 使用 `veadk-${appId}` 作为 refPrefix，生成 VeADK 风格的 runtime_session_ref/runtime_execution_ref。
 * - 能力声明与 HostedAdapter 相同（VeADK 支持相同能力集）。
 * - 事件回传路径相同（通过 EventBatchSink）。
 *
 * 关键约束：
 * - 本阶段 VeADK Adapter 只验证映射可行性，不接入真实 VeADK SDK。
 * - runtime_session_ref 格式：`veadk-${appId}-${sessionId}`（sessionId = threadSuffix-randomUUID）。
 * - runtime_execution_ref 格式：`veadk-${appId}-exec-${randomUUID}`。
 * - 能力声明相同（VeADK 支持相同能力集）。
 */
import {
 type CreateHostedAdapterParams,
 type RuntimeAdapter,
 createHostedAdapter,
} from "@/lib/runtime/adapters/hosted-adapter";

// ─── VeADK Adapter 工厂 ──────────────────────────────────

/**
 * createVeadkAdapter 工厂参数。
 *
 * 继承 CreateHostedAdapterParams（platformEndpoint / platformAuthToken / eventBatchSink / modelFn），
 * 额外要求 appId（VeADK 应用标识）。
 */
export interface CreateVeadkAdapterParams extends CreateHostedAdapterParams {
 /** VeADK 应用标识（如 "crm-assistant"），用于生成 `veadk-${appId}-` 前缀的 ref。 */
 appId: string;
}

/**
 * 创建 VeADK Runtime Adapter（HostedAdapter 的薄包装）。
 *
 * - 使用 `veadk-${appId}` 作为 refPrefix。
 * - 能力声明、事件回传、命令处理逻辑与 HostedAdapter 完全相同。
 * - 返回的 RuntimeAdapter 接口与 HostedAdapter 一致，路由层无需区分。
 *
 * @param params 工厂参数（必须包含 appId）
 * @returns RuntimeAdapter 实例（VeADK 变体）
 */
export function createVeadkAdapter(params: CreateVeadkAdapterParams): RuntimeAdapter {
 const { appId, ...hostedParams } = params;
 return createHostedAdapter({
 ...hostedParams,
 refPrefix: `veadk-${appId}`,
 });
}
