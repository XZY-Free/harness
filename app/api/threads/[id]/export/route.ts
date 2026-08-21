import { getMessagesByThreadId, getThreadByIdForUser } from "@/lib/db/queries";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

/**
 * V4 Phase C-4: 导出聊天记录（后端完整实现）。
 *
 * GET /api/threads/[id]/export?format=md|json
 *
 * 替代此前的纯前端降级（fetch messages + 前端拼字符串）：后端拿 DB 完整历史，
 * 包含时间戳 / 附件 / 工具调用，Content-Disposition 触发浏览器下载。
 * 鉴权：复用 thread owner 校验（foreign → 404，不泄露）。
 */

export const dynamic = "force-dynamic";

type ExportPart = {
  type: string;
  text?: string;
  data?: { filename?: string; charCount?: number; text?: string } | Record<string, unknown>;
  // tool-* 工具调用 part 的常见字段（宽松处理，跨 part 类型）
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  state?: string;
};

function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 把单条消息渲染为 Markdown 片段（含时间戳 / 文本 / 附件 / 工具调用）。 */
function messageToMarkdown(msg: {
  role: string;
  createdAt: Date | string | null;
  parts: ExportPart[];
}): string {
  const roleLabel = msg.role === "user" ? "🧑 用户" : "🤖 助手";
  const ts = fmtTime(msg.createdAt);
  const lines: string[] = [`### ${roleLabel}${ts ? `  ·  ${ts}` : ""}`, ""];

  for (const part of msg.parts ?? []) {
    if (part.type === "text" && part.text) {
      lines.push(part.text, "");
      continue;
    }
    // 附件（data-attachment）
    if (part.type === "data-attachment" && part.data) {
      const d = part.data as { filename?: string; charCount?: number };
      lines.push(
        `> 📎 附件：${d.filename ?? "未命名"}${d.charCount ? `（${d.charCount} 字符）` : ""}`,
        "",
      );
      continue;
    }
    // 工具调用 tool-*
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const input = part.input ? JSON.stringify(part.input) : "";
      const output = part.output ? JSON.stringify(part.output) : "";
      lines.push(`> 🔧 工具调用（${part.type}${part.state ? ` · ${part.state}` : ""}）`);
      if (input) lines.push(`> - 入参：${input}`);
      if (output) lines.push(`> - 结果：${output}`);
      lines.push("");
      continue;
    }
    // 推理 / 其他
    if (part.type === "reasoning" && part.text) {
      lines.push("<details><summary>💭 思考过程</summary>", "", part.text, "", "</details>", "");
    }
  }
  return lines.join("\n");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "md";

  let userId: string;
  try {
    const principal = await resolveStudioPrincipal(request.headers);
    userId = principal.userIdentityId;
  } catch {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  const thread = await getThreadByIdForUser(threadId, userId);
  if (!thread) {
    return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
  }

  const messages = await getMessagesByThreadId(threadId, { limit: 5000 });
  const safeTitle = (thread.title ?? "chat").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  let body: string;
  let contentType: string;
  let ext: string;

  if (format === "json") {
    body = JSON.stringify(
      {
        thread: {
          id: thread.id,
          title: thread.title,
          model: thread.model,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        },
        exportedAt: new Date().toISOString(),
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          type: m.type,
          createdAt: m.createdAt,
          parts: m.parts,
        })),
      },
      null,
      2,
    );
    contentType = "application/json; charset=utf-8";
    ext = "json";
  } else {
    const header = [
      `# ${thread.title ?? "会话导出"}`,
      "",
      `> 模型：${thread.model ?? "—"}  ·  导出时间：${fmtTime(new Date())}  ·  消息数：${messages.length}`,
      "",
      "---",
      "",
    ].join("\n");
    const body_md = messages
      .map((m) =>
        messageToMarkdown({
          role: m.role,
          createdAt: m.createdAt,
          parts: (m.parts as ExportPart[]) ?? [],
        }),
      )
      .join("\n---\n\n");
    body = `${header}${body_md}`;
    contentType = "text/markdown; charset=utf-8";
    ext = "md";
  }

  const filename = `${safeTitle}-${threadId.slice(0, 8)}.${ext}`;
  // RFC 5987 编码文件名，兼容中文
  const encodedFilename = encodeURIComponent(filename);
  logger.info("[export] 导出会话", { threadId, format, messageCount: messages.length });

  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodedFilename}`,
      "cache-control": "no-cache, no-transform",
    },
  });
}
