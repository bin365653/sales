import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

// P2 工作台首页（T02 骨架）：数量卡、最近沟通与"建议优先联系"由 T12 交付；
// 此处提供线索池入口并展示交付路线。

export default async function WorkbenchPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const roadmap = [
    { label: "T03", text: "线索模型与配置（已交付）" },
    { label: "T04", text: "线索池与客户详情（已交付）" },
    { label: "T05–T07", text: "导入导出、沟通记录、任务管理" },
    { label: "T08–T10", text: "AI 客户分析、电话准备卡、沟通摘要草稿" },
    { label: "T11–T18", text: "工时、指标看板、实验、设置、加固与交付" },
  ];

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">你好，{user.name}</h1>
      <p className="mt-2 text-sm text-gray-500">
        登录、数据范围与线索管理已就绪。工作台数量卡随 T12 交付。
      </p>
      <Link
        href="/leads"
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
      >
        进入线索池 →
      </Link>
      <ul className="mt-6 flex flex-col gap-3">
        {roadmap.map((item) => (
          <li
            key={item.label}
            className="rounded-lg border border-gray-200 bg-white p-4"
          >
            <span className="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700">
              {item.label}
            </span>
            <span className="text-sm text-gray-600">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
