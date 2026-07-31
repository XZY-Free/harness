import { describe, expect, it } from "vitest";
import { chooseThreadTitle, fallbackTitleFromUserText, normalizeThreadTitle } from "./thread-title";

describe("thread title helpers", () => {
  it("清洗模型标题中的引号和尾部标点", () => {
    expect(normalizeThreadTitle("「订单退款排查。」")).toBe("订单退款排查");
    expect(normalizeThreadTitle("用户: 帮我做一个订单退款失败排查后台")).toBe(
      "帮我做一个订单退款失败排查后台",
    );
  });

  it("从用户首条消息生成兜底标题", () => {
    expect(
      fallbackTitleFromUserText("帮我做一个订单退款失败排查后台，先生成一个最小可预览的静态页面。"),
    ).toBe("订单退款失败排查后台");
  });

  it("模型复读请求句时优先使用兜底标题", () => {
    expect(chooseThreadTitle("用户: 帮我做一个订单退款失败排查后台", "订单退款失败排查后台")).toBe(
      "订单退款失败排查后台",
    );
  });
});
