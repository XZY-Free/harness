"use client";

/**
 * Governance 配置编辑器（关口02 02-6 · 冻结方案 §29 / §33 / §54-P2）。
 *
 * client 组件：编辑 protectedPaths / commandDenyList / formatOnWrite / verifyBeforeDelivery，
 * 保存调 PUT /studio/api/governance，携带 If-Match = 当前 versionNo（ETag 乐观锁，§33）。
 * - 412 → 并发冲突，提示刷新（绝不最后写入覆盖他人刚发布的 Revision）。
 * - 成功 → 从响应 ETag 头更新本地 versionNo，展示新 revisionNo。
 */
import { useState } from "react";

interface GovernanceConfigShape {
  protectedPaths: string[];
  commandDenyList: string[];
  formatOnWrite: boolean;
  verifyBeforeDelivery: boolean;
}

interface Props {
  initialConfig: GovernanceConfigShape;
  initialVersionNo: number;
  canWrite: boolean;
  revisionNo: number;
  publishedAt: string | null;
}

function textToLines(value: string[]): string {
  return value.join("\n");
}

function linesToText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function GovernanceEditor({
  initialConfig,
  initialVersionNo,
  canWrite,
  revisionNo,
  publishedAt,
}: Props) {
  const [protectedPaths, setProtectedPaths] = useState(initialConfig.protectedPaths);
  const [commandDenyList, setCommandDenyList] = useState(initialConfig.commandDenyList);
  const [formatOnWrite, setFormatOnWrite] = useState(initialConfig.formatOnWrite);
  const [verifyBeforeDelivery, setVerifyBeforeDelivery] = useState(
    initialConfig.verifyBeforeDelivery,
  );
  const [versionNo, setVersionNo] = useState(initialVersionNo);
  const [savedRevisionNo, setSavedRevisionNo] = useState(revisionNo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!canWrite) {
    return (
      <div className="rounded border border-[var(--border)] p-4 text-[13px]">
        <div className="grid grid-cols-1 gap-3">
          <Row label="受保护路径">
            {initialConfig.protectedPaths.length
              ? initialConfig.protectedPaths.join(", ")
              : "（空）"}
          </Row>
          <Row label="命令黑名单">
            {initialConfig.commandDenyList.length
              ? initialConfig.commandDenyList.join(", ")
              : "（空）"}
          </Row>
          <Row label="写前格式化">{initialConfig.formatOnWrite ? "是" : "否"}</Row>
          <Row label="交付前校验">{initialConfig.verifyBeforeDelivery ? "是" : "否"}</Row>
        </div>
        <Meta revisionNo={savedRevisionNo} publishedAt={publishedAt} />
      </div>
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const config: GovernanceConfigShape = {
      protectedPaths,
      commandDenyList,
      formatOnWrite,
      verifyBeforeDelivery,
    };
    try {
      const res = await fetch("/studio/api/governance", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(versionNo),
        },
        body: JSON.stringify({ config }),
      });
      if (res.status === 412) {
        setError("并发冲突：其他管理员刚发布了新配置。请刷新后重试（不覆盖他人修订）。");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(`保存失败（${res.status}）：${data?.error ?? "未知错误"}`);
        return;
      }
      const data = await res.json();
      const nextEtag = res.headers.get("etag");
      if (nextEtag) {
        const n = Number(nextEtag);
        if (Number.isInteger(n)) setVersionNo(n);
      }
      setSavedRevisionNo(data.revision?.revisionNo ?? savedRevisionNo);
      setNotice(`已发布 revision ${data.revision?.revisionNo ?? ""}`);
    } catch {
      setError("网络错误，保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-[var(--border)] p-4 text-[13px]">
      <div className="grid grid-cols-1 gap-4">
        <Field label="受保护路径（每行一条）">
          <textarea
            className="h-20 w-full rounded border border-[var(--border)] p-2 font-mono text-[12px]"
            value={textToLines(protectedPaths)}
            onChange={(e) => setProtectedPaths(linesToText(e.target.value))}
            placeholder={"/etc/secret\n/private"}
          />
        </Field>
        <Field label="命令黑名单（每行一条）">
          <textarea
            className="h-20 w-full rounded border border-[var(--border)] p-2 font-mono text-[12px]"
            value={textToLines(commandDenyList)}
            onChange={(e) => setCommandDenyList(linesToText(e.target.value))}
            placeholder={"rm -rf\ndd"}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formatOnWrite}
              onChange={(e) => setFormatOnWrite(e.target.checked)}
            />
            写入前自动格式化
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={verifyBeforeDelivery}
              onChange={(e) => setVerifyBeforeDelivery(e.target.checked)}
            />
            交付前校验
          </label>
        </div>
      </div>

      {error && <div className="mt-3 text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="mt-3 text-[12px] text-[var(--success)]">{notice}</div>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {saving ? "保存中…" : "发布新配置"}
        </button>
        <span className="text-[11px] text-[var(--fg-muted)]">ETag: {versionNo}</span>
      </div>
      <Meta revisionNo={savedRevisionNo} publishedAt={publishedAt} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-[var(--fg-muted)]">{label}</span>
      <span className="whitespace-pre-wrap">{children}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[var(--fg-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Meta({ revisionNo, publishedAt }: { revisionNo: number; publishedAt: string | null }) {
  return (
    <div className="mt-3 text-[11px] text-[var(--fg-muted)]">
      当前修订：rev {revisionNo}
      {publishedAt ? ` · 发布于 ${new Date(publishedAt).toLocaleString()}` : ""}
    </div>
  );
}
