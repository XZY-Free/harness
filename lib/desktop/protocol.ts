/**
 * ：Agent Bridge 协议版本管理。
 *
 * Server 和 Desktop 共享的协议版本号。Server 在 RPC 信封中声明 protocolVersion，
 * Desktop 收到后校验是否与本地兼容。不兼容时进入 protocol_mismatch 状态，拒绝处理。
 *
 * 版本演进策略：
 * - 初始版本为 1
 * - 向后不兼容的变更必须递增 PROTOCOL_VERSION
 * - 客户端只接受与自己编译时版本完全一致的协议
 */

/**
 * 当前协议版本。Server 和 Desktop 必须使用相同版本才能通信。
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * 协议版本类型（字面量类型，确保编译时已知版本）。
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * 判断传入版本号是否与本地兼容。
 *
 * 采用严格匹配策略：version 必须严格等于 PROTOCOL_VERSION。
 * 未来如果支持多版本兼容，可在此处放宽判断。
 *
 * @param version 待校验的版本号
 * @returns 兼容返回 true，不兼容返回 false
 */
export function isCompatibleVersion(version: number): boolean {
  if (!Number.isInteger(version)) {
    return false;
  }
  return version === PROTOCOL_VERSION;
}
