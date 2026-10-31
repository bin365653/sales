import { describe, expect, it } from "vitest";
import { ApiError } from "@/server/http/api";
import {
  collectExplicitStatuses,
  computeVerificationWrites,
  MASKED_EVENT_VALUE,
  resolveExistingStatus,
  serializeLeadValue,
} from "@/server/services/lead-verifications";
import { PROFILE_CORE_FIELDS, VERIFIABLE_FIELD_KEYS } from "@/lib/lead-fields";

// V2.0-T01 核实写入计算（纯逻辑单测）：
// - 显式状态恒优先；值变化自动置 unverified（P2 缺陷修复）；清空 → unknown；
// - 旧状态列镜像（V1.0 读取点不漂移）；
// - changed 明细含 from/to/statusFrom/statusTo；联系方式脱敏；
// - 白名单外字段不产生核实写入。

const NOW = new Date("2026-10-31T08:00:00.000Z");
const ACTOR = "11111111-1111-4111-8111-111111111111";

function compute(
  overrides: Partial<Parameters<typeof computeVerificationWrites>[0]> = {},
) {
  return computeVerificationWrites({
    mode: "update",
    submittedValues: {},
    explicitStatuses: {},
    source: "manual",
    actorId: ACTOR,
    now: NOW,
    ...overrides,
  });
}

describe("create 模式", () => {
  it("值非空且无显式状态 → unverified，旧列镜像同步", () => {
    const result = compute({
      mode: "create",
      submittedValues: { currentSystem: "舟谱", industry: "快消" },
    });
    const currentSystem = result.writes.find((w) => w.fieldKey === "current_system");
    const industry = result.writes.find((w) => w.fieldKey === "industry");
    expect(currentSystem).toMatchObject({
      status: "unverified",
      source: "manual",
      verifiedBy: ACTOR,
      verifiedAt: NOW,
    });
    expect(industry).toMatchObject({ status: "unverified" });
    // 非核实字段（industry 是核实字段，这里验证镜像仅对旧四列生效）
    expect(result.legacyMirrors).toEqual({ currentSystemStatus: "unverified" });
  });

  it("显式状态优先于自动 unverified；清空值不产生写入", () => {
    const withExplicit = compute({
      mode: "create",
      submittedValues: { currentSystem: "舟谱" },
      explicitStatuses: { current_system: "stated" },
    });
    expect(withExplicit.writes).toHaveLength(1);
    expect(withExplicit.writes[0]).toMatchObject({ status: "stated" });
    expect(withExplicit.legacyMirrors).toEqual({ currentSystemStatus: "stated" });

    const empty = compute({ mode: "create", submittedValues: { city: null } });
    expect(empty.writes).toHaveLength(0);
    expect(empty.changed).toEqual({});
  });
});

