import { expect, test } from "@playwright/test";

// V2.0 迭代二闭环 E2E（V2-T08，实施计划 §8：E2E 扩展）：
// 新建客户（建档）→ 沟通「本次确认」补画像/到期 → 分类卡出现象限徽章
// → 任务中心出现月度任务（来源徽章+原因行）→ 编辑到期离开半年窗口
// → 旧月度任务取消（跟进计划已重算留痕）→ 新建约定任务并完成（沟通确认
// 意愿翻转 → 分类变化 C→B）。
// 运行环境与 core-loop 相同：独立库 qince_e2e 每次重建 + 生产构建；
// 选择器全部可访问性语义（label/role/text），与界面文案同源。

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-2026";
const LEAD_NAME = "E2E V2 到期闭环客户";
const MANUAL_TASK_TITLE = "E2E V2 客户约定回访";

function shanghaiMonth(offsetMonths: number): string {
  const now = new Date();
  const total = now.getFullYear() * 12 + now.getMonth() + offsetMonths;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

test("V2 闭环：建档→确认象限→月度任务→重算→约定任务完成→分类变化", async ({ page }) => {
  test.setTimeout(300_000);

  // ---------- ① 登录 → 新建客户（只填名称，空值不强迫） ----------
  await page.goto("/leads/new");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: /新建客户/ })).toBeVisible();
  await page.getByLabel("客户名称").fill(LEAD_NAME);
  await page.getByRole("button", { name: "创建客户" }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: LEAD_NAME })).toBeVisible();

  // 建档即分类：全空画像 → 「画像待完善」（未知≠否）
  await expect(page.getByText("画像待完善").first()).toBeVisible();

  // ---------- ② 记录沟通：本次确认 新一代=否 + 愿意=是 + 到期年月（下月） ----------
  await page.getByRole("button", { name: "记录沟通" }).click();
  await page.getByRole("checkbox", { name: "已接通" }).check();
  await page.getByRole("checkbox", { name: "有效沟通" }).check();
  await page.locator("#i-feedback").fill("客户自述未用新一代系统，愿意了解勤策；软件下月到期。");
  await page.getByRole("checkbox", { name: "是否新一代手机开单" }).check();
  await page.getByLabel("确认是否新一代手机开单").selectOption("false");
  await page.getByRole("checkbox", { name: "愿意沟通了解勤策" }).check();
  await page.getByLabel("确认沟通意愿").selectOption("true");
  await page.getByRole("checkbox", { name: "软件到期年月" }).check();
  await page.getByLabel("确认软件到期年月").fill(shanghaiMonth(1));
  await page.getByRole("button", { name: "保存沟通记录" }).click();
  await expect(page.getByText("沟通记录已保存")).toBeVisible({ timeout: 15_000 });

  // 分类卡：C·第三象限（未用新一代+有意愿）
  await expect(page.getByText("C·第三象限").first()).toBeVisible({ timeout: 15_000 });

  // ---------- ③ 任务中心：月度任务出现（来源徽章 + 原因行） ----------
  await page.goto("/tasks?view=all&sourceType=expiry_monthly");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  // 月度任务标题用当前月（本月该跟的那一通），客户到期是下月
  const monthlyTitle = `软件到期月度跟进（${shanghaiMonth(0)}）`;
  await expect(page.getByText(monthlyTitle).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("到期月度").first()).toBeVisible();
  await expect(page.getByText(/原因：软件 .+ 到期，处于半年内窗口/).first()).toBeVisible();

  // ---------- ④ 重算：编辑到期到 12 个月后（离开半年窗口） ----------
  await page.goto("/leads");
  await page.getByRole("link", { name: LEAD_NAME }).first().click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "编辑资料" }).click();
  await page.getByLabel("软件到期时间").fill(`${shanghaiMonth(12)}-01`);
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("资料已保存").first()).toBeVisible({ timeout: 15_000 });

  // 旧月度任务被取消（历史只读可见），时间线出现「跟进计划已重算」
  await page.goto("/tasks?view=all&sourceType=expiry_monthly");
  await expect(page.getByText("该任务已取消").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "完成任务" })).toHaveCount(0);
  await page.goto("/leads");
  await page.getByRole("link", { name: LEAD_NAME }).first().click();
  await expect(page.getByText("跟进计划已重算").first()).toBeVisible();
  await expect(page.getByText(/原因：软件到期时间更新/).first()).toBeVisible();

  // ---------- ⑤ 新建客户约定任务 → 完成弹窗（单事务：done + 沟通记录） ----------
  await page.goto("/tasks?view=all&sourceType=all");
  await page.getByRole("button", { name: "＋ 新建任务" }).click();
  await page.locator("#nt-lead").fill(LEAD_NAME);
  await page.getByRole("button", { name: LEAD_NAME }).first().click();
  await page.locator("#nt-title").fill(MANUAL_TASK_TITLE);
  const in3days = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await page.locator("#nt-due").fill(
    `${in3days.getFullYear()}-${pad(in3days.getMonth() + 1)}-${pad(in3days.getDate())}T10:00`,
  );
  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByText("任务已创建")).toBeVisible({ timeout: 15_000 });

  // 手工任务显示「客户约定」小签（priority 1，恒排前不显示来源徽章）
  const manualCard = page.locator("li", { has: page.getByText(MANUAL_TASK_TITLE) }).first();
  await expect(manualCard.getByText("📌 客户约定")).toBeVisible();

  await page.getByRole("button", { name: "完成任务" }).first().click();
  await page.locator("textarea[id^='c-feedback-']").fill("回访完成：客户要求下月再联系。");
  await page.getByRole("button", { name: "保存并完成" }).click();
  await expect(page.getByText("任务已完成").first()).toBeVisible();
  await expect(page.getByText(/完成于/).first()).toBeVisible();

  // ---------- ⑥ 沟通确认意愿翻转 → 分类变化 C→D（时间线可见，历史只追加） ----------
  // 未用新一代(false) + 无意愿(false) = D·第四象限（§4.1 映射）
  await page.goto("/leads");
  await page.getByRole("link", { name: LEAD_NAME }).first().click();
  await page.getByRole("button", { name: "记录沟通" }).click();
  await page.getByRole("checkbox", { name: "已接通" }).check();
  await page.getByRole("checkbox", { name: "有效沟通" }).check();
  await page.getByRole("checkbox", { name: "愿意沟通了解勤策" }).check();
  await page.getByLabel("确认沟通意愿").selectOption("false");
  await page.getByRole("button", { name: "保存沟通记录" }).click();
  await expect(page.getByText("沟通记录已保存").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("D·第四象限").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("分类变化").first()).toBeVisible();
  await expect(page.getByText(/C·第三象限 → D·第四象限/).first()).toBeVisible();

  // ---------- ⑦ AI 跟进策略助手（V2.0-T11 第三入口）：原因解释 + 沟通建议 ----------
  await page.getByRole("button", { name: "✦ AI 跟进策略助手" }).click();
  await expect(page.getByText("为什么现在联系这位客户").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("E2E Mock").first()).toBeVisible();
  await expect(page.getByText(/AI 建议不会自动修改客户画像、分类、到期时间或销售阶段/).first()).toBeVisible();
});
