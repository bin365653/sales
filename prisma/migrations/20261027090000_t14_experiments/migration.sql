-- T14 实验分组与评估（实施计划 §4.2 experiments / PRD §5.10 / M3、C04）
-- 生命周期 draft → running（执行随机分组）→ closed（禁 AI 规则随关闭解除）。
-- experiment_assignments.lead_id 全局唯一：同一线索不可重复分组（T14 验收项，
-- 跨实验亦不可，避免两组效果互相污染）；lead 外键默认 Restrict（历史留痕，
-- 物理删除线索前必须先删分组明细——软删除为常规路径，不受影响）。

-- CreateEnum
CREATE TYPE "experiment_status" AS ENUM ('draft', 'running', 'closed');

-- CreateEnum
CREATE TYPE "experiment_group" AS ENUM ('control', 'assisted');

-- CreateTable
CREATE TABLE "experiments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "status" "experiment_status" NOT NULL DEFAULT 'draft',
    "source" VARCHAR(64),
    "industry" VARCHAR(64),
    "stage_id" UUID,
    "owner_id" UUID,
    "assisted_ratio" INTEGER NOT NULL DEFAULT 50,
    "min_sample_size" INTEGER NOT NULL DEFAULT 50,
    "assigned_at" TIMESTAMPTZ(6),
    "assigned_by" UUID,
    "assigned_count" INTEGER,
    "closed_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignments" (
    "id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "group" "experiment_group" NOT NULL,
    "rule_snapshot" JSONB,
    "profile_snapshot" JSONB,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "assigned_by" UUID NOT NULL,

    CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "experiments_status_assigned_at_idx" ON "experiments"("status", "assigned_at");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignments_lead_id_key" ON "experiment_assignments"("lead_id");

-- CreateIndex
CREATE INDEX "experiment_assignments_experiment_id_group_idx" ON "experiment_assignments"("experiment_id", "group");

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "lead_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
