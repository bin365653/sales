-- CreateEnum
CREATE TYPE "lead_field_type" AS ENUM ('text', 'number', 'date', 'single_select');

-- CreateEnum
CREATE TYPE "fact_status" AS ENUM ('unknown', 'unverified', 'confirmed');

-- CreateEnum
CREATE TYPE "lead_priority" AS ENUM ('high', 'mid', 'low');

-- CreateEnum
CREATE TYPE "lead_event_type" AS ENUM ('created', 'imported', 'updated', 'stage_changed', 'deleted');

-- CreateTable
CREATE TABLE "lead_field_defs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "type" "lead_field_type" NOT NULL,
    "options" JSONB,
    "validation" JSONB,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "city" VARCHAR(64),
    "industry" VARCHAR(64),
    "main_category" VARCHAR(128),
    "contact_name" VARCHAR(64),
    "contact_title" VARCHAR(64),
    "contact_phone" VARCHAR(32),
    "source" VARCHAR(64),
    "sales_team_size" INTEGER,
    "revenue_range" VARCHAR(64),
    "sales_mode" VARCHAR(64),
    "current_system" VARCHAR(128),
    "system_modules" VARCHAR(255),
    "contract_expiry" DATE,
    "known_pains" TEXT,
    "considering_switch" BOOLEAN,
    "has_clear_demand" BOOLEAN,
    "purchase_time" VARCHAR(64),
    "budget" VARCHAR(64),
    "decision_maker" VARCHAR(128),
    "decision_process" VARCHAR(255),
    "main_concerns" TEXT,
    "current_system_status" "fact_status" NOT NULL DEFAULT 'unknown',
    "contract_expiry_status" "fact_status" NOT NULL DEFAULT 'unknown',
    "purchase_time_status" "fact_status" NOT NULL DEFAULT 'unknown',
    "decision_maker_status" "fact_status" NOT NULL DEFAULT 'unknown',
    "stage_id" UUID NOT NULL,
    "priority" "lead_priority" NOT NULL DEFAULT 'mid',
    "owner_id" UUID NOT NULL,
    "last_contact_at" TIMESTAMPTZ(6),
    "next_contact_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "custom_values" JSONB,
    "data_version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "actor_id" UUID,
    "event_type" "lead_event_type" NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID,
    "stage_snapshot" JSONB,
    "detail" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_field_defs_key_key" ON "lead_field_defs"("key");

-- CreateIndex
CREATE INDEX "lead_field_defs_is_active_sort_order_idx" ON "lead_field_defs"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "leads_owner_id_deleted_at_stage_id_idx" ON "leads"("owner_id", "deleted_at", "stage_id");

-- CreateIndex
CREATE INDEX "leads_owner_id_next_contact_at_idx" ON "leads"("owner_id", "next_contact_at");

-- CreateIndex
CREATE INDEX "leads_stage_id_idx" ON "leads"("stage_id");

-- CreateIndex
CREATE INDEX "lead_events_lead_id_occurred_at_idx" ON "lead_events"("lead_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "lead_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
