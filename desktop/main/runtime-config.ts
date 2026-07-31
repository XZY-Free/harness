/**
 * 桌面端运行配置。
 *
 * 打包时随应用资源提供服务地址；启动环境变量仍可覆盖它，便于测试与私有部署。
 */
export interface DesktopRuntimeConfig {
  serverOrigin?: string;
  allowInsecureRemoteOrigin?: boolean;
}

export interface LoadRuntimeEnvironmentOptions {
  env: NodeJS.ProcessEnv;
  configText?: string;
}

function parseConfig(configText: string | undefined): DesktopRuntimeConfig {
  if (!configText) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    throw new Error("桌面端运行配置不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("桌面端运行配置必须是对象");
  }

  const config = parsed as Record<string, unknown>;
  if (config.serverOrigin !== undefined && typeof config.serverOrigin !== "string") {
    throw new Error("桌面端运行配置的 serverOrigin 必须是字符串");
  }
  if (
    config.allowInsecureRemoteOrigin !== undefined &&
    typeof config.allowInsecureRemoteOrigin !== "boolean"
  ) {
    throw new Error("桌面端运行配置的 allowInsecureRemoteOrigin 必须是布尔值");
  }

  return {
    serverOrigin: config.serverOrigin as string | undefined,
    allowInsecureRemoteOrigin: config.allowInsecureRemoteOrigin as boolean | undefined,
  };
}

function validateServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("serverOrigin 必须是 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("serverOrigin 必须是 http 或 https 地址");
  }
  return value;
}

/** 将打包配置合并为主进程可直接使用的环境变量。 */
export function loadRuntimeEnvironment({
  env,
  configText,
}: LoadRuntimeEnvironmentOptions): NodeJS.ProcessEnv {
  const config = parseConfig(configText);
  const serverOrigin = env.SNOW_SERVER_ORIGIN?.trim() || config.serverOrigin?.trim();
  const allowInsecureRemoteOrigin = env.SNOW_ALLOW_INSECURE_REMOTE_ORIGIN;

  return {
    ...env,
    ...(serverOrigin ? { SNOW_SERVER_ORIGIN: validateServerOrigin(serverOrigin) } : {}),
    ...(allowInsecureRemoteOrigin !== undefined
      ? { SNOW_ALLOW_INSECURE_REMOTE_ORIGIN: allowInsecureRemoteOrigin }
      : config.allowInsecureRemoteOrigin
        ? { SNOW_ALLOW_INSECURE_REMOTE_ORIGIN: "1" }
        : {}),
  };
}
