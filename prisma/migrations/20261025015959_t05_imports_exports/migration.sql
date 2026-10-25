-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('pending', 'confirmed', 'canceled');

-- CreateEnum
CREATE TYPE "import_dup_type" AS ENUM ('none', 'exact', 'fuzzy');

-- CreateEnum
CREATE TYPE "import_decision" AS ENUM ('skip', 'create_new');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "file_hash" VARCHAR(64) NOT NULL,
    "headers" JSONB,
    "mapping" JSONB,
    "status" "import_status" NOT NULL DEFAULT 'pending',
    "counts" JSONB,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "errors" JSONB,
    "has_errors" BOOLEAN NOT NULL DEFAULT false,
    "dup_type" "import_dup_type" NOT NULL DEFAULT 'none',
    "dup_lead_id" UUID,
    "dup_row_no" INTEGER,
    "decision" "import_decision" NOT NULL DEFAULT 'skip',

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_files" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(128) NOT NULL,
    "content" BYTEA NOT NULL,
    "filters" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_user_id_created_at_idx" ON "import_batches"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_dup_type_idx" ON "import_rows"("batch_id", "dup_type");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_batch_id_row_no_key" ON "import_rows"("batch_id", "row_no");

-- CreateIndex
CREATE INDEX "export_files_user_id_created_at_idx" ON "export_files"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "export_files_expires_at_idx" ON "export_files"("expires_at");

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
