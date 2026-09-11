/**
 * Desktop Control Plane 进程内事件总线。
 *
 * 单一发布/订阅点：品牌失效、升级提示等控制事件统一经此扇出到
 * bridge-server（Desktop 会话）与未来的其他服务端消费者。
 * 只传信号不传状态全文；订阅者自行以 ETag 拉取权威状态。
 *
 * 零外部依赖、可注入监听器集合供测试；进程内同步扇出，监听器异常隔离不互相击穿。
 */
import type {
  ControlBrandInvalidatedMessage,
  ControlUpdateHintMessage,
} from "@/lib/desktop/bridge-messages";
import { logger } from "@/lib/logger";

export type ControlEvent = ControlBrandInvalidatedMessage | ControlUpdateHintMessage;

export type ControlEventListener = (event: ControlEvent) => void;

const listeners = new Set<ControlEventListener>();

export function subscribeControlEvents(listener: ControlEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishControlEvent(event: ControlEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      logger.error("控制事件监听器异常", {
        eventType: event.type,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 测试辅助：清空监听器。 */
export function resetControlEventBus(): void {
  listeners.clear();
}
