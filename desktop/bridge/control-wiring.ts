/**
 * Desktop Control Plane 客户端装配：把控制事件接到品牌应用器与升级检查。
 *
 * - control_brand_invalidated → BrandApplier.refresh()（ETag 拉取 + 重设）。
 * - control_update_hint → UpdateManager.checkForUpdates()，带冷却防抖（默认 5 分钟），
 *   周期检查保留兜底；hint 只是加速信号，升级权威仍在 updater 的 feed 与验签。
 *
 * 在 desktop/main 启动期调用一次；handler 注册返回的取消句柄由进程生命周期持有。
 */
import { BrandApplier } from "../branding/applier";
import { registerBrandInvalidatedHandler, registerUpdateHintHandler } from "./control-handlers";

export interface ControlPlaneWiringDeps {
  baseUrl: string;
  setAppName: (name: string) => void;
  setAllWindowTitles: (name: string) => void;
  setTrayToolTip?: (name: string) => void;
  checkForUpdates: () => Promise<unknown>;
  hintCooldownMs?: number;
  now?: () => number;
  fetchBrand?: (url: string, init?: RequestInit) => Promise<Response>;
}

export function attachDesktopControlPlane(deps: ControlPlaneWiringDeps): () => void {
  const applier = new BrandApplier({
    baseUrl: deps.baseUrl,
    fetchBrand: deps.fetchBrand,
    setAppName: deps.setAppName,
    setAllWindowTitles: deps.setAllWindowTitles,
    setTrayToolTip: deps.setTrayToolTip,
  });
  const cooldownMs = deps.hintCooldownMs ?? 5 * 60_000;
  const now = deps.now ?? (() => Date.now());
  let lastHintCheckAt = 0;

  const offBrand = registerBrandInvalidatedHandler(() => applier.refresh());
  const offHint = registerUpdateHintHandler(async () => {
    const at = now();
    if (at - lastHintCheckAt < cooldownMs) return;
    lastHintCheckAt = at;
    await deps.checkForUpdates();
  });
  return () => {
    offBrand();
    offHint();
  };
}
