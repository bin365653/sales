import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { listExperiments } from "@/server/services/experiments";
import { listStages } from "@/server/services/stages";
import { listActiveUsers } from "@/server/services/users";
import { ExperimentsClient } from "@/components/experiments/experiments-client";

export const dynamic = "force-dynamic";

// P8 实验管理（T14，PRD §5.10 / UIUX P8）：管理员圈选线索、随机分组、
// 对比 AI 效果（M3、C04）。列表/详情对销售只读（权限矩阵）——
// 创建/执行分组/关闭仅管理员（服务端 assertAdmin 兜底）。

export default async function ExperimentsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const isAdmin = user.role === "admin";
  const [experiments, stages, owners] = await Promise.all([
    listExperiments(),
    listStages({ activeOnly: true }),
    isAdmin ? listActiveUsers() : Promise.resolve([]),
  ]);

  return (
    <ExperimentsClient
      initialExperiments={experiments}
      stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
      owners={owners.map((owner) => ({ id: owner.id, name: owner.name }))}
      isAdmin={isAdmin}
    />
  );
}
