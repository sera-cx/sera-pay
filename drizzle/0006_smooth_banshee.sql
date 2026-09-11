ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "checkoutAttemptKey" varchar(66);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "normalize_checkout_attempt_key"()
RETURNS trigger
LANGUAGE plpgsql
AS $normalize_checkout_attempt_key$
BEGIN
	IF NEW."checkoutAttemptKey" IS NOT NULL THEN
		NEW."checkoutAttemptKey" := NULLIF(lower(btrim(NEW."checkoutAttemptKey")), '');
	END IF;
	RETURN NEW;
END;
$normalize_checkout_attempt_key$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_normalize_checkout_attempt_key" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "trg_normalize_checkout_attempt_key"
	BEFORE INSERT OR UPDATE OF "checkoutAttemptKey" ON "transactions"
	FOR EACH ROW EXECUTE FUNCTION "normalize_checkout_attempt_key"();--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_active_checkout_attempt_key" ON "transactions" USING btree (lower(btrim("checkoutAttemptKey"))) WHERE "transactions"."checkoutAttemptKey" IS NOT NULL AND "transactions"."status" IN ('pending', 'confirming');
