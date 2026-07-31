"use client";

import { Workspace } from "@/components/workspace";
import { apiFetch } from "@/lib/api-fetch";
import { getDesktopBridge, getDesktopCapabilities } from "@/lib/desktop/capabilities";
import type { ChatMessage, ThreadStatus } from "@/lib/types";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

interface DesktopWorkspaceProps {
  userId: string;
  threadId: string;
  initialMessages: ChatMessage[];
  initialStatus: ThreadStatus;
  initialModel?: string;
  initialPreviewUrl?: string;
  initialTitle?: string;
}

const subscribeCapability = () => () => undefined;

export function DesktopWorkspace(props: DesktopWorkspaceProps) {
  const isDesktop = useSyncExternalStore(
    subscribeCapability,
    () => getDesktopCapabilities() !== null,
    () => false,
  );
  const [bindingFailed, setBindingFailed] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    const bridge = getDesktopBridge();
    if (!bridge) {
      setBindingFailed(true);
      return;
    }
    let cancelled = false;
    const bindDevice = async () => {
      try {
        const registration = await bridge.device.getRegistration();
        const response = await apiFetch("/api/desktop/devices/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        });
        if (!response.ok) throw new Error(`设备绑定失败 (${response.status})`);
        if (!cancelled) {
          setBindingFailed(false);
          await bridge.bridge.connect();
        }
      } catch {
        if (!cancelled) setBindingFailed(true);
      }
    };
    void bindDevice();
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  if (!isDesktop) return <DesktopRequiredNotice />;

  return (
    <div className="flex h-screen min-h-0 flex-col">
      {bindingFailed ? (
        <output className="shrink-0 border-b border-[var(--danger)] px-4 py-2 text-center text-[12px] text-[var(--danger)]">
          AI 浏览器连接失败，本地浏览不受影响
        </output>
      ) : null}
      <div className="min-h-0 flex-1">
        <Workspace {...props} platform="desktop" />
      </div>
    </div>
  );
}

function DesktopRequiredNotice() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-[22px] font-semibold text-[var(--fg)]">需要 SnowHarness Desktop</h1>
        <p className="max-w-[420px] text-[14px] text-[var(--fg-muted)]">
          此页面仅在 SnowHarness macOS Desktop 客户端中可用。
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex h-9 items-center justify-center border border-[var(--border)] px-4 text-[13px] text-[var(--fg)] hover:bg-[var(--surface-2)]"
      >
        返回 Web 版
      </Link>
    </main>
  );
}
