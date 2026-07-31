// Dev auth 默认用户。真实用户由 lib/auth 的 dev/trusted-header 模式解析。
export const DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_USER_EMAIL = "owner@snow-harness.local";
export const DEFAULT_USER_NAME = "SnowHarness 管理员";

/** Deprecated: do not use for user-facing routes after Phase 4-3. 首页改为按当前用户取最近 thread。 */
export const DEFAULT_THREAD_ID = "00000000-0000-4000-8000-0000000000c1";
