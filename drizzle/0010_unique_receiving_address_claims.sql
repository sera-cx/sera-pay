-- A receiving address may be claimed by one merchant only.
--
-- POST /sub-wallets marked any well-formed address active without checking
-- that the caller controlled it or that another merchant already held it, and
-- PUT /merchant/settings and PUT /merchant/profile did the same for the
-- settlement override. Both addresses are resolved back to a single merchant
-- (getSubWalletByAddress, getMerchantByStoreAddress) by a LIMIT 1 read with no
-- tie-break, so a second claim on the same address made attribution a race:
-- transfers to the address could be credited to whichever merchant's row the
-- index scan reached first, and the other merchant's checkout links failed
-- ownership binding with 403. Receiving addresses are printed in every QR
-- code, so claiming one took nothing but a merchant API key.
--
-- The route checks in server/address-claims.ts reject a conflicting claim;
-- these indexes are the backstop that closes the window between the check and
-- the write. Everything before them is a one-time repair, because the index
-- cannot be created while a conflict is still stored.

-- Every write path lowercases before storing, so this only catches rows from
-- before that was true. It runs first: a mixed-case duplicate is still a
-- duplicate, and the de-duplication below has to see it as one.
UPDATE "sub_wallets" SET "address" = lower("address")
  WHERE "address" <> lower("address");--> statement-breakpoint
UPDATE "merchants" SET "storeAddress" = lower("storeAddress")
  WHERE "storeAddress" IS NOT NULL AND "storeAddress" <> lower("storeAddress");--> statement-breakpoint

-- Proof beats claim. A merchant's own walletAddress was proven at registration
-- (Privy wallet linkage, or an EIP-712 signature as the fallback), while a
-- sub-wallet or settlement claim was only asserted. Where the two collide the
-- asserted one is released: this is the repair for any claim-jumping that
-- already happened, and it is the only resolution that does not take an
-- address away from the merchant who proved they hold it.
UPDATE "sub_wallets" AS s SET "status" = 'archived', "updatedAt" = now()
  FROM "merchants" AS m
  WHERE s."status" = 'active'
    AND s."address" = m."walletAddress"
    AND s."merchantId" <> m."id";--> statement-breakpoint
UPDATE "merchants" AS m SET "storeAddress" = NULL, "updatedAt" = now()
  FROM "merchants" AS owner
  WHERE m."storeAddress" IS NOT NULL
    AND m."storeAddress" = owner."walletAddress"
    AND m."id" <> owner."id";--> statement-breakpoint

-- Two claims of equal standing: keep the earlier one, which is the row the
-- LIMIT 1 reads already resolved to in practice, and release the later. A
-- merchant left without a settlement override falls back to their own
-- walletAddress, so no payment is left without a recipient.
WITH "ranked" AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "address" ORDER BY "createdAt", "id"
  ) AS "rn"
  FROM "sub_wallets"
  WHERE "status" = 'active'
)
UPDATE "sub_wallets" AS s SET "status" = 'archived', "updatedAt" = now()
  FROM "ranked"
  WHERE s."id" = "ranked"."id" AND "ranked"."rn" > 1;--> statement-breakpoint
WITH "ranked" AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "storeAddress" ORDER BY "createdAt", "id"
  ) AS "rn"
  FROM "merchants"
  WHERE "storeAddress" IS NOT NULL
)
UPDATE "merchants" AS m SET "storeAddress" = NULL, "updatedAt" = now()
  FROM "ranked"
  WHERE m."id" = "ranked"."id" AND "ranked"."rn" > 1;--> statement-breakpoint

-- IF NOT EXISTS because ensurePostgresSchema() in server/db.ts creates both of
-- these at pool startup under the same names and the same repair, so a
-- database that booted the app before reaching this migration already has them.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_merchants_store_address"
  ON "merchants" USING btree ("storeAddress")
  WHERE "merchants"."storeAddress" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sub_wallets_active_address"
  ON "sub_wallets" USING btree ("address")
  WHERE "sub_wallets"."status" = 'active';
