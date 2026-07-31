import {
  type AnalyticsScope,
  avgCompletionMs,
  perSkillPerformance,
  previewSuccessRate,
  threadSuccessRate,
  toolFailureBreakdown,
} from "@/lib/analytics/queries";
import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import type { User } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * Analytics API（Phase 4-2 / 4-3 / 4-4）：只读聚合端点。
 *
 * `GET /api/analytics?since=&until=&metric=&scope=`
 * - since / until：ISO 8601 时间窗口（均可选，省略=全量）。
 * - metric：`thread_success` / `preview_success` / `avg_completion` / `per_skill` / `tool_failures`；
 *   省略 = `summary`（聚合全部）。
 * - scope：`self`（默认，当前用户）/ `global`（全局，需 analytics.read.global）。
 *
 * 纯只读、无副作用、不写库（§4.5）。响应经 jsonOk 信封。
 *
 * Phase 4-3：默认 scope=self 只聚合当前用户数据，避免多用户指标互相泄露。
 * Phase 4-4：scope=global 经 RBAC analytics.read.global 守卫解锁全局运营视角。
 */

const METRICS = new Set([
  "summary",
  "thread_success",
  "preview_success",
  "avg_completion",
  "per_skill",
  "tool_failures",
]);

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const since = parseDate(sp.get("since"));
  const until = parseDate(sp.get("until"));

  // 传了 since/until 但解析失败 → 显式 400（而非静默当全量）
  if (sp.get("since") && since === undefined) {
    return jsonError(400, "bad_since", "since 非有效 ISO 8601 日期");
  }
  if (sp.get("until") && until === undefined) {
    return jsonError(400, "bad_until", "until 非有效 ISO 8601 日期");
  }

  const metric = sp.get("metric") ?? "summary";
  if (!METRICS.has(metric)) {
    return jsonError(400, "bad_metric", `metric 需为 ${[...METRICS].join(" / ")}`);
  }

  const scopeParam = sp.get("scope") ?? "self";
  if (scopeParam !== "self" && scopeParam !== "global") {
    return jsonError(400, "bad_scope", "scope 需为 self / global");
  }

  // 解析当前用户；trusted-headers 缺身份 → 401（不当 500）
  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(req);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    return jsonError(500, "internal_error", "服务器内部错误");
  }

  // scope=self（默认）：只聚合当前用户（零回归）；scope=global：需 analytics.read.global
  let scope: AnalyticsScope;
  if (scopeParam === "global") {
    const allowed = await hasPermission(currentUser.id, "analytics.read.global");
    if (!allowed) {
      return jsonError(403, "forbidden", "无 analytics.read.global 权限");
    }
    scope = { since, until }; // 全局聚合，不带 userId
  } else {
    scope = { userId: currentUser.id, since, until };
  }

  try {
    switch (metric) {
      case "thread_success":
        return jsonOk(await threadSuccessRate(scope));
      case "preview_success":
        return jsonOk(await previewSuccessRate(scope));
      case "avg_completion":
        return jsonOk(await avgCompletionMs(scope));
      case "per_skill":
        return jsonOk(await perSkillPerformance(scope));
      case "tool_failures":
        return jsonOk(await toolFailureBreakdown(scope));
      default: {
        // summary：聚合全部 5 类指标
        const [threadSuccess, previewSuccess, avgCompletion, perSkill, toolFailures] =
          await Promise.all([
            threadSuccessRate(scope),
            previewSuccessRate(scope),
            avgCompletionMs(scope),
            perSkillPerformance(scope),
            toolFailureBreakdown(scope),
          ]);
        return jsonOk({
          window: since || until ? { since, until } : null,
          threadSuccess,
          previewSuccess,
          avgCompletion,
          perSkill,
          toolFailures,
        });
      }
    }
  } catch (error) {
    // P2-3:不回显 err.message,防泄露内部信息。
    return jsonError(500, "analytics_failed", "统计分析失败");
  }
}
