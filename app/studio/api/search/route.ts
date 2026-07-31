import { db } from "@/lib/db/client";
import { agent, skill, thread } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { escapeLikeWildcards } from "@/lib/utils";
import { and, desc, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

/**
 * S1（12-P2-4）：Studio 跨实体搜索 API。
 * GET /studio/api/search?q=keyword → 搜 threads.title + skill.name/description + agent.name/description
 *
 * 覆盖 audit P2-4 的 thread/skill/agent 三实体。toolRun.input 全文不纳入——input 为 json,
 * 全文搜语义弱且成本高(toolRun 量级大),thread 标题/agent 名已是主要检索入口。
 * 过滤:thread 软删(deletedAt)+ skill 归档(status!=archived)+ agent 软删(deletedAt)。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return jsonOk({ results: [] });

  // 审计修复：非 admin 用户只搜自己拥有的 thread，防止跨用户标题泄露。
  // admin（拥有 thread.read.all）可搜全部 thread。
  const canReadAll = await hasPermission(r.user.id, "thread.read.all");
  // P2-2: 转义 LIKE 通配符,防 % 匹配全部行 / _ 匹配单字符探测数据形状
  const pattern = `%${escapeLikeWildcards(q)}%`;
  const threadConds = [isNull(thread.deletedAt), like(thread.title, pattern)];
  if (!canReadAll) {
    threadConds.push(eq(thread.userId, r.user.id));
  }
  const [threads, skills, agents] = await Promise.all([
    db
      .select({
        id: thread.id,
        title: thread.title,
        type: sql<string>`"thread"`,
        updatedAt: thread.updatedAt,
      })
      .from(thread)
      .where(and(...threadConds))
      .orderBy(desc(thread.updatedAt))
      .limit(10),
    db
      .select({
        id: skill.id,
        title: skill.name,
        type: sql<string>`"skill"`,
        updatedAt: skill.createdAt,
      })
      .from(skill)
      .where(
        and(
          ne(skill.status, "archived"),
          or(like(skill.name, pattern), like(skill.description, pattern)),
        ),
      )
      .limit(10),
    db
      .select({
        id: agent.id,
        title: agent.name,
        type: sql<string>`"agent"`,
        updatedAt: agent.createdAt,
      })
      .from(agent)
      .where(
        and(
          isNull(agent.deletedAt),
          or(like(agent.name, pattern), like(agent.description, pattern)),
        ),
      )
      .limit(10),
  ]).catch(() => [[], [], []]);

  return jsonOk({ results: [...threads, ...skills, ...agents] });
}
