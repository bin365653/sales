-- CreateEnum
CREATE TYPE "lead_quadrant" AS ENUM ('a', 'b', 'c', 'd');

-- CreateEnum
CREATE TYPE "profile_status" AS ENUM ('incomplete', 'basic', 'deep');

-- CreateEnum
CREATE TYPE "verification_source" AS ENUM ('manual', 'import', 'interaction', 'initial');

-- AlterEnum
ALTER TYPE "fact_status" ADD VALUE 'stated';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "lead_event_type" ADD VALUE 'quadrant_changed';
ALTER TYPE "lead_event_type" ADD VALUE 'plan_changed';

-- AlterTable
ALTER TABLE "lead_field_defs" ADD COLUMN     "dict_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "business_mgmt_mode" VARCHAR(64),
ADD COLUMN     "customer_count" INTEGER,
ADD COLUMN     "delivery_mgmt_mode" VARCHAR(64),
ADD COLUMN     "expressed_needs" TEXT,
ADD COLUMN     "finance_mgmt_mode" VARCHAR(64),
ADD COLUMN     "is_boss_contact" BOOLEAN,
ADD COLUMN     "last_profile_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "next_gen_mobile_order" BOOLEAN,
ADD COLUMN     "no_interest_reason" VARCHAR(255),
ADD COLUMN     "order_mgmt_mode" VARCHAR(64),
ADD COLUMN     "picker_count" INTEGER,
ADD COLUMN     "profile_status" "profile_status",
ADD COLUMN     "purchase_intent" VARCHAR(64),
ADD COLUMN     "qince_interest" BOOLEAN,
ADD COLUMN     "quadrant_code" "lead_quadrant",
ADD COLUMN     "quadrant_computed_at" TIMESTAMPTZ(6),
ADD COLUMN     "sales_team_scale" VARCHAR(32),
ADD COLUMN     "software_version" VARCHAR(128),
ADD COLUMN     "warehouse_area" VARCHAR(64),
ADD COLUMN     "warehouse_type" VARCHAR(32);

-- CreateTable
CREATE TABLE "lead_field_verifications" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "field_key" VARCHAR(64) NOT NULL,
    "status" "fact_status" NOT NULL DEFAULT 'unknown',
    "source" "verification_source" NOT NULL DEFAULT 'manual',
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "note" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_field_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_field_verifications_lead_id_idx" ON "lead_field_verifications"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_field_verifications_lead_id_field_key_key" ON "lead_field_verifications"("lead_id", "field_key");

-- AddForeignKey
ALTER TABLE "lead_field_verifications" ADD CONSTRAINT "lead_field_verifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- V2.0-T01 回填（实施计划 §3.1）：核实元数据从 V1.0 四个旧状态列回填 initial 行。
-- 对账口径（验收项②）：回填行 status = 对应旧状态列值，source=initial，核实人/时间为空；
-- 软删除线索一并回填（历史数据口径一致）。存量象限相关新列不回填，恒为 null
-- （验收项⑤：存量客户 quadrant 全 null，未知不得强制归类）。
INSERT INTO "lead_field_verifications" ("id", "lead_id", "field_key", "status", "source", "verified_by", "verified_at", "note", "created_at", "updated_at")
SELECT gen_random_uuid(), l."id", 'current_system', l."current_system_status", 'initial', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "leads" l;

INSERT INTO "lead_field_verifications" ("id", "lead_id", "field_key", "status", "source", "verified_by", "verified_at", "note", "created_at", "updated_at")
SELECT gen_random_uuid(), l."id", 'contract_expiry', l."contract_expiry_status", 'initial', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "leads" l;

INSERT INTO "lead_field_verifications" ("id", "lead_id", "field_key", "status", "source", "verified_by", "verified_at", "note", "created_at", "updated_at")
SELECT gen_random_uuid(), l."id", 'purchase_time', l."purchase_time_status", 'initial', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "leads" l;

INSERT INTO "lead_field_verifications" ("id", "lead_id", "field_key", "status", "source", "verified_by", "verified_at", "note", "created_at", "updated_at")
SELECT gen_random_uuid(), l."id", 'decision_maker', l."decision_maker_status", 'initial', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "leads" l;
