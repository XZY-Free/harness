import { existsSync } from "node:fs";
/**
 * Desktop E2E 共享启动器。
 *
 * 被 `desktop-execution-chain.spec.ts`（§20.5）与 `cross-client.spec.ts`（§20.6）共用，
 * 避免两处复制启动细节（§22 禁止「为了迁移先复制一套代码」）。
 *
 * 关键点：每次启动使用**独立的 user-data-dir**。原因有三：
 * 1. Electron 的 `requestSingleInstanceLock()` 按 userData 目录划分。共用默认目录时，
 *    上一轮残留的主进程会让新实例静默 `app.quit()`，表现为
 *    "Target page, context or browser has been closed"，极难定位。
 * 2. 隔离 Desktop SQLite 库与 safeStorage 设备身份，用例之间互不污染。
 * 3. 不触碰开发者本机真实的 SnowHarness Desktop 数据。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { E2E_ORIGIN } from "../../playwright.config";

const PACKAGE_APP_DIR = join(process.cwd(), "desktop/package-app");
const MAIN_BUNDLE = join(PACKAGE_APP_DIR, "bundle/main/index.js");

export interface LaunchedDesktop {
  app: ElectronApplication;
  /** 关闭应用并清理临时 user-data-dir。 */
  dispose(): Promise<void>;
}

/**
 * 真启动打包后的 Electron 应用，服务端指向 e2e 测试服务器。
 *
 * 未构建时**明确抛错**而非跳过——§22 禁止把 skip 当作完成。
 */
export async function launchDesktopApp(): Promise<LaunchedDesktop> {
  if (!existsSync(MAIN_BUNDLE)) {
    throw new Error(
      `Desktop 未构建：缺少 ${MAIN_BUNDLE}。请先运行 \`pnpm build:desktop && pnpm rebuild:desktop-native\`。`,
    );
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "snow-e2e-desktop-"));
  const app = await electron.launch({
    args: [
      PACKAGE_APP_DIR,
      `--user-data-dir=${userDataDir}`,
      // CI 容器内 Chromium 沙箱不可用。
      "--no-sandbox",
      // Linux CI 无 gnome-keyring；safeStorage 回退 basic 文本存储，
      // 否则设备身份写入抛 KEYCHAIN_ERROR 导致主进程启动失败。
      "--password-store=basic",
    ],
    env: {
      ...process.env,
      // Desktop 只把服务端当作 API/SSE 提供方，UI 来自本机打包 renderer。
      SNOW_SERVER_ORIGIN: E2E_ORIGIN,
    },
  });

  return {
    app,
    async dispose() {
      // 有界关闭：app.close() 可能无限等待（renderer 未响应 / 主进程未退出）。
      // 给优雅关闭一个上限，超时后只终止本次 ElectronApplication 的进程，
      // 再清理本次 mkdtemp 目录——绝不触碰开发者本机真实 Desktop 数据。
      const CLOSE_TIMEOUT_MS = 10_000;
      const closed = await Promise.race([
        app.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS)),
      ]);
      if (!closed) {
        const proc = app.process();
        if (proc && !proc.killed) {
          console.warn("[e2e][desktop] app.close 超时，终止 ElectronApplication 进程");
          proc.kill("SIGKILL");
        }
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
