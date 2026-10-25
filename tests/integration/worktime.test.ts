import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser } from "./helpers";
import {
  getWorktimeEntry,
  getWorktimeWeek,
  upsertWorktime,
} from "@/server/services/worktime";

// T11 工时填报验收项（实施计划 §9 T11 / K5 / C03）：
// - 每人每日一条：重复提交覆盖不报错（upsert 原子覆盖，行数恒 1，约束兜底并发）；
// - 未填报日期：查询返回 hours=null（看板「每小时有效沟通」显示"—"而非 0 的数据前提）；
// - work_date 纯日期按 UTC 日期存储（同 contract_expiry 口径，C13 上海日历日）；
// - 周历视图：周一为起点 7 天，跨月/跨年正确；
// - 个人数据隔离：他人（含管理员）不可见，也无跨人读写。

afterAll(cleanupTestUsers);

describe("每日工时 upsert（重复提交覆盖不报错）", () => {
  it("首次提交创建，同日再次提交覆盖且仍只有一行", async () => {
    const user = await createTestUser("sales");
    const first = await upsertWorktime(user, "2026-10-26", 7.5);
    expect(first).toEqual({ date: "2026-10-26", hours: 7.5 });

    const second = await upsertWorktime(user, "2026-10-26", 8);
    expect(second.hours).toBe(8);

    const rows = await prisma.workTimeEntry.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hours.toNumber()).toBe(8);
  });

  it("hours=0（当天未工作）与 24 边界合法，与'未填报'（null）区分", async () => {
    const user = await createTestUser("sales");
    await upsertWorktime(user, "2026-10-26", 0);
    await upsertWorktime(user, "2026-10-27", 24);

    expect((await getWorktimeEntry(user, "2026-10-26")).hours).toBe(0);
    expect((await getWorktimeEntry(user, "2026-10-27")).hours).toBe(24);

    // 未填报：不报错、返回 null（看板显示"—"，C03）
    expect(await getWorktimeEntry(user, "2026-10-28")).toEqual({
      date: "2026-10-28",
      hours: null,
    });
  });

  it("work_date 纯日期按 UTC 日期存储（同 contract_expiry 口径）", async () => {
    const user = await createTestUser("sales");
    await upsertWorktime(user, "2026-10-26", 6);
    const row = await prisma.workTimeEntry.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.workDate.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("周历视图（周一为起点，C13）", () => {
  it("返回周一起始的 7 天，未填报天为 null；周内任意一天均可定位", async () => {
    const user = await createTestUser("sales");
    await upsertWorktime(user, "2026-10-26", 7.5);
    await upsertWorktime(user, "2026-11-01", 2);

    // 用周中任意一天（周四）定位该周
    const week = await getWorktimeWeek(user, "2026-10-29");
    expect(week.weekStart).toBe("2026-10-26");
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(week.days[0]!.hours).toBe(7.5);
    expect(week.days[1]!.hours).toBeNull();
    expect(week.days[6]!.hours).toBe(2);
  });

  it("跨年周正确：2027-01-01 所在周从 2026-12-28 开始", async () => {
    const user = await createTestUser("sales");
    await upsertWorktime(user, "2027-01-01", 4);

    const week = await getWorktimeWeek(user, "2026-12-31");
    expect(week.weekStart).toBe("2026-12-28");
    expect(week.days[0]!.date).toBe("2026-12-28");
    expect(week.days[4]!.date).toBe("2027-01-01");
    expect(week.days[4]!.hours).toBe(4);
    expect(week.days[6]!.date).toBe("2027-01-03");
  });

  it("未填报的整周全部为 null，不视为错误", async () => {
    const user = await createTestUser("sales");
    const week = await getWorktimeWeek(user, "2026-10-26");
    expect(week.days).toHaveLength(7);
    expect(week.days.every((day) => day.hours === null)).toBe(true);
  });
});

describe("数据范围（个人数据）", () => {
  it("他人（含管理员）不可见：工时恒按当前登录用户读写", async () => {
    const sales = await createTestUser("sales");
    const admin = await createTestUser("admin");
    await upsertWorktime(sales, "2026-10-26", 6);

    expect((await getWorktimeEntry(admin, "2026-10-26")).hours).toBeNull();
    const adminWeek = await getWorktimeWeek(admin, "2026-10-26");
    expect(adminWeek.days.every((day) => day.hours === null)).toBe(true);

    // 管理员自己的填报是独立行，不与销售互串
    await upsertWorktime(admin, "2026-10-26", 8);
    expect((await getWorktimeEntry(sales, "2026-10-26")).hours).toBe(6);
    expect((await getWorktimeEntry(admin, "2026-10-26")).hours).toBe(8);
  });
});
