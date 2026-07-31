import { runAccessibilitySmokeUrl } from "@/lib/qa/a11y";
import { cleanupQaArtifacts } from "@/lib/qa/artifact";
import { runResponsiveCheckUrl } from "@/lib/qa/responsive";
import { afterAll, describe, expect, it } from "vitest";

const THREAD_ID = "qa-probe-browser-test";

function pageUrl(body: string, style = ""): string {
  const html = `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

afterAll(async () => {
  await cleanupQaArtifacts(THREAD_ID);
});

describe("QA browser probes", () => {
  it("透明容器继承白色背景时，黑色文本不产生对比度误报", async () => {
    const result = await runAccessibilitySmokeUrl({
      url: pageUrl(
        "<main><div><p>Readable text</p></div></main>",
        "body{background:#fff;color:#000}",
      ),
      threadId: THREAD_ID,
      checkId: "inherited-background",
      viewport: 1280,
    });

    expect(result.failures.filter((item) => item.type === "a11y_contrast")).toEqual([]);
  });

  it("低对比度叶子文本仍被识别", async () => {
    const result = await runAccessibilitySmokeUrl({
      url: pageUrl("<main><p>Low contrast text</p></main>", "body{background:#fff}p{color:#aaa}"),
      threadId: THREAD_ID,
      checkId: "low-contrast",
      viewport: 1280,
    });

    expect(result.failures.some((item) => item.type === "a11y_contrast")).toBe(true);
  });

  it("渐变背景上的文本不按白色背景误判", async () => {
    const result = await runAccessibilitySmokeUrl({
      url: pageUrl(
        "<main><p>Text on gradient</p></main>",
        "main{background:linear-gradient(90deg,#111,#333)}p{color:#fff}",
      ),
      threadId: THREAD_ID,
      checkId: "gradient-background",
      viewport: 1280,
    });

    expect(result.failures.filter((item) => item.type === "a11y_contrast")).toEqual([]);
  });

  it("容器与后代的天然相交不算布局重叠", async () => {
    const result = await runResponsiveCheckUrl({
      url: pageUrl("<main><div><p>Nested text</p></div></main>"),
      threadId: THREAD_ID,
      checkId: "nested-elements",
      viewports: [375],
    });

    expect(result.failures.filter((item) => item.type === "element_overlap")).toEqual([]);
  });

  it("两个独立文本元素明显覆盖时仍被识别", async () => {
    const result = await runResponsiveCheckUrl({
      url: pageUrl(
        '<main><p class="first">First</p><p class="second">Second</p></main>',
        "main{position:relative}.first,.second{position:absolute;inset:0 auto auto 0;width:100px;height:30px}",
      ),
      threadId: THREAD_ID,
      checkId: "sibling-overlap",
      viewports: [375],
    });

    expect(result.failures.some((item) => item.type === "element_overlap")).toBe(true);
  });
});
