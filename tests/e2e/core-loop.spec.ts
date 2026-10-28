import { expect, test } from "@playwright/test";

// 核心闭环 E2E（T18，实施计划 §9 T18 / PRD §11 第一闭环）：
// 登录 → 导入（两阶段向导）→ 详情 → AI（分析 + 电话准备卡，本地 Mock Provider）
// → 沟通记录（AI 摘要草稿确认 + K4 阶段推进 + 同建任务）→ 任务（完成弹窗事务）
// → 看板（漏斗/口径/AI 用量）→ 退出登录。
// 运行环境：类生产——独立数据库每次重建 + 生产构建 next start（见 playwright.config.ts）。
// 选择器全部使用可访问性语义（label/role/text），与界面文案同源，改文案即需同步。

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-2026";

const VALID_LEAD = "E2E 徽智机械";
const SECOND_LEAD = "E2E 蓝湾食品";
const RAW_FEEDBACK =
  "客户原话：我们现在用 Excel 记录客户资料，两个人跟进经常撞单，想在本季度内换掉。";
const TASK_TITLE = "E2E 演练任务-发送报价";
const NEXT_TASK_TITLE = "E2E 下一步-跟进折扣审批";

test("核心闭环：登录→导入→详情→AI→记录→任务→看板", async ({ page }) => {
  test.setTimeout(300_000);

  // ---------- ① 登录（未登录访问受保护页先重定向登录页） ----------
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();

  // ---------- ② 导入（上传 → 自动映射 → 预览 → 确认 → 结果汇总） ----------
  await page.goto("/leads");
  await page.getByRole("link", { name: "导入客户" }).click();
  await expect(page).toHaveURL(/\/leads\/import/);
  await page.setInputFiles(
    'input[aria-label="选择要导入的文件"]',
    "tests/e2e/fixtures/t18-import.csv",
  );
  await expect(page.getByText("文件解析完成，请确认字段映射")).toBeVisible();
  await page.getByRole("button", { name: "保存映射并更新预览" }).click();
  await expect(page.getByRole("button", { name: /全部 3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /有效 2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /错误 1/ })).toBeVisible();
  await expect(page.getByText("错误行不可导入")).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/共处理 3 行：新建 2 条，跳过 1 条/)).toBeVisible();

  // ---------- ③ 详情（导入结果进入线索池 → 详情页画像与时间线） ----------
  await page.getByRole("link", { name: "前往线索池查看" }).click();
  await expect(page).toHaveURL(/\/leads(\?|$)/);
  await expect(page.getByRole("link", { name: VALID_LEAD })).toBeVisible();
  await expect(page.getByRole("link", { name: SECOND_LEAD })).toBeVisible();
  await page.getByRole("link", { name: VALID_LEAD }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: VALID_LEAD })).toBeVisible();
  await expect(page.getByText("导入时间线", { exact: false }).or(page.getByText("阶段时间线"))).toBeVisible();

  // ---------- ④ AI（客户分析 8 项分区 + 电话准备卡 6 项 + 历史/复制） ----------
  await page.getByRole("button", { name: "✦ AI 客户分析" }).click();
  await expect(page.getByText("已知事实")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("E2E Mock：当前用 Excel 管理客户资料")).toBeVisible();
  await expect(page.getByText("待核实信息")).toBeVisible();
  await expect(page.getByText("经营痛点（含推断依据，最多 3 项）")).toBeVisible();
  await expect(page.getByText("沟通切入点")).toBeVisible();
  await expect(page.getByText("推荐的下一步动作")).toBeVisible();
  await expect(page.getByText("信息不足时需向客户核实的问题")).toBeVisible();

  await page.getByRole("button", { name: "✦ AI 电话准备卡" }).click();
  await expect(page.getByText("本次沟通目标")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("E2E Mock 开场白", { exact: false })).toBeVisible();
  await expect(page.getByText("需求诊断问题（3 个）")).toBeVisible();
  await expect(page.getByText("可能的异议与建议回应（2 个）")).toBeVisible();
  await expect(page.getByText("需要避免的未经核实表述")).toBeVisible();
  await page.getByRole("button", { name: "查看历史" }).click();
  await expect(page.getByText(/AI 历史（2 条）/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制", exact: true }).first()).toBeVisible();

  // ---------- ⑤ 沟通记录（AI 摘要草稿 → 确认保存 → K4 推进 → 同建任务） ----------
  await page.getByRole("button", { name: "记录沟通" }).click();
  await page.locator("#i-feedback").fill(RAW_FEEDBACK);
  await page.getByRole("button", { name: "✦ AI 生成摘要" }).click();
  await expect(page.locator("#i-feedback")).toHaveValue(/E2E Mock 摘要/, {
    timeout: 60_000,
  });
  await expect(page.locator("#i-next-action")).toHaveValue(/发送报价单/);

  await page.getByRole("checkbox", { name: "已接通" }).check();
  await page.getByRole("checkbox", { name: "有效沟通" }).check();
  await page.getByRole("checkbox", { name: "形成合格线索" }).check();
  await expect(page.getByText(/将自动把客户阶段推进至「/)).toBeVisible();
  await page.getByRole("checkbox", { name: "同时创建任务" }).check();
  await page.locator("#i-task-title").fill(TASK_TITLE);
  const dueValue = await page.locator("#i-task-due").inputValue();
  if (!dueValue) {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await page.locator("#i-task-due").fill(
      `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`,
    );
  }
  await page.getByRole("button", { name: "保存沟通记录" }).click();
  await expect(page.getByText("沟通记录已保存")).toBeVisible();
  await expect(page.getByText("✦ AI 草稿确认")).toBeVisible();
  await expect(page.getByText("阶段流转").or(page.getByText(/推进/)).first()).toBeVisible();

  // ---------- ⑥ 任务中心（全部视图 → 完成弹窗：沟通结果 + 下一步任务单事务） ----------
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  // 同建任务截止为明天：切到「全部」视图断言（今日视图只含今日与逾期）
  await page.getByRole("link", { name: "全部", exact: true }).click();
  await expect(page.getByText(TASK_TITLE).first()).toBeVisible();
  await page.getByRole("button", { name: "完成任务" }).first().click();
  await page.locator("textarea[id^='c-feedback-']").fill("报价已发送，客户要求下周给最终折扣。");
  await page.getByRole("radio", { name: "创建下一步任务" }).check();
  await page.locator("input[id^='c-nt-title-']").fill(NEXT_TASK_TITLE);
  const nextDue = await page.locator("input[id^='c-nt-due-']").inputValue().catch(() => "");
  if (!nextDue) {
    const in3days = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await page.locator("input[id^='c-nt-due-']").fill(
      `${in3days.getFullYear()}-${pad(in3days.getMonth() + 1)}-${pad(in3days.getDate())}T10:00`,
    );
  }
  await page.getByRole("button", { name: "保存并完成" }).click();
  await expect(page.getByText("任务已完成").first()).toBeVisible();
  await expect(page.getByText(/完成于/).first()).toBeVisible();
  await expect(page.getByText(NEXT_TASK_TITLE).first()).toBeVisible();

  // ---------- ⑦ 看板（漏斗行序 + 每小时有效沟通 + AI 使用统计） ----------
  await page.goto("/analytics");
  await expect(page.getByText("转化漏斗")).toBeVisible();
  for (const stage of ["呼出", "接通", "有效沟通", "合格线索", "预约演示", "演示完成", "报价", "成交"]) {
    await expect(page.getByText(stage, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("接通率").first()).toBeVisible();
  await expect(page.getByText("有效沟通率").first()).toBeVisible();
  await expect(page.getByText("合格线索率").first()).toBeVisible();
  await expect(page.getByText("预约转化率").first()).toBeVisible();
  await expect(page.getByText("每小时有效沟通").first()).toBeVisible();
  await expect(page.getByText(/AI 使用/).first()).toBeVisible();

  // ---------- ⑧ 退出登录（会话撤销后再进受保护页回到登录页） ----------
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/login/);
});
