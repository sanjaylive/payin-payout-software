-- CreateEnum
CREATE TYPE "BrandAssetKind" AS ENUM ('LOGO', 'LOGO_DARK', 'ICON');

-- CreateTable
CREATE TABLE "brand_settings" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'default',
    "product_name" VARCHAR(60) NOT NULL,
    "short_name" VARCHAR(30) NOT NULL,
    "company_name" VARCHAR(160) NOT NULL,
    "tagline" VARCHAR(160) NOT NULL,
    "primary_color" CHAR(7),
    "support_email" VARCHAR(254),
    "support_phone" VARCHAR(20),
    "website_url" VARCHAR(300),
    "login_headline" VARCHAR(120) NOT NULL,
    "login_subtext" VARCHAR(300) NOT NULL,
    "footer_text" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brand_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_assets" (
    "kind" "BrandAssetKind" NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brand_assets_pkey" PRIMARY KEY ("kind")
);

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_single_row" CHECK ("id" = 'default');
ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_color" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_size" CHECK ("size_bytes" > 0 AND "size_bytes" <= 1048576 AND octet_length("bytes") = "size_bytes");
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_type" CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon'));
