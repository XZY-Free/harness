/**
 * Desktop Control Plane 客户端 handler 注册表。
 *
 * bridge-client 只负责把控制事件分发到此注册表；具体应用逻辑（品牌重设、
 * 升级检查）由各自模块注册，保持传输层与业务层解耦。
 * 未注册 handler 的事件被静默丢弃（返回 false），不影响桥连接。
 */
import type {
  ControlBrandInvalidatedMessage,
  ControlUpdateHintMessage,
} from "@/lib/desktop/bridge-messages";

export type BrandInvalidatedHandler = (
  message: ControlBrandInvalidatedMessage,
) => void | Promise<void>;
export type UpdateHintHandler = (message: ControlUpdateHintMessage) => void | Promise<void>;

let brandHandler: BrandInvalidatedHandler | null = null;
let updateHintHandler: UpdateHintHandler | null = null;

export function registerBrandInvalidatedHandler(handler: BrandInvalidatedHandler): () => void {
  brandHandler = handler;
  return () => {
    if (brandHandler === handler) brandHandler = null;
  };
}

export function registerUpdateHintHandler(handler: UpdateHintHandler): () => void {
  updateHintHandler = handler;
  return () => {
    if (updateHintHandler === handler) updateHintHandler = null;
  };
}

export function dispatchControlEvent(
  message: ControlBrandInvalidatedMessage | ControlUpdateHintMessage,
): boolean {
  if (message.type === "control_brand_invalidated") {
    if (!brandHandler) return false;
    void brandHandler(message);
    return true;
  }
  if (!updateHintHandler) return false;
  void updateHintHandler(message);
  return true;
}

/** 测试辅助：清空注册表。 */
export function resetControlHandlersForTest(): void {
  brandHandler = null;
  updateHintHandler = null;
}
