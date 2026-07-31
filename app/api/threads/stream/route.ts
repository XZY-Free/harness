import { getCurrentUserFromRequest } from "@/lib/auth";
import { db } from "@/lib/db/client";
import {
  getThreadByIdForUser,
  listThreadEventsSince,
  listThreadStatusChanges,
} from "@/lib/db/queries";
import { thread } from "@/lib/db/schema";
import { redactObjectGlobal } from "@/lib/runtime/secret-redaction";
import { onThreadEvent } from "@/lib/runtime/thread-events-bus";
import { onThreadStatusChange } from "@/lib/runtime/thread-runner";
import { and, eq, isNull } from "drizzle-orm";

/**
 * V4 Phase B-6 + 12-P1-3：全局会话状态 SSE 端点（双通道）+ Studio 详情页多类事件推送。
 *
 * GET /api/threads/stream → 全局 thread status 流（侧栏订阅，无 threadId 参数）
 * GET /api/threads/stream?threadId=xxx → 单 thread 全事件流（Studio 详情页各面板订阅）
 *
 * 事件类型（统一信封）：
 *   data: {"kind":"status","threadId":"...","status":"running|done|failed|cancelled"}\n\n
 *   data: {"kind":"event","threadId":"...","type":"subagent.spawned","payload":{...},"sequence":N}\n\n
 *
 * 全局模式（无 threadId）只推 status 事件（侧栏消费，保持兼容）。
 * threadId 模式推 status + 该 thread 的所有 ThreadEvent 类型：
 *   subagent.spawned/joined/failed、tool.approval_requested/resolved、
 *   task.started/stopped/failed、qa.check_passed/failed、agent.status_changed 等。
 *
 * 双通道（完整实现，覆盖多实例）：
 * 1. 进程内订阅——本实例事件即时推（零延迟）。
 *    - onThreadStatusChange（status）
 *    - onThreadEvent（其他事件类型，仅 threadId 模式订阅）
 * 2. DB 增量轮询——补推他实例的变更（DB 是跨实例真相源）。
 *    - 全局模式：listThreadStatusChanges（每 3s）
 *    - threadId 模式：listThreadEventsSince（每 3s）
 *
 * 去重：lastPushedSeq 记录每 threadId 最后推送的 event sequence，同 sequence 不重复推。
 * status 事件用 lastPushedStatus Map 去重（同 status 不重复推）。
 *
 * 鉴权：需登录（未登录 401）。轮询按 userId / threadId 归属过滤。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300; // B-4：SSE 长连接放宽到 5min

const POLL_INTERVAL_MS = 3000; // 跨实例 DB 轮询周期

export async function GET(request: Request) {
  let userId: string;
  try {
    const user = await getCurrentUserFromRequest(request);
    userId = user.id;
  } catch {
    return new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // 12-P1-3：?threadId=xxx 切换到单 thread 全事件模式
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  const threadMode = threadId !== null;

  // 审计修复：threadMode 下校验当前用户拥有该 thread（防止越权订阅他人 thread 事件流）
  if (threadMode && threadId) {
    const owned = await getThreadByIdForUser(threadId, userId);
    if (!owned) {
      return new Response(JSON.stringify({ error: "Thread Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // 审计修复：全局模式下，预加载当前用户的 threadId 集合，用于过滤进程内状态事件。
  // 防止全局 SSE 把其他用户的 thread 状态变更推给当前用户。
  // DB 轮询路径（listThreadStatusChanges）已按 userId 过滤，此处补齐进程内广播的归属校验。
  let userThreadIds: Set<string> | null = null;
  if (!threadMode) {
    try {
      const rows = await db
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.userId, userId), isNull(thread.deletedAt)));
      userThreadIds = new Set(rows.map((r) => r.id));
    } catch {
      // DB 查询失败时退化为空集（不推送任何进程内事件，fail-closed）
      userThreadIds = new Set();
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // status 去重：同 threadId 同 updatedAt 不重复推（标题更新会改 updatedAt，需能触发刷新）
      const lastPushedAt = new Map<string, number>();
      // event 去重：同 threadId 同 sequence 不重复推（仅 threadId 模式）
      const lastPushedSeq = new Map<string, number>();
      // 轮询游标——仅看连接建立后的新变更（初始状态由客户端挂载时自行拉取）
      let since = new Date();

      const pushStatus = (tid: string, status: string, updatedAt?: Date) => {
        const at = updatedAt ? updatedAt.getTime() : Date.now();
        if ((lastPushedAt.get(tid) ?? 0) >= at) return;
        lastPushedAt.set(tid, at);
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ kind: "status", threadId: tid, status })}\n\n`,
            ),
          );
        } catch {
          // 连接已断
        }
      };

      const pushEvent = (ev: {
        threadId: string;
        type: string;
        payload: unknown;
        sequence: number;
      }) => {
        const last = lastPushedSeq.get(ev.threadId) ?? 0;
        if (ev.sequence <= last) return; // 同 sequence 或更旧不重复推
        lastPushedSeq.set(ev.threadId, ev.sequence);
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(
                // P1-23: SSE 出口脱敏——event payload 可能含 tool input/output 中的 secret,
                // 经 redactObjectGlobal 深遍历替换所有 thread 注册的 secret 明文。
                redactObjectGlobal({
                  kind: "event",
                  threadId: ev.threadId,
                  type: ev.type,
                  payload: ev.payload,
                  sequence: ev.sequence,
                }),
              )}\n\n`,
            ),
          );
        } catch {
          // 连接已断
        }
      };

      // 心跳：每 25s 发注释行，防中间代理超时断开
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // 连接已断
        }
      }, 25_000);

      // 通道 1：进程内状态变更 → 即时推（本实例 run）
      // 审计修复：全局模式下过滤 userThreadIds，防止把其他用户的 thread 状态推给当前用户
      const unsubscribeStatus = onThreadStatusChange((event) => {
        // threadId 模式仅推该 thread 的 status；全局模式按 userId 过滤
        if (threadMode && event.threadId !== threadId) return;
        if (!threadMode && userThreadIds && !userThreadIds.has(event.threadId)) return;
        pushStatus(event.threadId, event.status);
      });

      // 通道 1b：进程内 ThreadEvent 广播 → 即时推（仅 threadId 模式）
      // 全局模式不推 event（侧栏只关心 status）
      const unsubscribeEvent = threadMode
        ? onThreadEvent((event) => {
            if (event.threadId !== threadId) return;
            pushEvent(event);
          })
        : () => {};

      // 通道 2：DB 增量轮询 → 补推他实例变更
      const poll = setInterval(() => {
        if (threadMode && threadId) {
          // 单 thread 全事件轮询
          listThreadEventsSince(threadId, since)
            .then((events) => {
              let maxSeen = since;
              for (const e of events) {
                pushEvent({
                  threadId: e.threadId,
                  type: e.type,
                  payload: e.payload,
                  sequence: e.sequence,
                });
                if (e.createdAt > maxSeen) maxSeen = e.createdAt;
              }
              since = maxSeen;
            })
            .catch(() => {
              // 轮询失败不致命（DB 抖动），下个周期重试
            });
        } else {
          // 全局 status 轮询
          listThreadStatusChanges(userId, since)
            .then((changes) => {
              let maxSeen = since;
              for (const c of changes) {
                pushStatus(c.threadId, c.status, c.updatedAt);
                // 审计修复：DB 轮询发现的新 thread 加入 userThreadIds，
                // 让后续进程内事件也能推送（新建 thread 可能不在初始集合中）
                if (userThreadIds) userThreadIds.add(c.threadId);
                if (c.updatedAt > maxSeen) maxSeen = c.updatedAt;
              }
              since = maxSeen;
            })
            .catch(() => {
              // 轮询失败不致命
            });
        }
      }, POLL_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        clearInterval(poll);
        unsubscribeStatus();
        unsubscribeEvent();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
