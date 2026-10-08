-- CreateTable
CREATE TABLE "reseller_brands" (
    "organization_id" TEXT NOT NULL,
    "product_name" VARCHAR(60) NOT NULL,
    "short_name" VARCHAR(30) NOT NULL,
    "primary_color" CHAR(7),
    "support_email" VARCHAR(254),
    "support_phone" VARCHAR(20),
    "website_url" VARCHAR(300),
    "login_headline" VARCHAR(120),
    "login_subtext" VARCHAR(300),
    "footer_text" VARCHAR(200),
    "custom_domain" VARCHAR(253),
    "domain_token" VARCHAR(64),
    "domain_verified_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reseller_brands_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "reseller_brand_assets" (
    "organization_id" TEXT NOT NULL,
    "kind" "BrandAssetKind" NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reseller_brand_assets_pkey" PRIMARY KEY ("organization_id","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "reseller_brands_custom_domain_key" ON "reseller_brands"("custom_domain");

-- AddForeignKey
ALTER TABLE "reseller_brands" ADD CONSTRAINT "reseller_brands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_brand_assets" ADD CONSTRAINT "reseller_brand_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "reseller_brands"("organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "reseller_brands" ADD CONSTRAINT "reseller_brands_color" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "reseller_brands" ADD CONSTRAINT "reseller_brands_domain" CHECK ("custom_domain" IS NULL OR "custom_domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$');
ALTER TABLE "reseller_brands" ADD CONSTRAINT "reseller_brands_verified" CHECK ("domain_verified_at" IS NULL OR "custom_domain" IS NOT NULL);
