ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementTxHash" varchar(66);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementBlockNumber" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementBlockHash" varchar(66);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementConfirmations" integer;--> statement-breakpoint
DO $provisional_settlement_constraint$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_transactions_provisional_settlement_complete'
      AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "ck_transactions_provisional_settlement_complete" CHECK ((
        ("provisionalSettlementAt" IS NULL
          AND "provisionalSettlementTxHash" IS NULL
          AND "provisionalSettlementBlockNumber" IS NULL
          AND "provisionalSettlementBlockHash" IS NULL
          AND "provisionalSettlementConfirmations" IS NULL)
        OR
        ("provisionalSettlementAt" IS NOT NULL
          AND "provisionalSettlementTxHash" IS NOT NULL
          AND "provisionalSettlementBlockNumber" IS NOT NULL
          AND "provisionalSettlementBlockHash" IS NOT NULL
          AND "provisionalSettlementConfirmations" BETWEEN 1 AND 2)
      ));
  END IF;
END $provisional_settlement_constraint$;
