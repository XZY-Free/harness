import { describe, expect, it } from "vitest";

import { isNewThreadShortcut } from "./workspace-shortcuts";

describe("isNewThreadShortcut", () => {
  it("只匹配不带 Shift 或 Alt 的 Cmd/Ctrl+N", () => {
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isNewThreadShortcut({
        key: "N",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
      }),
    ).toBe(false);
  });
});
