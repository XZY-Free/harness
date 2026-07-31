import { describe, expect, it } from "vitest";
import {
  type Bounds,
  MIN_BOUNDS_SIZE,
  type WindowConstraints,
  boundsChanged,
  hiddenBounds,
  validateBounds,
} from "./bounds-validator";

/**
 * V10 Phase 4：WebContentsView bounds 校验器单元测试。
 *
 * 覆盖：
 * - validateBounds：合法 / 非法 / 边界 / 取整 / scaleFactor 校验
 * - boundsChanged：相同 / 亚像素差异 / 整像素差异
 * - hiddenBounds：返回最小隐藏 bounds
 */

/** 默认窗口约束（1280x800 内容区）。 */
const CONSTRAINTS: WindowConstraints = { windowWidth: 1280, windowHeight: 800 };

/** 默认 scaleFactor（Retina）。 */
const SCALE = 2;

describe("bounds-validator validateBounds (V10 Phase 4)", () => {
  it("合法 bounds 返回 ok + sanitized", () => {
    const result = validateBounds({ x: 0, y: 0, width: 100, height: 100 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(true);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("bounds 为 null 返回 error", () => {
    const result = validateBounds(null, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.bounds).toBeUndefined();
    expect(result.error).toContain("对象");
  });

  it("bounds 为 undefined 返回 error", () => {
    const result = validateBounds(undefined, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("bounds 为 string 返回 error", () => {
    const result = validateBounds("not an object", CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("bounds 为 number 返回 error", () => {
    const result = validateBounds(42, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("x 为 NaN 返回 error", () => {
    const result = validateBounds(
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x");
  });

  it("x 为 Infinity 返回 error", () => {
    const result = validateBounds(
      { x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x");
  });

  it("x 为 string 返回 error", () => {
    const result = validateBounds({ x: "0", y: 0, width: 10, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x");
  });

  it("y 为 NaN 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: Number.NaN, width: 10, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("y");
  });

  it("y 为 Infinity 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("y");
  });

  it("y 为 string 返回 error", () => {
    const result = validateBounds({ x: 0, y: "0", width: 10, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("y");
  });

  it("width 为 NaN 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it("width 为 Infinity 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it("width 为 string 返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: "10", height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it("height 为 NaN 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: 10, height: Number.NaN },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("height");
  });

  it("height 为 Infinity 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("height");
  });

  it("height 为 string 返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: "10" }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("height");
  });

  it("x 为负数返回 error", () => {
    const result = validateBounds({ x: -1, y: 0, width: 10, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x");
  });

  it("y 为负数返回 error", () => {
    const result = validateBounds({ x: 0, y: -1, width: 10, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("y");
  });

  it(`width 小于 ${MIN_BOUNDS_SIZE} 返回 error`, () => {
    const result = validateBounds({ x: 0, y: 0, width: 0, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it(`height 小于 ${MIN_BOUNDS_SIZE} 返回 error`, () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: 0 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("height");
  });

  it("width 为负数返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: -5, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it("height 为负数返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: -5 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("height");
  });

  it("x+width 超出 windowWidth 返回 error", () => {
    const result = validateBounds({ x: 1000, y: 0, width: 500, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("右边界");
  });

  it("y+height 超出 windowHeight 返回 error", () => {
    const result = validateBounds({ x: 0, y: 700, width: 10, height: 200 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("下边界");
  });

  it("scaleFactor 为 0 返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: 10 }, CONSTRAINTS, 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scaleFactor");
  });

  it("scaleFactor 为负数返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: 10 }, CONSTRAINTS, -1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scaleFactor");
  });

  it("scaleFactor 为 NaN 返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, width: 10, height: 10 }, CONSTRAINTS, Number.NaN);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scaleFactor");
  });

  it("scaleFactor 为 Infinity 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: 10, height: 10 },
      CONSTRAINTS,
      Number.POSITIVE_INFINITY,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scaleFactor");
  });

  it("scaleFactor 为 string 返回 error", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: 10, height: 10 },
      CONSTRAINTS,
      "2" as unknown as number,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scaleFactor");
  });

  it("浮点数 bounds 被 Math.round 取整", () => {
    const result = validateBounds(
      { x: 0.4, y: 0.6, width: 100.49, height: 99.5 },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(true);
    expect(result.bounds).toEqual({ x: 0, y: 1, width: 100, height: 100 });
  });

  it("正好在边界上的 bounds 通过（x+width === windowWidth）", () => {
    const result = validateBounds({ x: 180, y: 0, width: 1100, height: 100 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(true);
    expect(result.bounds?.x).toBe(180);
    expect(result.bounds?.width).toBe(1100);
  });

  it("正好在底边界的 bounds 通过（y+height === windowHeight）", () => {
    const result = validateBounds({ x: 0, y: 400, width: 100, height: 400 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(true);
    expect(result.bounds?.y).toBe(400);
    expect(result.bounds?.height).toBe(400);
  });

  it("constraints 极小（1x1）时合法 1x1 bounds 通过", () => {
    const tiny: WindowConstraints = { windowWidth: 1, windowHeight: 1 };
    const result = validateBounds({ x: 0, y: 0, width: 1, height: 1 }, tiny, SCALE);
    expect(result.ok).toBe(true);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("constraints 极小（1x1）时 2x1 bounds 超出右边界", () => {
    const tiny: WindowConstraints = { windowWidth: 1, windowHeight: 1 };
    const result = validateBounds({ x: 0, y: 0, width: 2, height: 1 }, tiny, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("右边界");
  });

  it("constraints 极小（1x1）时 1x2 bounds 超出下边界", () => {
    const tiny: WindowConstraints = { windowWidth: 1, windowHeight: 1 };
    const result = validateBounds({ x: 0, y: 0, width: 1, height: 2 }, tiny, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("下边界");
  });

  it("scaleFactor = 1（普通屏幕）合法 bounds 通过", () => {
    const result = validateBounds({ x: 0, y: 0, width: 100, height: 100 }, CONSTRAINTS, 1);
    expect(result.ok).toBe(true);
  });

  it("缺字段（width undefined）返回 error", () => {
    const result = validateBounds({ x: 0, y: 0, height: 10 }, CONSTRAINTS, SCALE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("width");
  });

  it("额外字段不影响校验", () => {
    const result = validateBounds(
      { x: 0, y: 0, width: 10, height: 10, extra: "ignored" },
      CONSTRAINTS,
      SCALE,
    );
    expect(result.ok).toBe(true);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe("bounds-validator boundsChanged (V10 Phase 4)", () => {
  it("完全相同返回 false", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    expect(boundsChanged(a, b)).toBe(false);
  });

  it("x 差异 ≥1px 返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 11, y: 20, width: 100, height: 200 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("y 差异 ≥1px 返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10, y: 21, width: 100, height: 200 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("width 差异 ≥1px 返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10, y: 20, width: 101, height: 200 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("height 差异 ≥1px 返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10, y: 20, width: 100, height: 201 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("亚像素差异（<1px）返回 false", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10.4, y: 20.4, width: 100.4, height: 200.4 };
    expect(boundsChanged(a, b)).toBe(false);
  });

  it("仅 x 不同（其他相同）返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 50, y: 20, width: 100, height: 200 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("仅 height 不同（其他相同）返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 10, y: 20, width: 100, height: 300 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("差异正好 1px 返回 true", () => {
    const a: Bounds = { x: 0, y: 0, width: 100, height: 100 };
    const b: Bounds = { x: 1, y: 0, width: 100, height: 100 };
    expect(boundsChanged(a, b)).toBe(true);
  });

  it("负方向差异 ≥1px 返回 true", () => {
    const a: Bounds = { x: 10, y: 20, width: 100, height: 200 };
    const b: Bounds = { x: 9, y: 20, width: 100, height: 200 };
    expect(boundsChanged(a, b)).toBe(true);
  });
});

describe("bounds-validator hiddenBounds (V10 Phase 4)", () => {
  it("返回 {x:0, y:0, width:1, height:1}", () => {
    expect(hiddenBounds()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("多次调用返回新对象（不可变语义）", () => {
    const a = hiddenBounds();
    const b = hiddenBounds();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
