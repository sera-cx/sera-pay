-- Terminal hash ownership must be installed without a validation/backfill
-- race. Drizzle's PostgreSQL migrator runs each migration transactionally, so
-- this lock is held until the migration and its journal entry commit.
LOCK TABLE "transactions" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- Canonical storage makes both uniqueness and cross-kind ownership
-- case-insensitive.
UPDATE "transactions"
SET "txHash" = lower(btrim("txHash"))
WHERE "txHash" IS NOT NULL
  AND "txHash" IS DISTINCT FROM lower(btrim("txHash"));--> statement-breakpoint
UPDATE "transactions"
SET "settlementTxHash" = lower(btrim("settlementTxHash"))
WHERE "settlementTxHash" IS NOT NULL
  AND "settlementTxHash" IS DISTINCT FROM lower(btrim("settlementTxHash"));--> statement-breakpoint

-- Do not silently choose a historical winner. Operators must reconcile any
-- conflict against chain evidence before this invariant can be enabled.
DO $validate_transaction_hash_owners$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "transactions"
    WHERE "intentHash" IS NULL AND "txHash" IS NOT NULL
    GROUP BY lower("txHash")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot install transaction hash ownership: duplicate direct transaction hashes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "transactions"
    WHERE "intentHash" IS NULL
      AND "status" = 'confirmed'
      AND "verified" = 1
      AND "txHash" IS NOT NULL
      AND "txHash" !~ '^0x[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION
      'Cannot install transaction hash ownership: malformed confirmed direct transaction hash';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "transactions"
    WHERE "quoteUuid" IS NOT NULL
      AND "intentHash" ~* '^0x[0-9a-f]{64}$'
      AND "status" = 'confirmed'
      AND "verified" = 1
      AND "submitState" = 'settled'
      AND (
        "txHash" IS NULL
        OR "txHash" !~ '^0x[0-9a-f]{64}$'
        OR "settlementTxHash" IS DISTINCT FROM "txHash"
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot install transaction hash ownership: malformed confirmed Sera settlement hash';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "transactions" AS direct_tx
    JOIN "transactions" AS sera_tx
      ON lower(sera_tx."txHash") = lower(direct_tx."txHash")
    WHERE direct_tx."intentHash" IS NULL
      AND direct_tx."status" = 'confirmed'
      AND direct_tx."verified" = 1
      AND direct_tx."txHash" ~ '^0x[0-9a-f]{64}$'
      AND sera_tx."quoteUuid" IS NOT NULL
      AND sera_tx."intentHash" ~* '^0x[0-9a-f]{64}$'
      AND sera_tx."status" = 'confirmed'
      AND sera_tx."verified" = 1
      AND sera_tx."submitState" = 'settled'
      AND sera_tx."txHash" ~ '^0x[0-9a-f]{64}$'
      AND sera_tx."settlementTxHash" = sera_tx."txHash"
  ) THEN
    RAISE EXCEPTION
      'Cannot install transaction hash ownership: a confirmed direct transfer and Sera settlement share a hash';
  END IF;
END;
$validate_transaction_hash_owners$;--> statement-breakpoint

