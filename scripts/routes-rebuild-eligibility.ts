/**
 * routes:rebuild-eligibility — 从权威事实重建 Route Eligibility Projection。
 *
 * 用法: pnpm routes:rebuild-eligibility [--tenant T] [--route-set RS] [--route R] [--dry-run]
 *
 * 必须可重复执行。每次重建幂等。
 */

import { db } from "@/lib/db/client";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { eq } from "drizzle-orm";

const args = parseArgs(process.argv.slice(2));

const buildRouteEligibility = createBuildRouteEligibility({
  store: mysqlRouteEligibilityStore,
});

interface RouteWithTenant {
  id: string;
  routeSetId: string;
  tenantId: string;
}

async function main() {
  console.log("[routes:rebuild-eligibility] 开始重建", args);

  const routes = await listTargetRoutes();
  console.log(`[routes:rebuild-eligibility] 找到 ${routes.length} 条 Route`);

  if (args.dryRun) {
    console.log("[routes:rebuild-eligibility] --dry-run 模式，不执行写入");
    for (const route of routes) {
      console.log(
        `  routeId=${route.id} routeSetId=${route.routeSetId} tenantId=${route.tenantId}`,
      );
    }
    return;
  }

  let eligible = 0;
  let ineligible = 0;
  let errors = 0;

  for (const route of routes) {
    try {
      const result = await buildRouteEligibility({
        tenantId: route.tenantId,
        routeId: route.id,
      });
      if (result.eligibilityState === "eligible") {
        eligible++;
      } else {
        ineligible++;
      }
    } catch (error) {
      errors++;
      console.error(`[routes:rebuild-eligibility] Route ${route.id} 重建失败:`, error);
    }
  }

  console.log(
    `[routes:rebuild-eligibility] 完成: eligible=${eligible} ineligible=${ineligible} errors=${errors}`,
  );
}

async function listTargetRoutes(): Promise<RouteWithTenant[]> {
  // tenantId lives on the RouteSet, not on the Route — always join through routeSetId.
  const baseQuery = db
    .select({
      id: deploymentRouteTable.id,
      routeSetId: deploymentRouteTable.routeSetId,
      tenantId: deploymentRouteSetTable.tenantId,
    })
    .from(deploymentRouteTable)
    .innerJoin(
      deploymentRouteSetTable,
      eq(deploymentRouteSetTable.id, deploymentRouteTable.routeSetId),
    );

  if (args.route) {
    return baseQuery.where(eq(deploymentRouteTable.id, args.route)).limit(1);
  }

  if (args.routeSet) {
    return baseQuery.where(eq(deploymentRouteTable.routeSetId, args.routeSet));
  }

  if (args.tenant) {
    return baseQuery.where(eq(deploymentRouteSetTable.tenantId, args.tenant));
  }

  // All routes
  return baseQuery;
}

interface RebuildArgs {
  tenant?: string;
  routeSet?: string;
  route?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): RebuildArgs {
  const result: RebuildArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--tenant":
        result.tenant = argv[++i];
        break;
      case "--route-set":
        result.routeSet = argv[++i];
        break;
      case "--route":
        result.route = argv[++i];
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
    }
  }
  return result;
}

main().catch((error) => {
  console.error("[routes:rebuild-eligibility] 启动失败:", error);
  process.exit(1);
});
