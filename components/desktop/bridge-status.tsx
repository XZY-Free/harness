"use client";

import { getDesktopCapabilities } from "@/lib/desktop/capabilities";
import { useEffect, useState } from "react";

/**
 * V10 Phase 5：Desktop Agent Bridge 连接状态指示器。
 *
 * 显示 Desktop 与 Server 之间的 Agent Bridge 连接状态：
 * - disconnected: 灰色圆点，"未连接"
 * - connecting: 黄色圆点（脉冲），"连接中"
 * - connected: 蓝色圆点，"已连接"
 * - authenticated: 绿色圆点，"已认证"
 * - revoked: 红色圆点，"设备已撤销"
 * - protocol_mismatch: 红色圆点，"协议版本不兼容"
 * - reconnecting: 黄色圆点（脉冲），"重连中"
 *
 * 仅在 Desktop 环境渲染。非 Desktop 环境返回 null。
 */
type BridgeState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "authenticated"
  | "revoked"
  | "protocol_mismatch"
  | "reconnecting";

const STATE_CONFIG: Record<BridgeState, { color: string; label: string; pulse?: boolean }> = {
  disconnected: { color: "var(--fg-subtle)", label: "未连接" },
  connecting: { color: "var(--warning)", label: "连接中", pulse: true },
  connected: { color: "var(--info)", label: "已连接" },
  authenticated: { color: "var(--success)", label: "已认证" },
  revoked: { color: "var(--danger)", label: "设备已撤销" },
  protocol_mismatch: { color: "var(--danger)", label: "协议版本不兼容" },
  reconnecting: { color: "var(--warning)", label: "重连中", pulse: true },
};

export function BridgeStatus() {
  const [state, setState] = useState<BridgeState>("disconnected");
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const caps = getDesktopCapabilities();
    if (!caps) {
      setIsDesktop(false);
      return;
    }
    setIsDesktop(true);

    // 读取初始状态
    const snowDesktop = (
      window as unknown as {
        snowDesktop?: {
          bridge?: {
            getState: () => Promise<BridgeState>;
            onStateChange: (cb: (state: BridgeState) => void) => () => void;
          };
        };
      }
    ).snowDesktop;

    if (!snowDesktop?.bridge) {
      return;
    }

    // 获取初始状态
    void snowDesktop.bridge.getState().then(setState);

    // 订阅状态变化
    const unsubscribe = snowDesktop.bridge.onStateChange((newState) => {
      setState(newState);
    });

    return unsubscribe;
  }, []);

  if (!isDesktop) {
    return null;
  }

  const config = STATE_CONFIG[state];

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1"
      data-testid="bridge-status"
      data-state={state}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${config.pulse ? "animate-pulse" : ""}`}
        style={{ backgroundColor: config.color }}
      />
      <span className="text-[11px] font-medium text-[var(--fg-muted)]">{config.label}</span>
    </div>
  );
}
