ALTER TYPE "public"."payment_intent_status" ADD VALUE IF NOT EXISTS 'processing' BEFORE 'paid';--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "transactionId" varchar(36);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedTxHash" varchar(66);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedBlockNumber" numeric(78, 0);--> statement-breakpoint
DO $add_payment_intent_transaction_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_intents_transactionId_transactions_id_fk'
      AND conrelid = 'payment_intents'::regclass
  ) THEN
    ALTER TABLE "payment_intents"
      ADD CONSTRAINT "payment_intents_transactionId_transactions_id_fk"
      FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END;
$add_payment_intent_transaction_fk$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_transaction" ON "payment_intents" USING btree ("transactionId");
