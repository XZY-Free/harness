/**
 * identity-client：nexharness 消费 auth-center 的客户端 SDK（唯一身份出入口）。
 *
 * 模块划分：
 * - session：token 提取 / introspect（缓存 30~60s）/ 票据兑换
 * - snapshot：权限快照（缓存 5~15min）+ evaluate：快照本地匹配
 * - authorize：实时授权（变更/敏感操作；fail-closed）
 * - directory：用户目录读（分钟级缓存）
 *
 * 约定：所有失败以 throw 传播（AuthCenterUnavailableError / null=会话无效），
 * 由执法点（lib/identity/authorization.ts 等薄壳）决定 fail-closed 语义。
 */
export { identityClientConfig } from "./config";
export {
  AuthCenterUnavailableError,
  type AuthCenterResponse,
  bearerHeaders,
  requestAuthCenter,
} from "./http";
export {
  SESSION_COOKIE_NAME,
  type RemotePrincipal,
  type TicketExchangeResult,
  clearIdentityClientCaches,
  exchangeTicket,
  getActiveTokenForUser,
  introspectSession,
  readSessionToken,
} from "./session";
export {
  type PermissionSnapshot,
  type SnapshotAgent,
  type SnapshotEnterprise,
  type SnapshotGrant,
  type SnapshotPolicy,
  clearSnapshotCache,
  getSnapshot,
  peekSnapshot,
  seedSnapshotCache,
} from "./snapshot";
export {
  type SnapshotCheckRequest,
  type SnapshotCoverage,
  type SnapshotDecision,
  coverageFromSnapshot,
  evaluateSnapshot,
} from "./evaluate";
export {
  type AuthorizeBatchResult,
  type AuthorizeDecisionItem,
  type AuthorizeRequestItem,
  authorizeForUser,
} from "./authorize";
export {
  type DirectoryUser,
  clearDirectoryCache,
  lookupUsers,
} from "./directory";
