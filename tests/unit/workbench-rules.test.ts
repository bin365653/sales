import { describe, expect, it } from "vitest";
import {
  isWorkbenchTab,
  profileGapReason,
  recommendedTalkTrack,
  WORKBENCH_TABS,
  WORKBENCH_TAB_DEFAULT,
} from "@/lib/workbench";

// 首页经营视图规则文案（V2.0-T09，PRD 模块七 / UIUX §5.6）：
// 推荐沟通内容 = 到期语境 × 象限建议 的确定性模板；Tab 键封闭集合。

const NOW = new Date("2026-11-15T04:00:00.000Z");

describe("recommendedTalkTrack（推荐沟通内容）", () => {
  it("到期未知 → 画像补全优先（不套象限话术）", () => {
    expect(recommendedTalkTrack({ quadrant: "a", expiryWindow: "unknown" })).toContain(
      "核实当前使用系统与软件到期时间",
    );
  });

  it("已过期 → 核实续费状态（续费/换系统/停用）", () => {
    expect(recommendedTalkTrack({ quadrant: null, expiryWindow: "expired" })).toContain(
      "核实续费状态",
    );
  });

  it("半年内 → 续费意向 + 象限建议叠加", () => {
    const text = recommendedTalkTrack({ quadrant: "c", expiryWindow: "within_6m" });
    expect(text).toContain("核实续费意向");
    expect(text).toContain("演示");
  });

  it("超半年/买断 → 纯象限建议", () => {
    expect(recommendedTalkTrack({ quadrant: "d", expiryWindow: "beyond_6m" })).toContain(
      "长期培育",
    );
  });

  it("象限未定 + 已知到期 → 引导补全画像", () => {
    const text = recommendedTalkTrack({ quadrant: null, expiryWindow: "within_6m" });
    expect(text).toContain("核实续费意向");
    expect(text).toContain("补全核心画像");
  });
});

describe("profileGapReason（画像待完善原因）", () => {
  it("缺失核心字段逐项列出", () => {
    expect(profileGapReason(["当前使用软件", "软件到期时间"])).toBe(
      "核心画像未全部核实：缺 当前使用软件、软件到期时间",
    );
  });

  it("无缺失给补充建议文案", () => {
    expect(profileGapReason([])).toContain("辅助信息");
  });
});

describe("Workbench Tab 键", () => {
  it("五个 Tab 封闭集合，默认今日优先", () => {
    expect(WORKBENCH_TABS.map((tab) => tab.key)).toEqual([
      "today",
      "monthly",
      "gap",
      "focus",
      "nurture",
    ]);
    expect(WORKBENCH_TAB_DEFAULT).toBe("today");
    expect(isWorkbenchTab("focus")).toBe(true);
    expect(isWorkbenchTab("unknown-tab")).toBe(false);
  });
});

// NOW 仅用于保持与其它规则测试同一时间口径（本模块文案不含时间运算）
void NOW;
