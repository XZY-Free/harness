/**
 * Electron safeStorage 冒烟（真实判据，替代被弃用的 set +e 假象）。
 *
 * CI Desktop E2E 的根因历史：主进程在 device identity 阶段因
 * `safeStorage.isEncryptionAvailable()` 为 false 抛 KEYCHAIN_ERROR 崩溃。
 * 此脚本在 xvfb + dbus-run-session + gnome-keyring 下直接启动 Electron，
 * 断言加密可用，用退出码给出真实信号——非 0 即 CI 步骤失败，
 * 不再用 `set +e` + `head -40` 掩盖。
 *
 * 用法：
 *   xvfb-run -a node_modules/electron/dist/electron e2e/support/electron-safe-storage-smoke.js
 *   需要在 DBus secret service（gnome-keyring --components=secrets）下运行。
 */
const { app, safeStorage } = require("electron");

app.whenReady().then(() => {
  let backend;
  try {
    backend = safeStorage.getSelectedStorageBackend
      ? safeStorage.getSelectedStorageBackend()
      : "n/a";
  } catch {
    backend = "error";
  }
  const available = safeStorage.isEncryptionAvailable();
  // eslint-disable-next-line no-console
  console.log(`[safe-storage-smoke] backend=${backend} isEncryptionAvailable=${available}`);
  if (!available) {
    // eslint-disable-next-line no-console
    console.error(
      "[safe-storage-smoke] FAIL: safeStorage 不可用（DBus secret service 未接入 / basic backend），" +
        "Desktop E2E 主进程将因 KEYCHAIN_ERROR 崩溃。",
    );
    app.exit(1);
    return;
  }
  app.exit(0);
});
