"use strict";

/**
 * Playwright 的 Electron loader 为通用浏览器测试强制使用 basic/mock keychain。
 * SnowHarness Desktop E2E 必须验证真实 OS keyring，因此在应用入口加载前撤销该默认值。
 */
function applyRealKeyringCommandLine(commandLine, platform = process.platform) {
  commandLine.removeSwitch("use-mock-keychain");
  commandLine.removeSwitch("password-store");

  if (platform === "linux") {
    commandLine.appendSwitch("password-store", "gnome-libsecret");
  }
}

const electron = require("electron");
if (typeof electron === "object" && electron?.app?.commandLine) {
  applyRealKeyringCommandLine(electron.app.commandLine);
}

module.exports = { applyRealKeyringCommandLine };
