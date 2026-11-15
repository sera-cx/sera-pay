-- "menu_orders" entered the snapshots at 0003 without ever being written as a
-- migration, so `drizzle-kit generate` has considered it present since then
-- while no migration creates it. Any database built from `db:migrate` alone is
-- missing a table the POS order path reads with SELECT ... FOR UPDATE.
--
-- Deployed databases got the table from `db:push`, so every statement here is
-- written to be a no-op against them: the table, its foreign keys and its
-- indexes are each guarded independently, because a database pushed at an
-- older revision may hold the table without all of its constraints.
CREATE TABLE IF NOT EXISTS "menu_orders" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "merchantId" varchar(36) NOT NULL,
  "menuId" varchar(36) NOT NULL,
  "paymentId" varchar(36),
  "paymentIntentId" varchar(36),
  "transactionId" varchar(36),
  "status" varchar(24) DEFAULT 'created' NOT NULL,
  "pax" integer DEFAULT 1 NOT NULL,
  "businessCategory" varchar(80),
  "category_1" text,
  "category_2" text,
  "category_3" text,
  "category_4" text,
  "category_5" text,
  "category_6" text,
  "items" text NOT NULL,
  "amount" numeric(20, 6) NOT NULL,
  "coin" varchar(20) NOT NULL,
  "customerName" varchar(120),
  "orderedAt" timestamptz DEFAULT now() NOT NULL,
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ensurePostgresSchema() in server/db.ts creates this table at pool startup
-- with inline REFERENCES clauses, so a database that booted the app before
-- reaching this migration holds the same three keys under PostgreSQL's
-- generated names ("menu_orders_merchantId_fkey"). Matching on the referencing
-- column rather than the constraint name is what keeps this from adding a
-- second, identical key beside each of those; where one is found under the
-- wrong name it is renamed, so drizzle sees the names its snapshots record.
-- The transactionId key is ON DELETE SET NULL: a settled order has to outlive
-- the transaction row that paid it.
DO $menu_orders_foreign_keys$
DECLARE
  spec record;
  existing_name text;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('merchantId',    'merchants',    'menu_orders_merchantId_merchants_id_fk',       'CASCADE'),
      ('menuId',        'menus',        'menu_orders_menuId_menus_id_fk',               'CASCADE'),
      ('transactionId', 'transactions', 'menu_orders_transactionId_transactions_id_fk', 'SET NULL')
    ) AS t("column", "target", "canonical", "on_delete")
  LOOP
    SELECT c."conname" INTO existing_name
    FROM "pg_constraint" AS c
    WHERE c."conrelid" = '"menu_orders"'::regclass
      AND c."contype" = 'f'
      AND c."conkey" = ARRAY[(
        SELECT a."attnum"
        FROM "pg_attribute" AS a
        WHERE a."attrelid" = '"menu_orders"'::regclass
          AND a."attname" = spec."column"
      )]::smallint[]
    ORDER BY (c."conname" = spec."canonical") DESC
    LIMIT 1;

    IF existing_name IS NULL THEN
      EXECUTE format(
        'ALTER TABLE "menu_orders" ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s',
        spec."canonical", spec."column", spec."target", spec."on_delete"
      );
    ELSIF existing_name <> spec."canonical" THEN
      EXECUTE format(
        'ALTER TABLE "menu_orders" RENAME CONSTRAINT %I TO %I',
        existing_name, spec."canonical"
      );
    END IF;
  END LOOP;
END;
$menu_orders_foreign_keys$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_menu_orders_merchant_created"
  ON "menu_orders" ("merchantId", "createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_menu_orders_menu_created"
  ON "menu_orders" ("menuId", "createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_menu_orders_payment"
  ON "menu_orders" ("paymentId");
