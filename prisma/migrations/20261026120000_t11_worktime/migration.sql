-- T11 工时填报（实施计划 §4.2 work_time_entries / K5 / C03）
-- 每人每日一条（unique(user_id, work_date)）；hours 0–24、0.5 步进（UIUX §4.9）。
-- work_date 纯日期列按 UTC 日期存储（同 leads.contract_expiry 口径，C13）。
-- user_id 外键级联删除（同 sessions）。

-- CreateTable
CREATE TABLE "work_time_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "hours" DECIMAL(4,1) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_time_entries_user_id_work_date_key" ON "work_time_entries"("user_id", "work_date");

-- CreateIndex
CREATE INDEX "work_time_entries_work_date_idx" ON "work_time_entries"("work_date");

-- AddForeignKey
ALTER TABLE "work_time_entries" ADD CONSTRAINT "work_time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
