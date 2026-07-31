"use client";

import { useThreadEvents } from "@/components/hooks/use-thread-events";
import { t } from "@/lib/i18n";
import { useRouter } from "next/navigation";

/**
 * P1 修复（12 Studio UI P1-3）：thread 详情页执行中自动刷新。
 *
 * 12-P1-3 改造：原 setInterval(router.refresh, 3000) 盲轮询改为 SSE 驱动——
 * 订阅 /api/threads/stream?threadId=xxx 的 status 事件，收到 status 变更才 router.refresh。
 * 执行中状态收到任意 event 也触发 refresh（qa/delivery/deployment 等变化实时反映）。
 * SSE 断线时 useThreadEvents 自动降级轮询（5s），保证断线下仍能刷新。
 *
 * 非执行中状态不订阅（避免无意义请求）。
 */

const EXECUTING_STATUSES = new Set([
  "executing",
  "awaiting_approval",
  "delivering",
  "verifying",
  "planning",
  "awaiting_input",
]);

export function ThreadAutoRefresh({ status, threadId }: { status: string; threadId: string }) {
  const router = useRouter();
  const isExecuting = EXECUTING_STATUSES.has(status);

  // 12-P1-3：SSE 驱动刷新——status 变更或执行中收到任意 event 都 router.refresh
  useThreadEvents({
    threadId,
    onStatus: () => {
      // status 变更（running→终态等）触发刷新拿准确状态
      router.refresh();
    },
    onEvent: () => {
      // 执行中收到任意事件（subagent/approval/task/qa 等）触发刷新
      if (isExecuting) {
        router.refresh();
      }
    },
    fallbackPollMs: 5000,
  });

  // 执行中时显示一个细微的「实时刷新中」指示器（不占额外空间）
  if (!isExecuting) return null;
  return (
    <span
      className="ml-2 inline-flex items-center gap-1 text-[11px] text-[var(--fg-subtle)]"
      aria-label={t("studio.auto_refresh.label")}
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
      {t("common.realtime")}
    </span>
  );
}
