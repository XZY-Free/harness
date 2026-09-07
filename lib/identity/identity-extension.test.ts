import type { UserAuthenticationProvider } from "@/lib/identity/authentication-provider";
import {
  type IdentityExtension,
  IdentityExtensionBootstrap,
  type IdentityExtensionConfigurationError,
} from "@/lib/identity/identity-extension";
import { describe, expect, it } from "vitest";

function provider(name: string): UserAuthenticationProvider {
  return {
    name,
    async authenticate() {
      return { status: "unauthenticated" };
    },
  };
}

describe("IdentityExtensionBootstrap", () => {
  it("无私有扩展时返回开源认证提供器且只初始化一次", async () => {
    let calls = 0;
    const extension: IdentityExtension = {
      authenticationProvider: provider("open-source"),
    };
    const bootstrap = new IdentityExtensionBootstrap(async () => {
      calls += 1;
      return extension;
    });

    const first = await bootstrap.initialize();
    const second = await bootstrap.initialize();

    expect(first).toBe(extension);
    expect(second).toBe(extension);
    expect(calls).toBe(1);
  });

  it("扩展初始化失败时稳定失败，不回退到默认提供器", async () => {
    const bootstrap = new IdentityExtensionBootstrap(async () => {
      throw new Error("private module unavailable");
    });

    await expect(bootstrap.initialize()).rejects.toThrow("private module unavailable");
    await expect(bootstrap.initialize()).rejects.toThrow("private module unavailable");
  });

  it("同一装配点不能冻结后替换认证提供器", async () => {
    const bootstrap = new IdentityExtensionBootstrap(async () => ({
      authenticationProvider: provider("first"),
    }));
    await bootstrap.initialize();

    expect(() =>
      bootstrap.assertSameProvider({
        authenticationProvider: provider("second"),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityExtensionConfigurationError>>({
        code: "identity_extension_provider_conflict",
      }),
    );
  });
});
