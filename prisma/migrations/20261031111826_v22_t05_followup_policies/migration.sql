-- CreateEnum
CREATE TYPE "task_source" AS ENUM ('manual', 'expiry_monthly', 'profile_gap', 'quadrant_periodic');

-- CreateEnum
CREATE TYPE "cycle_status" AS ENUM ('planned', 'task_created', 'done', 'canceled', 'superseded');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "auto_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cycle_id" UUID,
ADD COLUMN     "original_due_at" TIMESTAMPTZ(6),
ADD COLUMN     "policy_id" UUID,
ADD COLUMN     "priority" INTEGER,
ADD COLUMN     "source_type" "task_source" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "follow_up_policies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "quadrant_code" "lead_quadrant",
    "expiry_condition" VARCHAR(32) NOT NULL DEFAULT 'beyond_6m',
    "interval_days" INTEGER NOT NULL,
    "task_type" "task_type" NOT NULL DEFAULT 'follow_up',
    "advance_days" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "effective_at" TIMESTAMPTZ(6),
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_cycles" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "cycle_key" VARCHAR(16) NOT NULL,
    "planned_date" DATE NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task_id" UUID,
    "status" "cycle_status" NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_policies_quadrant_code_key" ON "follow_up_policies"("quadrant_code");

-- CreateIndex
CREATE INDEX "follow_up_cycles_status_planned_date_idx" ON "follow_up_cycles"("status", "planned_date");

-- CreateIndex
CREATE INDEX "follow_up_cycles_lead_id_idx" ON "follow_up_cycles"("lead_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "follow_up_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "follow_up_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_cycles" ADD CONSTRAINT "follow_up_cycles_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_cycles" ADD CONSTRAINT "follow_up_cycles_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "follow_up_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 防重部分唯一索引（实施计划 §3.2 / §4.5 防重 R5）：同客户同类自动任务至多一条
-- pending；完成/取消后索引释放、下一周期可再生成。数据库层兜底并发双事务。
CREATE UNIQUE INDEX "tasks_expiry_monthly_unique" ON "tasks"("lead_id") WHERE "source_type" = 'expiry_monthly' AND "status" = 'pending';

CREATE UNIQUE INDEX "tasks_quadrant_periodic_unique" ON "tasks"("lead_id") WHERE "source_type" = 'quadrant_periodic' AND "status" = 'pending';

CREATE UNIQUE INDEX "tasks_profile_gap_unique" ON "tasks"("lead_id") WHERE "source_type" = 'profile_gap' AND "status" = 'pending';

-- 周期台账有效行唯一（§4.5 防重 #2：同客户同策略同周期仅一条「有效」行，
-- 有效 = planned/task_created；完成或取消后索引释放，同月重算可再生成——
-- 因此用部分唯一索引替代全表 unique，历史行保留不占坑）
CREATE UNIQUE INDEX "uq_follow_up_cycles_active" ON "follow_up_cycles"("lead_id", "policy_id", "cycle_key") WHERE "status" IN ('planned', 'task_created');

-- 存量任务优先级回填（§4.4：手工任务按类型映射——客户约定=1、预约演示/拜访=2；
-- 自动任务由生成器写入 3/4/5）
UPDATE "tasks" SET "priority" = CASE WHEN "type" IN ('online_demo', 'offline_visit') THEN 2 ELSE 1 END WHERE "priority" IS NULL;
