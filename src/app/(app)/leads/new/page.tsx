import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { listFieldDefs } from "@/server/services/lead-fields";
import { listStages, getStageBySemanticKey } from "@/server/services/stages";
import { NEW_LEAD_STAGE_ANCHOR } from "@/lib/stages";
import { LeadForm } from "@/components/leads/lead-form";
import type { FieldDefRow } from "@/lib/lead-form-fields";

export const dynamic = "force-dynamic";

// 新建客户（P3 入口，T04）：表单与编辑共用 LeadForm；
// 校验前后端共用同一份 Schema 与自定义字段引擎。

export default async function NewLeadPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const [defs, stages, defaultStage] = await Promise.all([
    listFieldDefs({ activeOnly: true }),
    listStages({ activeOnly: true }),
    getStageBySemanticKey(NEW_LEAD_STAGE_ANCHOR),
  ]);
  const fieldDefs: FieldDefRow[] = defs.map((def) => ({
    key: def.key,
    label: def.label,
    isActive: def.isActive,
    isBuiltin: def.isBuiltin,
    type: def.type,
    options: def.options,
    validation: def.validation,
  }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">新建客户</h1>
        <Link href="/leads" className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回线索池
        </Link>
      </div>
      <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
        除客户名称外全部字段可留空——不逼销售编数据（PRD §5.3）；四个关键事实字段可标记
        未知 / 待核实 / 已确认。
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
        <LeadForm
          mode="create"
          defs={fieldDefs}
          stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
          defaultStageId={
            defaultStage?.isActive ? defaultStage.id : stages[0]?.id
          }
        />
      </div>
    </div>
  );
}
