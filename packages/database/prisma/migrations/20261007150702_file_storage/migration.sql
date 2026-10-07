-- CreateEnum
CREATE TYPE "StorageKind" AS ENUM ('S3', 'GOOGLE_DRIVE', 'LOCAL');

-- CreateTable
CREATE TABLE "storage_backends" (
    "id" TEXT NOT NULL,
    "kind" "StorageKind" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_encrypted" TEXT,
    "fingerprints" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_tested_at" TIMESTAMPTZ(3),
    "last_test_ok" BOOLEAN,
    "last_test_error" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_backends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_objects" (
    "key" VARCHAR(300) NOT NULL,
    "backend_id" TEXT NOT NULL,
    "locator" VARCHAR(500) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "sha256" VARCHAR(64),
    "wrapped_key" VARCHAR(300) NOT NULL,
    "iv" VARCHAR(32) NOT NULL,
    "auth_tag" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_objects_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_backends_kind_key" ON "storage_backends"("kind");

-- CreateIndex
CREATE INDEX "storage_objects_backend_id_idx" ON "storage_objects"("backend_id");

-- AddForeignKey
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_backend_id_fkey" FOREIGN KEY ("backend_id") REFERENCES "storage_backends"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one backend receives new files (none = the server's environment S3).
CREATE UNIQUE INDEX "storage_backends_one_active" ON "storage_backends" ((true)) WHERE "is_active";

-- Locators are opaque handles; a local path may never escape the storage root.
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_locator_safe" CHECK ("locator" !~ '(^/|\.\.|\\)');
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_size_nonneg" CHECK ("size_bytes" >= 0);
