import { existsSync, readFileSync } from "node:fs";
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
const REAL_KEYRING_LOADER = join(process.cwd(), "e2e/support/electron-real-keyring-loader.cjs");

export interface LaunchedDesktop {
  app: ElectronApplication;
  /** 关闭应用并清理临时 user-data-dir。 */
  dispose(): Promise<void>;
}

/**
 * Playwright 自带 loader 会追加 basic/mock keychain；先 preload 修正器撤销该默认值，
 * 再进入应用。Linux 修正器选择 gnome-libsecret，macOS 则回到系统 Keychain。
 */
export function buildDesktopLaunchArgs(userDataDir: string): string[] {
  return [
    "-r",
    REAL_KEYRING_LOADER,
    // CI 容器内 Chromium 沙箱不可用。
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    PACKAGE_APP_DIR,
  ];
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

  // 读取主进程通过 SNOW_E2E_LOG_FILE 写入的阶段化启动日志。
  // 用户指令：不能在 electron.launch() 返回后立即读取（此时 main() 可能尚未
  // 推进到关键阶段/错误尚未写完），而应在「窗口创建」或「进程退出」之后读取。
  // 因此本函数只在本文件的两个时机被触发：app.on("window")（窗口创建）与
  // app.on("close")（进程退出），并由 firstWindow 调用方做兜底。
  const readMainLog = (): void => {
    try {
      const mainLog = readFileSync(join(userDataDir, "e2e-main.log"), "utf8").trim();
      if (mainLog) console.log(`[e2e][desktop] 主进程日志:\n${mainLog}`);
    } catch {
      // 无日志文件则跳过（主进程未启动或未写入）。
    }
  };
  const app = await electron.launch({
    args: buildDesktopLaunchArgs(userDataDir),
    env: {
      ...process.env,
      // Desktop 只把服务端当作 API/SSE 提供方，UI 来自本机打包 renderer。
      SNOW_SERVER_ORIGIN: E2E_ORIGIN,
      // E2E 每次启动独立 user-data-dir 的实例，放行主进程单实例锁，
      // 否则多次 launch 共享锁时后续实例静默 app.quit()，firstWindow 报
      // "Target page, context or browser has been closed"。
      SNOW_E2E_DISABLE_SINGLE_INSTANCE: "1",
      // 主进程把关键启动日志（单实例锁结果 / main() 失败）写入该文件，
      // launch 返回后读取，定位 CI 下窗口未创建的真实原因。
      SNOW_E2E_LOG_FILE: join(userDataDir, "e2e-main.log"),
    },
  });

  // ── E2E 诊断：转发主进程 stdout/stderr，监听窗口关闭，便于 CI 定位
  // firstWindow "Target page, context or browser has been closed" 的真实原因
  // （Electron 主进程 stderr / 渲染进程崩溃不转发时，CI 日志只有关闭，无线索）。
  const mainProc = app.process();
  mainProc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[e2e][desktop][main:out] ${d}`));
  mainProc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[e2e][desktop][main:err] ${d}`));
  // launch() 返回时的即时快照：窗口是否已创建 / 主进程是否已退出。firstWindow
  // 报 "browser has been closed" 时，windows()=0 或 exitCode 非 null 即为主进程退出。
  console.log(
    `[e2e][desktop] launch 返回：windows=${app.windows().length} processExit=${mainProc.exitCode ?? "running"}`,
  );
  app.on("window", (win) => {
    // 窗口已创建：此时 main() 至少推进到 createMainWindow 之后，读取阶段日志定位
    // 各阶段 checkpoint 走到了哪一步（用户指令：窗口创建后再读，而非 launch 后立即读）。
    console.log(`[e2e][desktop] window 事件触发，pages=${app.windows().length}`);
    readMainLog();
    win.on("close", () => {
      console.log("[e2e][desktop] window close 事件触发");
      readMainLog();
    });
  });
  app.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[e2e][desktop][main:console] ${msg.type()}: ${msg.text()}`);
    }
  });
  app.on("close", () => {
    // 进程退出：main() 若中途失败已写入日志，此时读取最完整（用户指令：进程退出后再读）。
    console.log("[e2e][desktop] electron application 关闭");
    readMainLog();
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
