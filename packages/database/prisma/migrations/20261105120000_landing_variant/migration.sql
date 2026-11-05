-- Public landing page variant (Settings → Landing Page).
ALTER TABLE "brand_settings" ADD COLUMN "landing_variant" VARCHAR(20) NOT NULL DEFAULT 'PAYMENTS';
