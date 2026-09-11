/**
 * 品牌变更 → Desktop Control Plane 的接线模块。
 *
 * BrandStore 只发布进程内快照事件；本模块把它翻译为控制面事件
 * control_brand_invalidated 并发布到总线，由 bridge-server 扇出到 Desktop 会话。
 * 保持 BrandStore 对传输层零知悉（存储与通道解耦）。
 *
 * 幂等：重复调用只装配一次（instrumentation 与测试均可安全调用）。
 */
import { getBrandStore } from "@/lib/branding/brand-store";
import { publishControlEvent } from "@/lib/desktop-bridge/control-event-bus";

let started = false;

export function startBrandControlBridge(): void {
  if (started) return;
  started = true;
  getBrandStore().subscribe((snapshot) => {
    publishControlEvent({
      type: "control_brand_invalidated",
      revision: snapshot.contract.revision,
      etag: snapshot.etag,
      occurredAt: Date.now(),
    });
  });
}

/** 测试辅助：重置幂等标记。 */
export function resetBrandControlBridgeForTest(): void {
  started = false;
}
