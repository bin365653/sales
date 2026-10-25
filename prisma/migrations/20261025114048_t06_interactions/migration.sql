-- CreateEnum
CREATE TYPE "interaction_channel" AS ENUM ('phone', 'wechat', 'visit', 'other');

-- CreateEnum
CREATE TYPE "interaction_direction" AS ENUM ('outbound', 'inbound');

-- CreateTable
CREATE TABLE "interactions" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" "interaction_channel" NOT NULL,
    "direction" "interaction_direction" NOT NULL,
    "connected" BOOLEAN NOT NULL,
    "effective" BOOLEAN NOT NULL,
    "feedback" TEXT,
    "confirmed_pains" TEXT,
    "current_system_confirmed" VARCHAR(128),
    "purchase_time_confirmed" VARCHAR(64),
    "decision_maker_note" VARCHAR(255),
    "objections" TEXT,
    "next_action" VARCHAR(255),
    "next_contact_at" TIMESTAMPTZ(6),
    "is_qualified" BOOLEAN NOT NULL DEFAULT false,
    "demo_booked" BOOLEAN NOT NULL DEFAULT false,
    "edit_audit" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interactions_lead_id_occurred_at_idx" ON "interactions"("lead_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
