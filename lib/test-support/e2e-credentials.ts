/**
 * 仅供 Playwright 的临时 MySQL 容器使用。测试服务器启动时会显式创建该账号，
 * 浏览器与打包 Desktop 随后都必须经过正式登录接口，不启用产品认证旁路。
 */
export const E2E_ADMIN_EMAIL = "e2e-admin@snow-harness.test";
export const E2E_ADMIN_NAME = "SnowHarness 测试管理员";
export const E2E_ADMIN_PASSWORD = "snow-harness-e2e-password-2026";
export const E2E_AUTH_STATE = "test-results/.auth/user.json";
