import { describe, expect, it } from "vitest";
import { AuthUser } from "@/lib/auth";
import { ApiError } from "@/server/http/api";
import {
  assertAdmin,
  assertLeadReadable,
  assertLeadWritable,
  isAdmin,
  leadReadScope,
  leadWriteScope,
} from "@/server/permissions";

const salesA: AuthUser = { id: "user-a", username: "a", name: "销售A", role: "sales" };
const salesB: AuthUser = { id: "user-b", username: "b", name: "销售B", role: "sales" };
const admin: AuthUser = { id: "user-admin", username: "admin", name: "管理员", role: "admin" };

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.status;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("permissions 数据范围（§8.2 防线 2）", () => {
  it("销售范围固定为本人；管理员无归属约束（全量）", () => {
    expect(leadReadScope(salesA)).toEqual({ ownerId: "user-a" });
    expect(leadWriteScope(salesB)).toEqual({ ownerId: "user-b" });
    expect(leadReadScope(admin)).toEqual({});
    expect(leadWriteScope(admin)).toEqual({});
  });

  it("销售 A 读销售 B 的线索 → 404（不暴露资源存在性，§8.2 固定用例）", () => {
    expect(statusOf(() => assertLeadReadable(salesA, salesB.id))).toBe(404);
  });

  it("销售 A 写销售 B 的线索 → 404", () => {
    expect(statusOf(() => assertLeadWritable(salesA, salesB.id))).toBe(404);
  });

  it("本人读写通过；管理员对任意归属读写通过", () => {
    expect(() => assertLeadReadable(salesB, salesB.id)).not.toThrow();
    expect(() => assertLeadWritable(salesB, salesB.id)).not.toThrow();
    expect(() => assertLeadReadable(admin, salesA.id)).not.toThrow();
    expect(() => assertLeadWritable(admin, salesB.id)).not.toThrow();
  });

  it("管理员配置权与销售隔离（配置权/查看权分开校验）", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(salesA)).toBe(false);
    expect(statusOf(() => assertAdmin(salesA))).toBe(403);
    expect(() => assertAdmin(admin)).not.toThrow();
  });
});
