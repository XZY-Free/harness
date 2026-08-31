import type { ClientItem } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactItem } from "./artifact-item";

afterEach(cleanup);

const artifact: ClientItem = {
  id: "artifact-item-1",
  turn_id: "turn-1",
  item_sequence: 1,
  item_type: "artifact",
  item_state: "completed",
  content: {
    artifact_id: "artifact-1",
    display_name: "report.ts",
    artifact_type: "code",
    media_type: "text/typescript",
    byte_size: 2048,
    availability: "cloud",
    source_turn_id: "turn-internal-1",
    source_invocation_id: "invocation-internal-1",
    source_tool_call_id: "tool-internal-1",
    content_hash: "sha256:1234567890abcdef1234567890abcdef",
    content_ref: "s3://internal-bucket/private/report.ts",
  },
  created_at: "2026-08-31T10:00:00.000Z",
};

describe("ArtifactItem 文件卡片", () => {
  it("突出文件与操作，不在员工卡片默认暴露内部追踪字段", () => {
    const { container } = render(<ArtifactItem item={artifact} />);

    expect(screen.getByText("report.ts")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
    expect(container.querySelector(".lucide-file-code-corner")).not.toBeNull();
    expect(screen.queryByText(/turn-internal-1/)).toBeNull();
    expect(screen.queryByText(/invocation-internal-1/)).toBeNull();
    expect(screen.queryByText(/tool-internal-1/)).toBeNull();
    expect(screen.queryByText(/internal-bucket/)).toBeNull();
    expect(screen.queryByText(/1234567890abcdef/)).toBeNull();
  });
});
