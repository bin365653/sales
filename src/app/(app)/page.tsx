import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

// P2 工作台首页占位（T02）：数量卡、最近沟通与"建议优先联系"由 T12 交付；
// 此处仅确认受保护路由可达并展示当前用户。

export default async function WorkbenchPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const roadmap = [
    { label: "T03–T07", text: "线索模型、线索池、导入导出、沟通记录、任务管理" },
    { label: "T08–T10", text: "AI 客户分析、电话准备卡、沟通摘要草稿" },
    { label: "T11–T14", text: "工时填报、指标引擎与看板、实验分组" },
    { label: "T15–T18", text: "设置中心、安全加固、备份恢复、端到端验收" },
  ];

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">你好，{user.name}</h1>
      <p className="mt-2 text-sm text-gray-500">
        登录与会话已就绪（T02 交付：登录/登出/会话、角色、数据范围、登录限流）。
        业务模块按《V1.0 工程实施计划》逐步交付：
      </p>
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
