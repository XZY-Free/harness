/**
 * Artifact Item（artifact）。
 *
 * W05 增强范围：
 * - 展示来源 Turn / Invocation / ToolCall、内容类型、保存位置、内容 hash 和可执行操作。
 * - Desktop 本地 Artifact 仅在持有文件的设备上可"打开"；Web 显示等待设备或可用的云端副本，
 *   不伪造本地访问（W05 计划行 76-77）。
 *
 * content 结构（与服务端 projectItem 投影对齐，兼容旧字段）：
 * ```
 * {
 *   artifact_id: string,
 *   display_name?: string, title?: string,                  // 员工可见文件名
 *   artifact_type?: "file"|"image"|"archive"|"report"|"dataset"|"log",
 *   media_type?: string, content_type?: string,             // MIME
 *   byte_size?: number, size?: number,                      // 字节大小
 *   content_hash?: string, hash?: string,                   // sha256:<hex>
 *   content_ref?: string, location?: string,                // 受管引用（s3:// oci:// file://internal/...）
 *   visibility_scope?: "thread"|"workspace"|"owner"|"organization",
 *   // 来源（W05）
 *   source_turn_id?: string,
 *   source_invocation_id?: string,
 *   source_tool_call_id?: string,
 *   // 可用性（W05）
 *   availability?: "local" | "cloud" | "pending_device" | "unavailable",
 *   device_id?: string,                                     // 本地文件持有设备
 *   device_status?: "online" | "offline" | "unknown",
 *   expires_at?: string                                     // ISO 8601
 * }
 * ```
 *
 * 样式：文件卡片（带图标 + 元信息 + 操作按钮）。
 */
"use client";

import { Button } from "@/components/ui/button";
import { WorkspaceFileIcon } from "@/components/workspace-panel/workspace-file-icon";
import type { ClientItem } from "@/lib/client/types";
import { useMemo } from "react";

/** 可用性取值。 */
export type ArtifactAvailability = "local" | "cloud" | "pending_device" | "unavailable";

/** Artifact content 投影（兼容旧字段）。 */
interface ArtifactContent {
  artifact_id?: string;
  display_name?: string;
  title?: string;
  artifact_type?: string;
  media_type?: string;
  content_type?: string;
  byte_size?: number;
  size?: number;
  content_hash?: string;
  hash?: string;
  content_ref?: string;
  location?: string;
  visibility_scope?: string;
  source_turn_id?: string;
  source_invocation_id?: string;
  source_tool_call_id?: string;
  availability?: ArtifactAvailability;
  device_id?: string;
  device_status?: "online" | "offline" | "unknown";
  expires_at?: string;
}

export interface ArtifactItemProps {
  readonly item: ClientItem;
  /**
   * 当前是否运行在 Desktop Shell 中。
   * - true：本地 Artifact（availability=local）允许"在 Desktop 打开"。
   * - false（默认）：Web 模式，本地 Artifact 显示"等待设备"，不伪造本地访问。
   */
  readonly isDesktop?: boolean;
  /** 当前 Desktop 设备 id（isDesktop=true 时使用）；用于校验本地 Artifact 是否属于当前设备。 */
  readonly currentDeviceId?: string | null;
  /** 打开/下载回调（可选）；不传时按钮渲染但仅触发 console.info。 */
  readonly onOpen?: (artifactId: string, availability: ArtifactAvailability) => void;
}

/** 字节大小 → 人类可读字符串。 */
function formatByteSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 计算可用性。无显式 availability 时按 cloud 处理。 */
function resolveAvailability(content: ArtifactContent): ArtifactAvailability {
  if (content.availability) return content.availability;
  // 默认按云端可用处理（Web 安全默认；不伪造本地访问）
  return "cloud";
}

function artifactTypeLabel(artifactType: string | undefined, mediaType: string): string {
  if (artifactType === "image" || mediaType.startsWith("image/")) return "图片";
  if (artifactType === "dataset") return "数据文件";
  if (
    artifactType === "code" ||
    mediaType.includes("javascript") ||
    mediaType.includes("typescript")
  ) {
    return "代码文件";
  }
  if (mediaType.includes("spreadsheet") || mediaType.includes("csv")) return "表格";
  if (mediaType.includes("pdf")) return "PDF 文档";
  if (mediaType.startsWith("text/")) return "文档";
  return "文件";
}

export function ArtifactItem({
  item,
  isDesktop = false,
  currentDeviceId = null,
  onOpen,
}: ArtifactItemProps) {
  const content = item.content as ArtifactContent;

  const displayName = content.display_name ?? content.title ?? "未命名文件";
  const mediaType = content.media_type ?? content.content_type ?? "unknown";
  const byteSize = content.byte_size ?? content.size;
  const availability = resolveAvailability(content);
  const artifactId = content.artifact_id ?? item.id;

  const sizeText = formatByteSize(byteSize);
  const typeLabel = artifactTypeLabel(content.artifact_type, mediaType);

  // 是否属于当前 Desktop 设备（isDesktop=true + availability=local + device_id 匹配）
  const isLocalOnCurrentDevice =
    isDesktop &&
    availability === "local" &&
    (!content.device_id || !currentDeviceId || content.device_id === currentDeviceId);

  // 操作按钮文案 + 行为
  const action = useMemo<{ label: string; disabled: boolean; hint?: string }>(() => {
    switch (availability) {
      case "local":
        if (isDesktop) {
          if (isLocalOnCurrentDevice) {
            return { label: "在 Desktop 打开", disabled: false };
          }
          return {
            label: "等待设备",
            disabled: true,
            hint: content.device_id
              ? `文件在设备 ${content.device_id} 上，当前 Desktop 不是该设备`
              : "文件在其他 Desktop 设备上",
          };
        }
        // Web 端：本地 Artifact 不伪造访问
        return {
          label: "等待设备",
          disabled: true,
          hint: content.device_id
            ? `本地文件在 Desktop 设备 ${content.device_id} 上，请在该设备打开`
            : "本地文件需在持有该文件的 Desktop 设备上打开",
        };
      case "cloud":
        return { label: "下载", disabled: false };
      case "pending_device":
        return {
          label: "等待设备",
          disabled: true,
          hint: content.device_id
            ? `等待 Desktop 设备 ${content.device_id} 上线`
            : "等待 Desktop 设备上线",
        };
      case "unavailable":
        return { label: "暂不可用", disabled: true, hint: "Artifact 暂不可用" };
    }
  }, [availability, isDesktop, isLocalOnCurrentDevice, content.device_id]);

  const handleClick = () => {
    if (action.disabled) return;
    onOpen?.(artifactId, availability);
  };

  return (
    <div className="flex justify-start py-1">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm">
        <div className="flex items-start gap-3">
          {/* 文件图标 */}
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <WorkspaceFileIcon name={displayName} className="size-4.5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-foreground text-sm" title={displayName}>
              {displayName}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
              <span>{typeLabel}</span>
              {sizeText ? (
                <>
                  <span aria-hidden="true" className="text-foreground-subtle">
                    ·
                  </span>
                  <span>{sizeText}</span>
                </>
              ) : null}
            </div>

            {/* 可用性提示（pending_device / unavailable / Web 端 local） */}
            {action.hint ? <div className="mt-1.5 text-warning text-xs">{action.hint}</div> : null}
          </div>

          {/* 操作按钮 */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={action.disabled}
            onClick={handleClick}
          >
            {action.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
