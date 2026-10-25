import { describe, expect, it } from "vitest";
import {
  BATCH_UPDATABLE_FIELDS,
  leadBatchUpdateSchema,
} from "@/lib/schemas/lead";

// T04 验收项「批量仅限允许字段」的 Schema 层固化：
// strictObject 保证白名单外字段直接报错，不静默忽略。

const UUID_A = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const UUID_B = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8fa";
const UUID_STAGE = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8fb";

describe("leadBatchUpdateSchema：白名单限定", () => {
  it("白名单字段（priority/stageId/source/nextContactAt）可提交", () => {
    const parsed = leadBatchUpdateSchema.parse({
      ids: [UUID_A, UUID_B],
      changes: {
        priority: "high",
        stageId: UUID_STAGE,
        source: "展会",
        nextContactAt: "2026-10-26 09:30",
      },
    });
    expect(parsed.ids).toHaveLength(2);
    expect(parsed.changes.priority).toBe("high");
  });

  it.each([
    ["name", "某客户"],
    ["city", "武汉"],
    ["contactPhone", "13900000000"],
    ["customValues", { x: 1 }],
  ])("白名单外字段 changes.%s 被拒绝（不静默忽略）", (field, value) => {
    const result = leadBatchUpdateSchema.safeParse({
      ids: [UUID_A],
      changes: { priority: "low", [field]: value },
    });
    expect(result.success).toBe(false);
  });

  it("changes 为空（未提供任何字段）被拒绝", () => {
    const result = leadBatchUpdateSchema.safeParse({
      ids: [UUID_A],
      changes: {},
    });
    expect(result.success).toBe(false);
  });

  it("source 空串归一化为 null（清空语义）；priority 非法值拒绝", () => {
    const cleared = leadBatchUpdateSchema.parse({
      ids: [UUID_A],
      changes: { source: "" },
    });
    expect(cleared.changes.source).toBeNull();

    const badPriority = leadBatchUpdateSchema.safeParse({
      ids: [UUID_A],
      changes: { priority: "urgent" },
    });
    expect(badPriority.success).toBe(false);
  });

  it("ids：空数组 / 重复 / 非 UUID / 超过 100 条均拒绝", () => {
    expect(
      leadBatchUpdateSchema.safeParse({ ids: [], changes: { priority: "high" } })
        .success,
    ).toBe(false);
    expect(
      leadBatchUpdateSchema.safeParse({
        ids: [UUID_A, UUID_A],
        changes: { priority: "high" },
      }).success,
    ).toBe(false);
    expect(
      leadBatchUpdateSchema.safeParse({
        ids: ["not-a-uuid"],
        changes: { priority: "high" },
      }).success,
    ).toBe(false);
    expect(
      leadBatchUpdateSchema.safeParse({
        ids: Array.from({ length: 101 }, (_, i) =>
          `0a1b2c3d-4e5f-6071-8293-a4b5c6d7e${String(i).padStart(4, "0")}`,
        ),
        changes: { priority: "high" },
      }).success,
    ).toBe(false);
  });

  it("BATCH_UPDATABLE_FIELDS 恰为四个管理性字段（防误扩）", () => {
    expect([...BATCH_UPDATABLE_FIELDS]).toEqual([
      "priority",
      "stageId",
      "source",
      "nextContactAt",
    ]);
  });
});
