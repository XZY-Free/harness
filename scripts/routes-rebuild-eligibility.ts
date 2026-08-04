/**
 * routes:rebuild-eligibility — 从权威事实重建 Route Eligibility Projection。
 *
 * 用法: pnpm routes:rebuild-eligibility [--tenant T] [--route-set RS] [--route R] [--dry-run]
 *
 * 必须可重复执行。每次重建幂等。
 */

import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { db } from "@/lib/db/client";
import { deploymentRouteTable } from "@/lib/persistence/schema/control-plane";
import { eq } from "drizzle-orm";

const args = parseArgs(process.argv.slice(2));

const buildRouteEligibility = createBuildRouteEligibility({
  store: mysqlRouteEligibilityStore,
});

async function main() {
  console.log("[routes:rebuild-eligibility] 开始重建", args);

  const routes = await listTargetRoutes();
  console.log(`[routes:rebuild-eligibility] 找到 ${routes.length} 条 Route`);

  if (args.dryRun) {
    console.log("[routes:rebuild-eligibility] --dry-run 模式，不执行写入");
    for (const route of routes) {
      console.log(`  routeId=${route.id} routeSetId=${route.routeSetId}`);
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

  console.log(`[routes:rebuild-eligibility] 完成: eligible=${eligible} ineligible=${ineligible} errors=${errors}`);
}

async function listTargetRoutes() {
  if (args.route) {
    const [route] = await db
      .select()
      .from(deploymentRouteTable)
      .where(eq(deploymentRouteTable.id, args.route))
      .limit(1);
    return route ? [route] : [];
  }

  let query = db.select().from(deploymentRouteTable);
  if (args.routeSet) {
    // Filter by routeSetId
    const routes = await db
      .select()
      .from(deploymentRouteTable)
      .where(eq(deploymentRouteTable.routeSetId, args.routeSet));
    return routes;
  }

  if (args.tenant) {
    const routes = await db
      .select()
      .from(deploymentRouteTable)
      .where(eq(deploymentRouteTable.tenantId, args.tenant));
    return routes;
  }

  // All routes
  return query;
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
