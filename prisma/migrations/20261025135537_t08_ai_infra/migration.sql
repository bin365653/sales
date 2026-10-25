-- CreateEnum
CREATE TYPE "ai_run_type" AS ENUM ('analysis', 'call_prep', 'interaction_summary');

-- CreateEnum
CREATE TYPE "ai_run_status" AS ENUM ('pending', 'success', 'failed', 'timeout', 'invalid_output');

-- CreateEnum
CREATE TYPE "ai_error_type" AS ENUM ('timeout', 'auth', 'rate_limit', 'provider', 'invalid_output');

-- CreateTable
CREATE TABLE "model_configs" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "base_url" VARCHAR(255) NOT NULL,
    "model_name" VARCHAR(128) NOT NULL,
    "api_key_cipher" VARCHAR(512) NOT NULL,
    "key_last4" VARCHAR(4) NOT NULL,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "max_retries" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "run_type" "ai_run_type" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "output_schema" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_type" "ai_run_type" NOT NULL,
    "model_config_id" UUID NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "input_data_version" INTEGER NOT NULL,
    "output" JSONB,
    "status" "ai_run_status" NOT NULL DEFAULT 'pending',
    "error_type" "ai_error_type",
    "error_message" VARCHAR(512),
    "duration_ms" INTEGER,
    "retry_of_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_run_type_key" ON "prompt_templates"("run_type");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_template_id_version_key" ON "prompt_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "ai_runs_lead_id_created_at_idx" ON "ai_runs"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_runs_user_id_created_at_idx" ON "ai_runs"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_model_config_id_fkey" FOREIGN KEY ("model_config_id") REFERENCES "model_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
