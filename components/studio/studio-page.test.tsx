import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StudioPage } from "./studio-page";

afterEach(cleanup);

describe("StudioPage", () => {
  it("窄屏标题和操作区纵向排列，避免说明文字被按钮挤压", () => {
    const view = render(
      <StudioPage
        title="技能"
        description="管理可复用的工作能力"
        actions={<button type="button">新建技能</button>}
      >
        <p>内容</p>
      </StudioPage>,
    );

    const header = screen.getByRole("banner");
    expect(header.className).toContain("flex-col");
    expect(header.className).toContain("sm:flex-row");
    expect(view.container.querySelector('[data-slot="studio-page-actions"]')).toBeTruthy();
  });
});
