import { getChatModel } from "@/lib/ai/provider";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import {
  appendThreadEvent,
  getMessagesByThreadId,
  getThreadByIdForUser,
  updateGeneratedTitle,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { chooseThreadTitle, fallbackTitleFromUserText } from "@/lib/thread-title";
import { generateText } from "ai";
import { NextResponse } from "next/server";

/**
 * V4 Phase C-1: LLM 生成会话标题（手动「重新生成标题」入口）。
 *
 * POST /api/threads/[id]/generate-title → 取最近 5 条消息 → LLM 浓缩为 6-12 字中文标题
 * → updateGeneratedTitle → 返回新标题。
 *
 * C-1 重构后（见 03-phase-c 方案）：自动标题生成改由 chat route 首条消息时并行触发
 *（generateThreadTitle），不再经此路由。本路由仅保留给会话操作菜单「重新生成标题」手动触发，
 * 无条件生成（不带 onlyIfTruncated / titleUpdatedAt 防抖守门——首条唯一触发已消除重复，
 * 手动重生成本就应无条件）。标题 AI 用同对话模型（thread.model）。
 */

export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;
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

  const messages = await getMessagesByThreadId(threadId);
  if (messages.length === 0) {
    return NextResponse.json({ error: "无消息可生成标题" }, { status: 400 });
  }

  // 取最近 5 条消息的 text part 拼成对话摘要
  const recent = messages.slice(-5);
  const dialog = recent
    .map((m) => {
      const role = m.role === "user" ? "用户" : "助手";
      const parts = (m.parts as Array<{ type: string; text?: string }>).filter(
        (p) => p.type === "text" && p.text,
      );
      const text = parts
        .map((p) => p.text)
        .join(" ")
        .slice(0, 200);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");

  if (!dialog.trim()) {
    return NextResponse.json({ error: "无文本内容可生成标题" }, { status: 400 });
  }

  try {
    // C-1: 标题 AI 用同对话模型（thread.model），不另设便宜模型
    const { text } = await generateText({
      model: getChatModel(thread.model ?? ""),
      system:
        "你是标题生成器。根据用户与助手的对话，生成一个 6-12 字的简洁中文标题，" +
        "概括对话主题。只输出标题文本，不要引号、不要标点、不要多余解释。",
      prompt: dialog,
      maxOutputTokens: 50,
    });
    const title = chooseThreadTitle(text, fallbackTitleFromUserText(dialog)) || thread.title;
    await updateGeneratedTitle(threadId, title);
    await appendThreadEvent(threadId, "thread.title_updated", { title, source: "manual_llm" });
    return NextResponse.json({ ok: true, data: { title } });
  } catch (error) {
    const title = fallbackTitleFromUserText(dialog);
    if (title) {
      await updateGeneratedTitle(threadId, title);
      await appendThreadEvent(threadId, "thread.title_updated", {
        title,
        source: "manual_fallback",
        reason: "llm_failed",
      });
      return NextResponse.json({ ok: true, data: { title, fallback: true } });
    }
    logger.error("[generate-title] LLM 生成失败且无兜底标题", { threadId, error: String(error) });
    return NextResponse.json({ error: "标题生成失败" }, { status: 500 });
  }
}
