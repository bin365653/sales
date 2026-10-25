-- T10 AI 摘要草稿（实施计划 §9 T10 / §7.1 摘要审核流）：
-- interactions.ai_run_id 记录"该记录确认自哪个 AI 草稿 run"。
-- 逻辑引用（同 audit_logs，不加外键约束）：AI 原始输出只存 ai_runs.output（K3），
-- 沟通记录保存始终由用户确认触发；本列使原始输出与最终记录可区分、可追溯。
ALTER TABLE "interactions" ADD COLUMN "ai_run_id" UUID;
