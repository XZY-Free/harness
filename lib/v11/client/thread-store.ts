/**
 * V11 员工端 Thread 投影 Store。
 *
 * 外部 store 模式（与 React useSyncExternalStore 兼容）：
 * - getState() 返回当前 immutable 状态快照。
 * - dispatch(action) 通过 reducer 计算新状态并通知 listener。
 * - subscribe(listener) 返回 unsubscribe。
 *
 * 不依赖 React；可在纯 Node 测试环境使用。
 */
import { threadProjectionReducer } from "./thread-reducer";
import type { V11ThreadProjectionAction, V11ThreadProjectionState } from "./types";

export type V11ThreadStoreListener = (state: V11ThreadProjectionState) => void;

export interface V11ThreadStore {
  /** 当前状态快照。 */
  getState(): V11ThreadProjectionState;
  /** 分发 action。 */
  dispatch(action: V11ThreadProjectionAction): void;
  /** 订阅状态变化。 */
  subscribe(listener: V11ThreadStoreListener): () => void;
}

/** 创建 Thread Store。 */
export function createThreadStore(initialState: V11ThreadProjectionState): V11ThreadStore {
  let state = initialState;
  const listeners = new Set<V11ThreadStoreListener>();

  return {
    getState: () => state,
    dispatch: (action) => {
      const next = threadProjectionReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) {
        listener(state);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
