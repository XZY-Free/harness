import { WebThreadShell } from "@/components/thread/web-thread-shell";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  if (threadId === "new") return <WebThreadShell threadId={null} />;
  if (!isValidUUID(threadId)) notFound();
  return <WebThreadShell threadId={threadId} />;
}

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
