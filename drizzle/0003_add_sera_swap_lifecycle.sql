ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "quoteUuid" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "routeUuid" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentHash" varchar(66);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "tradeId" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraVaultAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraSorAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payTokenAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "receiveTokenAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payTokenDecimals" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "receiveTokenDecimals" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "requestedPayAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "maximumPayAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "targetReceiveAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "minimumReceiveAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "initialDepositAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "quoteExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentDeadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "permitRequired" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "permitDeadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "submitState" varchar(32);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "submittedBlockNumber" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraStatus" varchar(64);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraOutcomeSyncedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "actualPayAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "actualReceiveAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "feeAmountRaw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "feeTokenAddress" varchar(42);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "settlementTxHash" varchar(66);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "failureCode" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_txHash_unique";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_txHash_key";--> statement-breakpoint
DROP INDEX IF EXISTS "transactions_txHash_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "transactions_txHash_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_direct_tx_hash" ON "transactions" USING btree ("txHash") WHERE "intentHash" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_quote_uuid" ON "transactions" USING btree ("quoteUuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_route_uuid" ON "transactions" USING btree ("routeUuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_intent_hash" ON "transactions" USING btree ("intentHash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_trade_id" ON "transactions" USING btree ("tradeId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_submit_state_updated" ON "transactions" USING btree ("submitState", "updatedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_settlement_hash" ON "transactions" USING btree ("settlementTxHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_sera_vault_chain" ON "transactions" USING btree ("chainId", "seraVaultAddress");