DROP INDEX IF EXISTS "uq_tx_direct_tx_hash";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tx_direct_tx_hash"
  ON "transactions" (lower("txHash"))
  WHERE "intentHash" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "transaction_hash_ownership" (
  "txHash" varchar(66) PRIMARY KEY NOT NULL,
  "ownerKind" varchar(16) NOT NULL,
  "directTransactionId" varchar(36),
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "transaction_hash_ownership_directTransactionId_unique"
    UNIQUE ("directTransactionId"),
  CONSTRAINT "ck_transaction_hash_ownership_hash"
    CHECK ("txHash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "ck_transaction_hash_ownership_kind"
    CHECK (
      ("ownerKind" = 'direct' AND "directTransactionId" IS NOT NULL)
      OR ("ownerKind" = 'sera' AND "directTransactionId" IS NULL)
  )
);--> statement-breakpoint
COMMENT ON TABLE "transaction_hash_ownership" IS
  'Permanent global replay tombstones; Sera batch hashes may have multiple transaction rows';--> statement-breakpoint

-- A batched Sera transaction owns one header regardless of how many Intents
-- it settled. Tentative direct notifications are deliberately absent.
INSERT INTO "transaction_hash_ownership" ("txHash", "ownerKind", "directTransactionId")
SELECT DISTINCT "txHash", 'sera', NULL
FROM "transactions"
WHERE "quoteUuid" IS NOT NULL
  AND "intentHash" ~* '^0x[0-9a-f]{64}$'
  AND "status" = 'confirmed'
  AND "verified" = 1
  AND "submitState" = 'settled'
  AND "txHash" ~ '^0x[0-9a-f]{64}$'
  AND "settlementTxHash" = "txHash"
ON CONFLICT ("txHash") DO NOTHING;--> statement-breakpoint
INSERT INTO "transaction_hash_ownership" ("txHash", "ownerKind", "directTransactionId")
SELECT "txHash", 'direct', "id"
FROM "transactions"
WHERE "intentHash" IS NULL
  AND "status" = 'confirmed'
  AND "verified" = 1
  AND "txHash" ~ '^0x[0-9a-f]{64}$'
ON CONFLICT ("txHash") DO NOTHING;--> statement-breakpoint

-- A previous runtime bootstrap may already have populated the tombstone table.
-- Resume safely only when those permanent owners agree with terminal rows.
DO $validate_transaction_hash_tombstones$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "transactions" AS tx
    JOIN "transaction_hash_ownership" AS ownership
      ON ownership."txHash" = tx."txHash"
    WHERE tx."quoteUuid" IS NOT NULL
      AND tx."intentHash" ~* '^0x[0-9a-f]{64}$'
      AND tx."status" = 'confirmed'
      AND tx."verified" = 1
      AND tx."submitState" = 'settled'
      AND tx."settlementTxHash" = tx."txHash"
      AND ownership."ownerKind" <> 'sera'
  ) OR EXISTS (
    SELECT 1
    FROM "transactions" AS tx
    JOIN "transaction_hash_ownership" AS ownership
      ON ownership."txHash" = tx."txHash"
    WHERE tx."intentHash" IS NULL
      AND tx."status" = 'confirmed'
      AND tx."verified" = 1
      AND (
        ownership."ownerKind" <> 'direct'
        OR ownership."directTransactionId" <> tx."id"
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot resume transaction hash ownership migration: an existing replay tombstone conflicts with a terminal transaction';
  END IF;
END;
$validate_transaction_hash_tombstones$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "normalize_transaction_hashes"()
RETURNS trigger
LANGUAGE plpgsql
AS $normalize_transaction_hashes$
BEGIN
  IF NEW."txHash" IS NOT NULL THEN
    NEW."txHash" := lower(btrim(NEW."txHash"));
  END IF;
  IF NEW."settlementTxHash" IS NOT NULL THEN
    NEW."settlementTxHash" := lower(btrim(NEW."settlementTxHash"));
  END IF;
  RETURN NEW;
END;
$normalize_transaction_hashes$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_normalize_transaction_hashes" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "trg_normalize_transaction_hashes"
  BEFORE INSERT OR UPDATE OF "txHash", "settlementTxHash" ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "normalize_transaction_hashes"();--> statement-breakpoint

-- The ownership row's primary key is the concurrency primitive. PostgreSQL
-- waits for an uncommitted competing insert before ON CONFLICT returns, so two
-- replicas cannot both commit incompatible terminal owners.
CREATE OR REPLACE FUNCTION "enforce_transaction_hash_ownership"()
RETURNS trigger
LANGUAGE plpgsql
AS $enforce_transaction_hash_ownership$
DECLARE
  new_hash text;
  new_kind text;
  existing_kind text;
  existing_direct_transaction_id text;
BEGIN
  IF NEW."intentHash" IS NULL
      AND NEW."status" = 'confirmed'
      AND NEW."verified" = 1
      AND NEW."txHash" ~ '^0x[0-9a-f]{64}$'
    THEN
      new_hash := lower(NEW."txHash");
      new_kind := 'direct';
    ELSIF NEW."quoteUuid" IS NOT NULL
      AND NEW."intentHash" ~* '^0x[0-9a-f]{64}$'
      AND NEW."status" = 'confirmed'
      AND NEW."verified" = 1
      AND NEW."submitState" = 'settled'
      AND NEW."txHash" ~ '^0x[0-9a-f]{64}$'
      AND NEW."settlementTxHash" = NEW."txHash"
    THEN
      new_hash := NEW."txHash";
      new_kind := 'sera';
  END IF;

  IF new_hash IS NOT NULL THEN
    INSERT INTO "transaction_hash_ownership" ("txHash", "ownerKind", "directTransactionId")
    VALUES (
      new_hash,
      new_kind,
      CASE WHEN new_kind = 'direct' THEN NEW."id" ELSE NULL END
    )
    ON CONFLICT ("txHash") DO NOTHING;

    SELECT ownership."ownerKind", ownership."directTransactionId"
    INTO existing_kind, existing_direct_transaction_id
    FROM "transaction_hash_ownership" AS ownership
    WHERE ownership."txHash" = new_hash
    FOR UPDATE;

    IF existing_kind IS DISTINCT FROM new_kind
      OR (new_kind = 'direct' AND existing_direct_transaction_id IS DISTINCT FROM NEW."id")
    THEN
      RAISE EXCEPTION 'Transaction hash % is already owned by %', new_hash, existing_kind
        USING ERRCODE = '23505', CONSTRAINT = 'transaction_hash_terminal_owner';
    END IF;
  END IF;

  RETURN NEW;
END;
$enforce_transaction_hash_ownership$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_enforce_transaction_hash_ownership" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "trg_enforce_transaction_hash_ownership"
  AFTER INSERT OR UPDATE OF
    "txHash", "settlementTxHash", "intentHash", "quoteUuid", "status", "verified", "submitState"
  ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_transaction_hash_ownership"();
