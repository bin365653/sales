import { cookies } from "next/headers";
import { AuthUser, SESSION_COOKIE } from "@/lib/auth";
import { resolveSession } from "@/server/auth/session";

// 服务端组件专用：从请求 Cookie 解析当前用户（仅在 RSC/Route 环境可调用）。

export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}
