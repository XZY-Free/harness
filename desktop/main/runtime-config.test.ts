import { describe, expect, it } from "vitest";
import { loadRuntimeEnvironment } from "./runtime-config";

describe("runtime-config", () => {
  it("打包配置提供远程服务地址及 HTTP 显式许可", () => {
    expect(
      loadRuntimeEnvironment({
        env: {},
        configText: JSON.stringify({
          serverOrigin: "http://119.45.222.120/snowharness",
          allowInsecureRemoteOrigin: true,
        }),
      }),
    ).toMatchObject({
      SNOW_SERVER_ORIGIN: "http://119.45.222.120/snowharness",
      SNOW_ALLOW_INSECURE_REMOTE_ORIGIN: "1",
    });
  });

  it("启动环境变量优先于打包配置", () => {
    expect(
      loadRuntimeEnvironment({
        env: {
          SNOW_SERVER_ORIGIN: "https://snow.example.com/api",
          SNOW_ALLOW_INSECURE_REMOTE_ORIGIN: "0",
        },
        configText: JSON.stringify({
          serverOrigin: "http://119.45.222.120/snowharness",
          allowInsecureRemoteOrigin: true,
        }),
      }),
    ).toMatchObject({
      SNOW_SERVER_ORIGIN: "https://snow.example.com/api",
      SNOW_ALLOW_INSECURE_REMOTE_ORIGIN: "0",
    });
  });

  it("拒绝非法的打包服务地址", () => {
    expect(() =>
      loadRuntimeEnvironment({
        env: {},
        configText: '{"serverOrigin":"file:///tmp/server"}',
      }),
    ).toThrow("serverOrigin 必须是 http 或 https 地址");
  });
});
