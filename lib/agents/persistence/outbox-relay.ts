/**
 * @deprecated §3.4: Outbox Relay 已迁移至 lib/control-plane/events/。
 * 此文件仅作为兼容 re-export 保留，将在下个 major 版本删除。
 */
export {
  computeOutboxBackoff,
  classifyOutboxError,
  isOutboxEventClaimable,
} from "@/lib/control-plane/events/outbox-relay";
