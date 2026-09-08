import { getInvocationById } from "@/lib/runtime/invocation-queries";

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * 将持久 Invocation 的终态取消映射为本进程 AbortSignal。
 * 传输连接断开不参与此处判断；Gateway、Hosted 与 worker 都只服从同一持久状态。
 */
export function observeInvocationCancellation(params: {
  tenantId: string;
  invocationId: string;
  pollIntervalMs?: number;
}): { signal: AbortSignal; refresh(): Promise<void>; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  const check = (): Promise<void> => {
    if (disposed || controller.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const invocation = await getInvocationById(params.tenantId, params.invocationId);
        if (!invocation || isTerminal(invocation.executionState)) {
          controller.abort(new DOMException("父 Invocation 已结束", "AbortError"));
        }
      } catch (error) {
        // 无法确认父调用仍有效时，不允许继续创造新的外部副作用。
        controller.abort(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  void check();
  const timer = setInterval(() => void check(), params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    refresh: check,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
