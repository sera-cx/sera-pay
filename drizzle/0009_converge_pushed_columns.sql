-- Six columns and one default reached deployed databases through `db:push`
-- and ensurePostgresSchema() without ever being written as a migration, so
-- the snapshots have recorded them since 0003 while `db:migrate` never
-- produced them. This is the same drift that left "menu_orders" unwritten in
-- 0008; these statements make a migration-built schema match drizzle/schema.ts
-- instead of depending on the runtime bootstrap to patch it at every boot.
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "description" varchar(500);--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "qrMode" varchar(20) DEFAULT 'standard';--> statement-breakpoint

ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "businessCategory" varchar(80);--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "businessCategoryOther" varchar(120);--> statement-breakpoint

ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "itemCode" varchar(64);--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "soldOutUntil" timestamptz;--> statement-breakpoint

-- 'mock' was the resting state for every merchant who never opened the Sera
-- API settings, and it resolved to Sepolia throughout the client; mainnet is
-- the default now (schema.ts, and 0c66a1f). This moves the column default
-- only. Existing 'mock' rows are converged separately by ensurePostgresSchema()
-- in server/db.ts, which rewrites them on every boot.
ALTER TABLE "api_key_configs" ALTER COLUMN "mode" SET DEFAULT 'live';
