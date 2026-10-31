-- CreateTable
CREATE TABLE "dict_entries" (
    "id" UUID NOT NULL,
    "field_key" VARCHAR(64) NOT NULL,
    "value" VARCHAR(128) NOT NULL,
    "meta" JSONB,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dict_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dict_entries_field_key_is_active_sort_order_idx" ON "dict_entries"("field_key", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "dict_entries_field_key_value_key" ON "dict_entries"("field_key", "value");
