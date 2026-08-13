/**
 * RebuildRouteEligibilityProjections — 全量重建投影 Application Service。
 *
 * : 读取全部当前激活 Route → 分批重建 → 标记 seen route IDs
 * → 删除或标记未 seen 的旧 Projection → 输出统计。
 *
 * 全量重建不依赖历史事件回放。
 * 核心实现是 Application Service，不是脚本逻辑。
 */

import type {
  BuildRouteEligibilityInput,
  BuildRouteEligibilityResult,
} from "./build-route-eligibility";
import type { RouteEligibilitySourceReader } from "./route-eligibility-source-reader";
import type { RouteEligibilityStore } from "./route-eligibility-store";

export interface RebuildRouteEligibilityProjectionsCommand {
  /** 可选：只重建指定 RouteSet 下的投影。 */
  routeSetId?: string;
  /** 分批大小，默认 50。 */
  batchSize?: number;
}

export interface RebuildRouteEligibilityProjectionsResult {
  total: number;
  eligible: number;
  ineligible: number;
  /** 删除的旧投影数量（权威 Route 已不存在）。 */
  deleted: number;
  failed: number;
}

export interface RebuildProjectionDeps {
  store: RouteEligibilityStore;
  sourceReader: RouteEligibilitySourceReader;
  buildRouteEligibility: (
    input: BuildRouteEligibilityInput,
  ) => Promise<BuildRouteEligibilityResult>;
}

/**
 * 创建全量重建命令。
 *
 * : 作为 Application Service，不是脚本。
 */
export function createRebuildRouteEligibilityProjections(deps: RebuildProjectionDeps) {
  return async function rebuildRouteEligibilityProjections(
    command: RebuildRouteEligibilityProjectionsCommand = {},
  ): Promise<RebuildRouteEligibilityProjectionsResult> {
    const batchSize = command.batchSize ?? 50;

    // 1. 读取全部当前激活 Route（权威事实）
    const activatedRoutes = command.routeSetId
      ? await deps.sourceReader.listRouteIdsByRouteSet(command.routeSetId)
      : await deps.sourceReader.listAllCurrentlyActivatedRouteIds();

    // 2. 读取当前所有投影 routeId（用于后续比对）
    const existingProjectionRouteIds = command.routeSetId
      ? await deps.store.listProjectionRouteIdsByRouteSet(command.routeSetId)
      : await deps.store.listAllProjectionRouteIds();

    const seenRouteIds = new Set<string>();
    let eligible = 0;
    let ineligible = 0;
    let failed = 0;

    // 3. 分批重建
    for (let offset = 0; offset < activatedRoutes.length; offset += batchSize) {
      const batch = activatedRoutes.slice(offset, offset + batchSize);
      // 并行处理批次内每个 Route
      const results = await Promise.allSettled(
        batch.map((route) =>
          deps.buildRouteEligibility({
            tenantId: route.tenantId,
            routeId: route.routeId,
          }),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const routeId = batch[i]?.routeId;
        if (!routeId) continue;
        seenRouteIds.add(routeId);

        const result = results[i];
        if (!result) continue;
        if (result.status === "fulfilled") {
          if (result.value.eligibilityState === "eligible") {
            eligible++;
          } else {
            ineligible++;
          }
        } else {
          failed++;
        }
      }
    }

    // 4. 删除未 seen 的旧投影（权威 Route 已不存在或 disabled）
    let deleted = 0;
    for (const { routeId } of existingProjectionRouteIds) {
      if (!seenRouteIds.has(routeId)) {
        await deps.store.deleteProjection(routeId);
        deleted++;
      }
    }

    return {
      total: activatedRoutes.length,
      eligible,
      ineligible,
      deleted,
      failed,
    };
  };
}
