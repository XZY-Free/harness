-- §2.6: 幂等重放 — 改为 routeSetId+idempotencyKey 级幂等
-- 参见：SnowHarness专题01全局统一与最终收敛方案 §2.6

-- 1. 删除旧的 routeId+idempotencyKey 唯一约束
DROP INDEX `RouteActivation_route_idempotency_uq` ON `RouteActivation`;

--> statement-breakpoint

-- 2. 创建新的 routeSetId+idempotencyKey 唯一约束
CREATE UNIQUE INDEX `RouteActivation_routeSet_idempotency_uq` ON `RouteActivation` (`routeSetId`, `idempotencyKey`);
