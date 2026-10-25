-- T07 任务管理（实施计划 §4.2 tasks / PRD §5.7）
-- 7 种任务类型枚举；完成必须留 completed_at；任务只可取消不可删（C11）。
-- assignee_id = 创建时线索负责人快照；可见性经线索归属判定（§4.4）。

-- CreateEnum
CREATE TYPE "task_type" AS ENUM ('first_contact', 'follow_up', 'needs_diag', 'online_demo', 'offline_visit', 'quote_follow', 'revive');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('pending', 'done', 'canceled');

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "type" "task_type" NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'pending',
    "remark" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "interaction_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_due_at_idx" ON "tasks"("assignee_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_lead_id_status_due_at_idx" ON "tasks"("lead_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_interaction_id_key" ON "tasks"("interaction_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
