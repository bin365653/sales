import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sanitizeNextPath } from "@/lib/auth-guard";
import { getCurrentUser } from "@/server/auth/current-user";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录" };
export const dynamic = "force-dynamic";

// P1 登录页（PRD §5.1）。已登录用户访问时直接进入工作台。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }
  const next = sanitizeNextPath((await searchParams).next) ?? "/";
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">勤策 AI 销售作战台</h1>
          <p className="mt-1 text-sm text-gray-500">请使用管理员分配的账号登录</p>
        </div>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
