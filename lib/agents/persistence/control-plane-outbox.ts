/**
 * @deprecated §3.4: 控制面事件已迁移至 lib/control-plane/events/。
 * 此文件仅作为兼容 re-export 保留，将在下个 major 版本删除。
 */
export {
  controlPlaneOutboxEvent,
  type ControlPlaneOutboxEvent,
  type NewControlPlaneOutboxEvent,
} from "@/lib/control-plane/events/control-plane-outbox";