describe("update 模式", () => {
  const existing = {
    id: "lead-1",
    currentSystem: "管家婆",
    currentSystemStatus: "confirmed",
    industry: "快消",
    contactPhone: "13800001111",
    city: "合肥",
  };
  const existingRows = [{ fieldKey: "current_system", status: "confirmed" as const }];

  it("改值且无显式状态 → unverified + 核实人/时间刷新 + 旧列镜像", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: { currentSystem: "舟谱" },
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatchObject({
      fieldKey: "current_system",
      status: "unverified",
      verifiedBy: ACTOR,
      verifiedAt: NOW,
    });
    expect(result.legacyMirrors).toEqual({ currentSystemStatus: "unverified" });
    expect(result.changed.current_system).toEqual({
      from: "管家婆",
      to: "舟谱",
      statusFrom: "confirmed",
      statusTo: "unverified",
    });
  });

  it("显式状态与现状相同但值已变 → 仍写入（刷新核实元数据，状态不降级）", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: { currentSystem: "舟谱" },
      explicitStatuses: { current_system: "confirmed" },
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatchObject({ status: "confirmed" });
    expect(result.legacyMirrors).toEqual({ currentSystemStatus: "confirmed" });
  });

  it("值未变且显式状态与现状相同 → 不产生写入（表单重复提交不刷时间）", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: { currentSystem: "管家婆" },
      explicitStatuses: { current_system: "confirmed" },
    });
    expect(result.writes).toHaveLength(0);
    expect(result.changed).toEqual({});
  });

  it("仅显式状态变化（值未触及）→ 状态写入，changed 的 from/to 为现值", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: {},
      explicitStatuses: { industry: "stated" },
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatchObject({
      fieldKey: "industry",
      status: "stated",
    });
    expect(result.changed.industry).toEqual({
      from: "快消",
      to: "快消",
      statusFrom: "unknown",
      statusTo: "stated",
    });
  });

  it("清空值 → unknown（镜像旧列）；本来就 unknown 时不重复写", () => {
    const cleared = compute({
      existing,
      existingRows,
      submittedValues: { currentSystem: null },
    });
    expect(cleared.writes[0]).toMatchObject({ status: "unknown" });
    expect(cleared.legacyMirrors).toEqual({ currentSystemStatus: "unknown" });
    expect(cleared.changed.current_system).toMatchObject({
      from: "管家婆",
      to: null,
      statusTo: "unknown",
    });

    const clearedUnknown = compute({
      existing: { ...existing, industry: null },
      existingRows,
      submittedValues: { industry: null },
    });
    expect(clearedUnknown.writes).toHaveLength(0);
  });

  it("联系方式变更：changed 只记「已变更」不落明文", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: { contactPhone: "13911112222" },
    });
    expect(result.writes).toHaveLength(0); // 联系方式不在核实白名单
    expect(result.changed.contact_phone).toEqual({
      from: MASKED_EVENT_VALUE,
      to: MASKED_EVENT_VALUE,
    });
    expect(JSON.stringify(result.changed)).not.toContain("13911112222");
  });

  it("非核实字段（城市）变更进 changed 且无状态字段；未变更字段不出现", () => {
    const result = compute({
      existing,
      existingRows,
      submittedValues: { city: "南昌", remark: null },
    });
    expect(result.changed.city).toEqual({ from: "合肥", to: "南昌" });
    expect(result.changed.remark).toBeUndefined();
    expect(Object.keys(result.changed)).toEqual(["city"]);
  });
});

describe("输入归并与白名单", () => {
  it("collectExplicitStatuses：verifications map 优先于旧状态键别名", () => {
    const merged = collectExplicitStatuses({
      verifications: { current_system: "stated" },
      currentSystemStatus: "confirmed",
    });
    expect(merged.current_system).toBe("stated");

    const aliasOnly = collectExplicitStatuses({
      currentSystemStatus: "confirmed",
      contractExpiryStatus: "unverified",
    });
    expect(aliasOnly).toEqual({
      current_system: "confirmed",
      contract_expiry: "unverified",
    });
  });

  it("collectExplicitStatuses：白名单外键 400", () => {
    expect(() =>
      collectExplicitStatuses({ verifications: { contact_phone: "confirmed" } }),
    ).toThrow(ApiError);
  });

  it("resolveExistingStatus：行优先，旧列兜底，缺省 unknown", () => {
    expect(
      resolveExistingStatus(
        [{ fieldKey: "current_system", status: "stated" }],
        "current_system",
        { currentSystemStatus: "confirmed" },
      ),
    ).toBe("stated");
    expect(
      resolveExistingStatus([], "current_system", { currentSystemStatus: "confirmed" }),
    ).toBe("confirmed");
    expect(resolveExistingStatus([], "industry", {})).toBe("unknown");
  });

  it("serializeLeadValue：日期列 → YYYY-MM-DD；空值归 null", () => {
    expect(serializeLeadValue(new Date("2027-03-31T00:00:00.000Z"))).toBe("2027-03-31");
    expect(serializeLeadValue("")).toBeNull();
    expect(serializeLeadValue(null)).toBeNull();
    expect(serializeLeadValue(true)).toBe(true);
    expect(serializeLeadValue(12)).toBe(12);
  });
});

describe("白名单与核心字段常量", () => {
  it("核心 7 字段全部在白名单内（P5 前提）", () => {
    for (const key of PROFILE_CORE_FIELDS) {
      expect(VERIFIABLE_FIELD_KEYS.has(key)).toBe(true);
    }
    // 白名单覆盖旧四事实列
    for (const key of [
      "current_system",
      "contract_expiry",
      "purchase_time",
      "decision_maker",
    ]) {
      expect(VERIFIABLE_FIELD_KEYS.has(key)).toBe(true);
    }
  });
});
