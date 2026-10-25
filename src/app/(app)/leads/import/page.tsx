import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { getImportTemplateFields } from "@/server/services/imports";
import { ImportWizard } from "@/components/leads/import-wizard";

export const dynamic = "force-dynamic";

// P4 导入向导（T05）：上传 → 映射 → 预览（有效/错误/重复）→ 逐行决定 → 确认。
// 可映射目标（内置 + 自定义字段）服务端渲染注入；向导交互全部在客户端组件内。

export default async function LeadImportPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const fields = await getImportTemplateFields();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">导入客户</h1>
        <p className="mt-1 text-sm text-gray-500">
          上传表格 → 确认字段映射 → 逐行决定 → 确认入库；确认前不会写入任何客户数据。
        </p>
      </div>
      <ImportWizard
        targets={fields.map((field) => ({ key: field.key, label: field.label }))}
      />
    </div>
  );
}
