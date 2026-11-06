import crypto from "crypto";
import { eq, asc, desc, and, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  InsertUser,
  users,
  merchants,
  transactions,
  Merchant,
  InsertMerchant,
  Transaction,
  InsertTransaction,
  webhookLogs,
  InsertWebhookLog,
  WebhookLog,
  apiKeyConfigs,
  ApiKeyConfigRecord,
  InsertApiKeyConfig,
  subWallets,
  SubWallet,
  InsertSubWallet,
  paymentIntents,
  PaymentIntent,
  InsertPaymentIntent,
  menuOrders,
  MenuOrder,
  InsertMenuOrder,
  seraApiRequestLogs,
  SeraApiRequestLog,
  InsertSeraApiRequestLog,
  complianceScreeningLogs,
  ComplianceScreeningLog,
  InsertComplianceScreeningLog,
  SERA_SWAP_SUBMIT_STATES,
  type SeraSwapSubmitState,
} from "../drizzle/schema";
import { ENV } from './_core/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;
let _pgPool: pg.Pool | null = null;
let _pgSchemaReady = false;
let _pgUnavailableReason: string | null = null;
/*
  When to allow another connection attempt after one failed.

  This used to be a permanent latch: a single failed connect — including a
  transient one — disabled Postgres for the entire life of the process and
  silently served every read from the in-memory fallback instead, so merchants
  and their API keys simply vanished until someone restarted the server. The
  database sits behind a relayed link, so a blip at start-up is ordinary rather
  than exceptional. Back off, then try again.
*/
let _pgUnavailableUntil = 0;
const PG_UNAVAILABLE_COOLDOWN_MS = 30_000;

/**
 * Connection-level failures worth one retry, as opposed to a genuine query or
 * constraint error. Matched on message because node-postgres surfaces several
 * of these without a code.
 */
function isTransientConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // "timeout exceeded when trying to connect" is what pg-pool throws when
  // connectionTimeoutMillis elapses — the single most likely symptom of a
  // congested link, and the one this list originally missed.
  return /connection terminated|connection timeout|timeout exceeded|timeout expired|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|socket hang up|server closed the connection/i.test(message);
}

const memory = {
  merchants: new Map<string, Merchant>(),
  transactions: new Map<string, Transaction>(),
  webhookLogs: new Map<string, WebhookLog>(),
  apiKeyConfigs: new Map<string, ApiKeyConfigRecord>(),
  subWallets: new Map<string, SubWallet>(),
  paymentIntents: new Map<string, PaymentIntent>(),
  menuOrders: new Map<string, MenuOrder>(),
  seraApiLogs: new Map<string, SeraApiRequestLog>(),
  complianceLogs: new Map<string, ComplianceScreeningLog>(),
  // Permanent, process-local replay tombstones mirroring
  // transaction_hash_ownership in PostgreSQL.
  transactionHashOwnership: new Map<string, TerminalTransactionHashOwnership>(),
};

function now() {
  return new Date();
}

function withTimestamps<T extends Record<string, unknown>>(data: T) {
  const timestamp = now();
  return { createdAt: timestamp, updatedAt: timestamp, ...data } as T & { createdAt: Date; updatedAt: Date };
}

function isPostgresDatabaseUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

function q(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeDbValue(value: unknown) {
  return value === undefined ? null : value;
}

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export function normalizeCheckoutAttemptKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 66) throw new Error("checkoutAttemptKey cannot exceed 66 characters");
  return normalized;
}

/** Keep transaction identity fields canonical in every storage backend. */
function normalizeTransactionFields<T extends Record<string, unknown>>(data: T): T {
  const normalized = { ...data } as Record<string, unknown>;
  for (const field of ["txHash", "settlementTxHash"] as const) {
    if (typeof normalized[field] === "string") {
      normalized[field] = normalized[field].trim().toLowerCase();
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "checkoutAttemptKey")) {
    const checkoutAttemptKey = normalized.checkoutAttemptKey;
    if (checkoutAttemptKey !== null && checkoutAttemptKey !== undefined && typeof checkoutAttemptKey !== "string") {
      throw new Error("checkoutAttemptKey must be a string or null");
    }
    normalized.checkoutAttemptKey = normalizeCheckoutAttemptKey(checkoutAttemptKey as string | null | undefined);
  }
  return normalized as T;
}

export type TerminalTransactionHashOwnership = {
  kind: "direct" | "sera";
  txHash: string;
  directTransactionId: string | null;
};

/**
 * Classify only authoritative terminal hash owners. A direct notification in
 * `confirming`/unverified state is intentionally not an owner: finalized Sera
 * evidence must be able to win that race.
 */
export function getTerminalTransactionHashOwnership(
  transaction: Pick<
    Transaction,
    "id" | "txHash" | "settlementTxHash" | "quoteUuid" | "intentHash" | "status" | "verified" | "submitState"
  >,
): TerminalTransactionHashOwnership | undefined {
  const txHash = transaction.txHash?.trim().toLowerCase();
  if (!txHash || !TRANSACTION_HASH_PATTERN.test(txHash)) return undefined;

  if (
    transaction.intentHash == null
    && transaction.status === "confirmed"
    && transaction.verified === 1
  ) {
    return { kind: "direct", txHash, directTransactionId: transaction.id };
  }

  if (
    transaction.quoteUuid != null
    && transaction.intentHash != null
    && TRANSACTION_HASH_PATTERN.test(transaction.intentHash.trim().toLowerCase())
    && transaction.status === "confirmed"
    && transaction.verified === 1
    && transaction.submitState === "settled"
    && transaction.settlementTxHash?.trim().toLowerCase() === txHash
  ) {
    return { kind: "sera", txHash, directTransactionId: null };
  }

  return undefined;
}

function terminalTransactionHashesConflict(
  left: TerminalTransactionHashOwnership,
  right: TerminalTransactionHashOwnership,
): boolean {
  if (left.txHash !== right.txHash) return false;
  if (left.kind === "sera" && right.kind === "sera") return false;
  return left.kind !== "direct"
    || right.kind !== "direct"
    || left.directTransactionId !== right.directTransactionId;
}

function transactionHashConflictError(txHash: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`Transaction hash ${txHash} already has an authoritative owner`), {
    code: "23505",
    constraint: "transaction_hash_terminal_owner",
  });
}

function assertMemoryTerminalHashOwnership(candidate: Transaction): void {
  const candidateHash = candidate.txHash?.trim().toLowerCase();
  if (candidate.intentHash == null && candidateHash) {
    for (const existing of memory.transactions.values()) {
      if (
        existing.id !== candidate.id
        && existing.intentHash == null
        && existing.txHash?.trim().toLowerCase() === candidateHash
      ) {
        throw transactionHashConflictError(candidateHash);
      }
    }
  }

  const candidateOwnership = getTerminalTransactionHashOwnership(candidate);
  if (!candidateOwnership) return;
  const permanentOwnership = memory.transactionHashOwnership.get(candidateOwnership.txHash);
  if (permanentOwnership && terminalTransactionHashesConflict(candidateOwnership, permanentOwnership)) {
    throw transactionHashConflictError(candidateOwnership.txHash);
  }
  for (const existing of memory.transactions.values()) {
    if (existing.id === candidate.id) continue;
    const existingOwnership = getTerminalTransactionHashOwnership(existing);
    if (existingOwnership && terminalTransactionHashesConflict(candidateOwnership, existingOwnership)) {
      throw transactionHashConflictError(candidateOwnership.txHash);
    }
  }
  if (!permanentOwnership) {
    memory.transactionHashOwnership.set(candidateOwnership.txHash, candidateOwnership);
  }
}

function isActiveCheckoutAttemptOwner(transaction: Transaction): boolean {
  return transaction.checkoutAttemptKey != null
    && (transaction.status === "pending" || transaction.status === "confirming");
}

function activeCheckoutAttemptConflictError(checkoutAttemptKey: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`Checkout attempt ${checkoutAttemptKey} already has an active transaction`), {
    code: "23505",
    constraint: "uq_tx_active_checkout_attempt_key",
  });
}

/** Mirror the PostgreSQL partial unique index in the development fallback. */
function assertMemoryActiveCheckoutAttemptOwnership(candidate: Transaction): void {
  if (!isActiveCheckoutAttemptOwner(candidate)) return;
  const checkoutAttemptKey = normalizeCheckoutAttemptKey(candidate.checkoutAttemptKey)!;
  for (const existing of memory.transactions.values()) {
    if (
      existing.id !== candidate.id
      && isActiveCheckoutAttemptOwner(existing)
      && normalizeCheckoutAttemptKey(existing.checkoutAttemptKey) === checkoutAttemptKey
    ) {
      throw activeCheckoutAttemptConflictError(checkoutAttemptKey);
    }
  }
}

async function ensurePostgresSchema(pool: pg.Pool) {
  if (_pgSchemaReady) return;
  const sql = `
    CREATE TABLE IF NOT EXISTS "users" (
      "id" serial PRIMARY KEY,
      "openId" varchar(64) NOT NULL UNIQUE,
      "name" text,
      "email" varchar(320),
      "loginMethod" varchar(64),
      "privy_wallet" varchar(42),
      "user_wallet" varchar(42),
      "wallet_type" varchar(32),
      "role" varchar(20) NOT NULL DEFAULT 'user',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "lastSignedIn" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_wallet" varchar(42);
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "user_wallet" varchar(42);
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wallet_type" varchar(32);

    CREATE TABLE IF NOT EXISTS "merchants" (
      "id" varchar(36) PRIMARY KEY,
      "walletAddress" varchar(42) NOT NULL UNIQUE,
      "name" varchar(120) NOT NULL,
      "description" varchar(500),
      "apiKeyHash" varchar(64) NOT NULL,
      "receiveCoin" varchar(20) DEFAULT 'USDC',
      "logoData" text,
      "webhookUrl" varchar(512),
      "webhookSecret" varchar(64),
      "storeAddress" varchar(42),
      "qrFgColor" varchar(9),
      "qrBgColor" varchar(9),
      "qrStyle" varchar(20),
      "qrMode" varchar(20) DEFAULT 'standard',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "description" varchar(500);
    ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "qrMode" varchar(20) DEFAULT 'standard';
    CREATE INDEX IF NOT EXISTS "idx_merchants_wallet" ON "merchants" ("walletAddress");
    ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "apiKeyHash" varchar(64);
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'merchants' AND column_name = 'apiKey') THEN
        UPDATE "merchants" SET "apiKeyHash" = encode(sha256(convert_to("apiKey", 'UTF8')), 'hex') WHERE "apiKeyHash" IS NULL;
      END IF;
    END $$;
    ALTER TABLE "merchants" ALTER COLUMN "apiKeyHash" SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_merchants_api_key_hash" ON "merchants" ("apiKeyHash");
    ALTER TABLE "merchants" DROP COLUMN IF EXISTS "apiKey";

    CREATE TABLE IF NOT EXISTS "transactions" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "txHash" varchar(66),
      "fromAddress" varchar(42),
      "toAddress" varchar(42) NOT NULL,
      "coin" varchar(20) NOT NULL,
      "amount" numeric(36, 18) NOT NULL,
      "amountUsd" numeric(20, 6),
      "chainId" integer NOT NULL DEFAULT 1,
      "status" varchar(20) NOT NULL DEFAULT 'pending',
      "payCoin" varchar(20),
      "payAmount" numeric(36, 18),
      "memo" varchar(200),
      "notes" text,
      "checkoutAttemptKey" varchar(66),
      "quoteUuid" varchar(128),
      "routeUuid" numeric(78, 0),
      "intentHash" varchar(66),
      "tradeId" varchar(128),
      "seraAddress" varchar(42),
      "seraVaultAddress" varchar(42),
      "seraSorAddress" varchar(42),
      "payTokenAddress" varchar(42),
      "receiveTokenAddress" varchar(42),
      "payTokenDecimals" integer,
      "receiveTokenDecimals" integer,
      "requestedPayAmountRaw" numeric(78, 0),
      "maximumPayAmountRaw" numeric(78, 0),
      "targetReceiveAmountRaw" numeric(78, 0),
      "minimumReceiveAmountRaw" numeric(78, 0),
      "initialDepositAmountRaw" numeric(78, 0),
      "quoteExpiresAt" timestamptz,
      "intentDeadline" timestamptz,
      "permitRequired" integer,
      "permitDeadline" timestamptz,
      "submitState" varchar(32),
      "submittedBlockNumber" numeric(78, 0),
      "seraStatus" varchar(64),
      "intentMatchedAt" timestamptz,
      "intentMatchedTxHash" varchar(66),
      "intentMatchedBlockNumber" numeric(78, 0),
      "provisionalSettlementAt" timestamptz,
      "provisionalSettlementTxHash" varchar(66),
      "provisionalSettlementBlockNumber" numeric(78, 0),
      "provisionalSettlementBlockHash" varchar(66),
      "provisionalSettlementConfirmations" integer,
      "seraOutcomeSyncedAt" timestamptz,
      "actualPayAmountRaw" numeric(78, 0),
      "actualReceiveAmountRaw" numeric(78, 0),
      "feeAmountRaw" numeric(78, 0),
      "feeTokenAddress" varchar(42),
      "settlementTxHash" varchar(66),
      "failureCode" varchar(128),
      "verified" integer NOT NULL DEFAULT 0,
      "notifiedAt" timestamptz,
      "webhookSentAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "checkoutAttemptKey" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "quoteUuid" varchar(128);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "routeUuid" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentHash" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "tradeId" varchar(128);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraVaultAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraSorAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payTokenAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "receiveTokenAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payTokenDecimals" integer;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "receiveTokenDecimals" integer;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "requestedPayAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "maximumPayAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "targetReceiveAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "minimumReceiveAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "initialDepositAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "quoteExpiresAt" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentDeadline" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "permitRequired" integer;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "permitDeadline" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "submitState" varchar(32);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "submittedBlockNumber" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraStatus" varchar(64);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedAt" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedTxHash" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intentMatchedBlockNumber" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementAt" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementTxHash" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementBlockNumber" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementBlockHash" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provisionalSettlementConfirmations" integer;
    DO $provisional_settlement_constraint$ BEGIN
      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_transactions_provisional_settlement_complete'
            AND conrelid = 'transactions'::regclass
      ) THEN
        ALTER TABLE "transactions"
          ADD CONSTRAINT "ck_transactions_provisional_settlement_complete"
          CHECK (
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
          );
      END IF;
    END $provisional_settlement_constraint$;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seraOutcomeSyncedAt" timestamptz;
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "actualPayAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "actualReceiveAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "feeAmountRaw" numeric(78, 0);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "feeTokenAddress" varchar(42);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "settlementTxHash" varchar(66);
    ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "failureCode" varchar(128);

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
    $normalize_checkout_attempt_key$;

    DROP TRIGGER IF EXISTS "trg_normalize_checkout_attempt_key" ON "transactions";
    CREATE TRIGGER "trg_normalize_checkout_attempt_key"
      BEFORE INSERT OR UPDATE OF "checkoutAttemptKey" ON "transactions"
      FOR EACH ROW EXECUTE FUNCTION "normalize_checkout_attempt_key"();

    UPDATE "transactions"
    SET "checkoutAttemptKey" = NULLIF(lower(btrim("checkoutAttemptKey")), '')
    WHERE "checkoutAttemptKey" IS NOT NULL
      AND "checkoutAttemptKey" IS DISTINCT FROM NULLIF(lower(btrim("checkoutAttemptKey")), '');
    ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_txHash_unique";
    ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_txHash_key";
    DROP INDEX IF EXISTS "transactions_txHash_unique";
    DROP INDEX IF EXISTS "transactions_txHash_key";
    CREATE TABLE IF NOT EXISTS "transaction_hash_ownership" (
      "txHash" varchar(66) PRIMARY KEY,
      "ownerKind" varchar(16) NOT NULL,
      "directTransactionId" varchar(36) UNIQUE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "ck_transaction_hash_ownership_hash"
        CHECK ("txHash" ~ '^0x[0-9a-f]{64}$'),
      CONSTRAINT "ck_transaction_hash_ownership_kind"
        CHECK (
          ("ownerKind" = 'direct' AND "directTransactionId" IS NOT NULL)
          OR ("ownerKind" = 'sera' AND "directTransactionId" IS NULL)
      )
    );
    ALTER TABLE "transaction_hash_ownership"
      DROP CONSTRAINT IF EXISTS "transaction_hash_ownership_directTransactionId_transactions_id_fk";
    COMMENT ON TABLE "transaction_hash_ownership" IS
      'Permanent global replay tombstones; Sera batch hashes may have multiple transaction rows';

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
    $normalize_transaction_hashes$;

    DROP TRIGGER IF EXISTS "trg_normalize_transaction_hashes" ON "transactions";
    CREATE TRIGGER "trg_normalize_transaction_hashes"
      BEFORE INSERT OR UPDATE OF "txHash", "settlementTxHash" ON "transactions"
      FOR EACH ROW EXECUTE FUNCTION "normalize_transaction_hashes"();

    UPDATE "transactions"
    SET "txHash" = lower(btrim("txHash"))
    WHERE "txHash" IS NOT NULL AND "txHash" IS DISTINCT FROM lower(btrim("txHash"));
    UPDATE "transactions"
    SET "settlementTxHash" = lower(btrim("settlementTxHash"))
    WHERE "settlementTxHash" IS NOT NULL
      AND "settlementTxHash" IS DISTINCT FROM lower(btrim("settlementTxHash"));

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
        FROM "transactions" direct_tx
        JOIN "transactions" sera_tx
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
          'Cannot install terminal hash ownership: a confirmed direct transfer and Sera settlement share a hash';
      END IF;
    END;
    $validate_transaction_hash_owners$;

    DROP INDEX IF EXISTS "uq_tx_direct_tx_hash";
    CREATE INDEX IF NOT EXISTS "idx_tx_merchant_created" ON "transactions" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_tx_from_address" ON "transactions" ("fromAddress");
    CREATE INDEX IF NOT EXISTS "idx_tx_to_address_created" ON "transactions" ("toAddress", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_tx_status_verified" ON "transactions" ("status", "verified");
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_direct_tx_hash"
      ON "transactions" (lower("txHash"))
      WHERE "intentHash" IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_quote_uuid" ON "transactions" ("quoteUuid");
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_route_uuid" ON "transactions" ("routeUuid");
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_intent_hash" ON "transactions" ("intentHash");
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_trade_id" ON "transactions" ("tradeId");
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tx_active_checkout_attempt_key"
      ON "transactions" (lower(btrim("checkoutAttemptKey")))
      WHERE "checkoutAttemptKey" IS NOT NULL AND "status" IN ('pending', 'confirming');
    CREATE INDEX IF NOT EXISTS "idx_tx_submit_state_updated" ON "transactions" ("submitState", "updatedAt");
    CREATE INDEX IF NOT EXISTS "idx_tx_settlement_hash" ON "transactions" ("settlementTxHash");
    CREATE INDEX IF NOT EXISTS "idx_tx_sera_vault_chain" ON "transactions" ("chainId", "seraVaultAddress");

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
    ON CONFLICT ("txHash") DO NOTHING;
    INSERT INTO "transaction_hash_ownership" ("txHash", "ownerKind", "directTransactionId")
    SELECT "txHash", 'direct', "id"
    FROM "transactions"
    WHERE "intentHash" IS NULL
      AND "status" = 'confirmed'
      AND "verified" = 1
      AND "txHash" ~ '^0x[0-9a-f]{64}$'
    ON CONFLICT ("txHash") DO NOTHING;

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
          'Cannot converge transaction hash ownership: an existing replay tombstone conflicts with a terminal transaction';
      END IF;
    END;
    $validate_transaction_hash_tombstones$;

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
        FROM "transaction_hash_ownership" ownership
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
    $enforce_transaction_hash_ownership$;

    DROP TRIGGER IF EXISTS "trg_enforce_transaction_hash_ownership" ON "transactions";
    CREATE TRIGGER "trg_enforce_transaction_hash_ownership"
      AFTER INSERT OR UPDATE OF
        "txHash", "settlementTxHash", "intentHash", "quoteUuid", "status", "verified", "submitState"
      ON "transactions"
      FOR EACH ROW EXECUTE FUNCTION "enforce_transaction_hash_ownership"();

    CREATE TABLE IF NOT EXISTS "menus" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "name" varchar(120) NOT NULL,
      "description" varchar(500),
      "businessCategory" varchar(80),
      "businessCategoryOther" varchar(120),
      "slug" varchar(80) NOT NULL UNIQUE,
      "isActive" integer NOT NULL DEFAULT 1,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "businessCategory" varchar(80);
    ALTER TABLE "menus" ADD COLUMN IF NOT EXISTS "businessCategoryOther" varchar(120);
    CREATE INDEX IF NOT EXISTS "idx_menus_merchant" ON "menus" ("merchantId");

    CREATE TABLE IF NOT EXISTS "menu_items" (
      "id" varchar(36) PRIMARY KEY,
      "menuId" varchar(36) NOT NULL REFERENCES "menus" ("id") ON DELETE CASCADE,
      "name" varchar(120) NOT NULL,
      "description" varchar(500),
      "itemCode" varchar(64),
      "price" numeric(20, 6) NOT NULL,
      "coin" varchar(20) NOT NULL DEFAULT 'USDC',
      "imageUrl" varchar(512),
      "category" varchar(60),
      "sortOrder" integer NOT NULL DEFAULT 0,
      "isActive" integer NOT NULL DEFAULT 1,
      "soldOutUntil" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "itemCode" varchar(64);
    ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "soldOutUntil" timestamptz;
    CREATE INDEX IF NOT EXISTS "idx_menu_items_menu" ON "menu_items" ("menuId");

    CREATE TABLE IF NOT EXISTS "menu_orders" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "menuId" varchar(36) NOT NULL REFERENCES "menus" ("id") ON DELETE CASCADE,
      "paymentId" varchar(36),
      "paymentIntentId" varchar(36),
      "transactionId" varchar(36) REFERENCES "transactions" ("id") ON DELETE SET NULL,
      "status" varchar(24) NOT NULL DEFAULT 'created',
      "pax" integer NOT NULL DEFAULT 1,
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
      "orderedAt" timestamptz NOT NULL DEFAULT now(),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'menu_orders' AND column_name = 'orders'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'menu_orders' AND column_name = 'items'
      ) THEN
        ALTER TABLE "menu_orders" RENAME COLUMN "orders" TO "items";
      END IF;
    END $$;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "paymentId" varchar(36);
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "paymentIntentId" varchar(36);
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "transactionId" varchar(36);
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "status" varchar(24) NOT NULL DEFAULT 'created';
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "pax" integer NOT NULL DEFAULT 1;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "businessCategory" varchar(80);
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_1" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_2" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_3" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_4" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_5" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "category_6" text;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "items" text NOT NULL DEFAULT '[]';
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "amount" numeric(20, 6) NOT NULL DEFAULT 0;
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "coin" varchar(20) NOT NULL DEFAULT 'USDC';
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "customerName" varchar(120);
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "orderedAt" timestamptz NOT NULL DEFAULT now();
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "createdAt" timestamptz NOT NULL DEFAULT now();
    ALTER TABLE "menu_orders" ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS "idx_menu_orders_merchant_created" ON "menu_orders" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_menu_orders_menu_created" ON "menu_orders" ("menuId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_menu_orders_payment" ON "menu_orders" ("paymentId");

    CREATE TABLE IF NOT EXISTS "webhook_logs" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "txId" varchar(36) NOT NULL,
      "txHash" varchar(66),
      "url" varchar(512) NOT NULL,
      "statusCode" integer,
      "success" integer NOT NULL DEFAULT 0,
      "responseBody" text,
      "error" text,
      "sentAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_wh_logs_merchant" ON "webhook_logs" ("merchantId", "sentAt");

    CREATE TABLE IF NOT EXISTS "api_key_configs" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL UNIQUE REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "seraApiBaseUrl" varchar(255) NOT NULL DEFAULT 'https://api.sera.cx/api/v1',
      "seraApiKeyEncrypted" text,
      "seraApiKeyLast4" varchar(12),
      "seraWebhookSecretEncrypted" text,
      "seraWebhookSecretLast4" varchar(12),
      "mode" varchar(20) NOT NULL DEFAULT 'live',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_api_key_configs_merchant" ON "api_key_configs" ("merchantId");
    -- Converge databases created before mainnet became the default. 'mock' was
    -- the old resting state for every merchant who never opened the Sera API
    -- settings, and it resolved to Sepolia throughout the client.
    ALTER TABLE "api_key_configs" ALTER COLUMN "mode" SET DEFAULT 'live';
    UPDATE "api_key_configs" SET "mode" = 'live' WHERE "mode" = 'mock';
    UPDATE "api_key_configs" SET "seraApiBaseUrl" = 'https://api.sera.cx/api/v1'
      WHERE "mode" <> 'test' AND "seraApiBaseUrl" <> 'https://api.sera.cx/api/v1';

    CREATE TABLE IF NOT EXISTS "sub_wallets" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "label" varchar(120) NOT NULL,
      "address" varchar(42) NOT NULL,
      "chainId" integer NOT NULL DEFAULT 1,
      "receiveCoin" varchar(20) DEFAULT 'USDC',
      "status" varchar(20) NOT NULL DEFAULT 'active',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_sub_wallets_merchant" ON "sub_wallets" ("merchantId");
    CREATE INDEX IF NOT EXISTS "idx_sub_wallets_address" ON "sub_wallets" ("address");

    CREATE TABLE IF NOT EXISTS "payment_intents" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "subWalletId" varchar(36),
      "amount" numeric(36, 18) NOT NULL,
      "coin" varchar(20) NOT NULL,
      "receiverAddress" varchar(42) NOT NULL,
      "chainId" integer NOT NULL DEFAULT 1,
      "customerEmail" varchar(320),
      "customerName" varchar(120),
      "description" varchar(500),
      "metadata" text,
      "checkoutUrl" varchar(1024) NOT NULL,
      "status" varchar(20) NOT NULL DEFAULT 'created',
      "transactionId" varchar(36),
      "expiresAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "transactionId" varchar(36);
    CREATE INDEX IF NOT EXISTS "idx_payment_intents_merchant_created" ON "payment_intents" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_payment_intents_status" ON "payment_intents" ("status");
    CREATE INDEX IF NOT EXISTS "idx_payment_intents_transaction" ON "payment_intents" ("transactionId");

    CREATE TABLE IF NOT EXISTS "sera_api_request_logs" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36),
      "seraApiBaseUrl" varchar(255) NOT NULL,
      "endpoint" varchar(160) NOT NULL,
      "method" varchar(10) NOT NULL,
      "authMode" varchar(20) NOT NULL DEFAULT 'none',
      "requestQuery" text,
      "requestBody" text,
      "responseStatus" integer,
      "responseBody" text,
      "errorMessage" text,
      "durationMs" integer NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_sera_api_logs_merchant_created" ON "sera_api_request_logs" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_sera_api_logs_endpoint_created" ON "sera_api_request_logs" ("endpoint", "createdAt");

    CREATE TABLE IF NOT EXISTS "compliance_screening_logs" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36),
      "address" varchar(80) NOT NULL,
      "provider" varchar(40) NOT NULL,
      "checkType" varchar(40) NOT NULL,
      "status" varchar(20) NOT NULL,
      "responseStatus" integer,
      "responseBody" text,
      "errorMessage" text,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_compliance_logs_merchant_created" ON "compliance_screening_logs" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_compliance_logs_address_created" ON "compliance_screening_logs" ("address", "createdAt");
  `;
  await pool.query(sql);
  _pgSchemaReady = true;
}

/*
  In-flight creation, shared by every caller.

  Creating the pool is not atomic: there is an await on ensurePostgresSchema
  between building the pool and finishing with it. Without this, a second
  request arriving in that window saw a non-null _pgPool and used it straight
  away — before CREATE TABLE had run, and worse, it could hand that pool to
  drizzle and cache it in _db. If the first caller's setup then failed it called
  end() on the very pool _db had just captured, and since _db is never
  reassigned, every write for the rest of the process died on "Cannot use a pool
  after calling end on the pool" — a message no retry recognises.

  One promise, awaited by everyone, and _pgPool published only once setup has
  actually succeeded.
*/
let _pgPoolPromise: Promise<pg.Pool | null> | null = null;

async function getPostgresPool(): Promise<pg.Pool | null> {
  if (_pgPool) return _pgPool;
  if (_pgUnavailableReason && Date.now() < _pgUnavailableUntil) {
    if (ENV.isProduction) throw productionDatabaseUnavailableError(_pgUnavailableReason);
    return null;
  }
  if (!process.env.DATABASE_URL || !isPostgresDatabaseUrl(process.env.DATABASE_URL)) {
    if (ENV.isProduction) throw productionDatabaseUnavailableError("DATABASE_URL is missing or invalid");
    return null;
  }
  if (!_pgPoolPromise) {
    _pgPoolPromise = createPostgresPool().finally(() => { _pgPoolPromise = null; });
  }
  const pool = await _pgPoolPromise;
  if (!pool && ENV.isProduction) {
    throw productionDatabaseUnavailableError(_pgUnavailableReason || "PostgreSQL connection failed");
  }
  return pool;
}

function productionDatabaseUnavailableError(reason: string): Error & { code: string } {
  return Object.assign(new Error(`Production database is unavailable: ${reason}`), {
    code: "DATABASE_UNAVAILABLE",
  });
}

/**
 * Production payment attempts may never fall back to process-local Maps. The
 * startup probe also proves the Phase 1 payment-intent enum migration is
 * visible before this replica begins accepting traffic.
 */
export async function assertProductionDatabaseReady(): Promise<void> {
  if (!ENV.isProduction) return;
  const pool = await getPostgresPool();
  if (!pool) throw productionDatabaseUnavailableError("PostgreSQL connection failed");
  await pool.query("SELECT 1");
  await pool.query("SELECT 'processing'::payment_intent_status");
  await pool.query(`SELECT "provisionalSettlementAt", "provisionalSettlementBlockHash" FROM "transactions" LIMIT 0`);
}

async function createPostgresPool(): Promise<pg.Pool | null> {
  let pool: pg.Pool | null = null;
  {
    try {
      /*
        Tuned for a high-latency link rather than a local socket. The database
        is reached over a relay at roughly 200ms round trip, and a Postgres
        handshake costs several round trips before the first query, so a fresh
        connection runs to about a second even when everything is healthy.

        - connectionTimeoutMillis: 5s left almost no headroom once the relay was
          congested, which is what produced "Connection terminated due to
          connection timeout" during an ordinary page refresh.
        - idleTimeoutMillis: the node-postgres default of 10s retired warm
          connections between page loads, so a merchant returning half a minute
          later paid the full handshake again on every one of them.
        - keepAlive: stops a relay or NAT dropping an idle connection silently
          and leaving the pool holding one that is already dead.
      */
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 60_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      });
      pool.on("error", (error) => {
        console.warn("[Database] PostgreSQL pool error");
      });
      await ensurePostgresSchema(pool);
      // Only now is it safe for anyone else to see it.
      _pgPool = pool;
      // Back in service: let a later failure start its own cooldown.
      _pgUnavailableReason = null;
      _pgUnavailableUntil = 0;
    } catch (error) {
      _pgUnavailableReason = error instanceof Error ? error.message : String(error);
      _pgUnavailableUntil = Date.now() + PG_UNAVAILABLE_COOLDOWN_MS;
      // Name the cause. Falling back to in-memory means every merchant and API
      // key silently reads as missing, so the reason for it must not be a
      // mystery. Message only, no stack and no driver object, since those can
      // carry the host and credentials.
      console.warn(`[Database] PostgreSQL unavailable; ${ENV.isProduction ? "refusing production traffic" : "using in-memory fallback"}`, {
        reason: _pgUnavailableReason.slice(0, 200),
      });
      await pool?.end().catch(() => undefined);
      _pgPool = null;
      // The cached drizzle handle may wrap the pool just ended. Drop it so the
      // next caller rebuilds against a live one instead of a dead one.
      _db = null;
      return null;
    }
  }
  return _pgPool;
}

async function pgSelectOne<T>(pool: pg.Pool, table: string, where: string, values: unknown[]): Promise<T | undefined> {
  const sql = `SELECT * FROM ${q(table)} WHERE ${where} LIMIT 1`;
  try {
    const result = await pool.query(sql, values);
    return result.rows[0] as T | undefined;
  } catch (error) {
    // One retry, and only for a dropped or timed-out connection. A SELECT is
    // idempotent, so re-running it is safe; a single blip on the relay should
    // not reach the merchant as "Database is temporarily unavailable".
    if (!isTransientConnectionError(error)) throw error;
    const result = await pool.query(sql, values);
    return result.rows[0] as T | undefined;
  }
}

async function pgInsert(pool: pg.Pool, table: string, data: Record<string, unknown>) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => q(key)).join(", ");
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");
  const values = entries.map(([, value]) => normalizeDbValue(value));
  await pool.query(`INSERT INTO ${q(table)} (${columns}) VALUES (${placeholders})`, values);
}

async function pgUpdate(pool: pg.Pool, table: string, id: string, data: Record<string, unknown>) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
  const values = entries.map(([, value]) => normalizeDbValue(value));
  values.push(id);
  await pool.query(`UPDATE ${q(table)} SET ${set}, "updatedAt" = now() WHERE "id" = $${values.length}`, values);
}

export async function getDb() {
  if (_db) return _db;
  if (process.env.DATABASE_URL && !isPostgresDatabaseUrl(process.env.DATABASE_URL)) {
    console.warn("[Database] Unsupported DATABASE_URL protocol. This project expects PostgreSQL.");
    if (ENV.isProduction) throw productionDatabaseUnavailableError("DATABASE_URL uses an unsupported protocol");
    return null;
  }
  const pool = await getPostgresPool();
  if (!pool) return null;
  _db = drizzle(pool);
  return _db;
}

// ─── User helpers ────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod", "privyWallet", "userWallet", "walletType"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: { ...updateSet, updatedAt: new Date() },
    });
  } catch (error) { console.error("[Database] Failed to upsert user"); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateUserNameByWallet(walletAddress: string, name: string): Promise<void> {
  const normalizedWallet = walletAddress.toLowerCase();
  const trimmedName = name.trim().slice(0, 120);
  if (!normalizedWallet || !trimmedName) return;

  const pgPool = await getPostgresPool();
  if (pgPool) {
    await pgPool.query(
      `UPDATE "users" SET "name" = $1, "updatedAt" = now() WHERE lower("privy_wallet") = $2 OR lower("user_wallet") = $2`,
      [trimmedName, normalizedWallet],
    );
    return;
  }

  const db = await getDb();
  if (!db) return;
  await db.update(users)
    .set({ name: trimmedName, updatedAt: new Date() })
    .where(or(eq(users.privyWallet, normalizedWallet), eq(users.userWallet, normalizedWallet)));
}

// ─── Merchant helpers ─────────────────────────────────────────────────────────

export async function getMerchantByWallet(walletAddress: string): Promise<Merchant | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Merchant>(pgPool, "merchants", `"walletAddress" = $1`, [walletAddress.toLowerCase()]);
  const db = await getDb();
  if (!db) return Array.from(memory.merchants.values()).find((m) => m.walletAddress === walletAddress.toLowerCase());
  const result = await db.select().from(merchants).where(eq(merchants.walletAddress, walletAddress.toLowerCase())).limit(1);
  return result[0];
}

export async function getMerchantByStoreAddress(storeAddress: string): Promise<Merchant | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Merchant>(pgPool, "merchants", `"storeAddress" = $1`, [storeAddress.toLowerCase()]);
  const db = await getDb();
  if (!db) return Array.from(memory.merchants.values()).find((m) => m.storeAddress === storeAddress.toLowerCase());
  const result = await db.select().from(merchants).where(eq(merchants.storeAddress, storeAddress.toLowerCase())).limit(1);
  return result[0];
}

/**
 * SHA-256 of a merchant API key — the only form ever persisted. The raw key
 * exists at creation/regeneration time and in the merchant's own systems.
 */
export function hashMerchantApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export async function getMerchantByApiKey(apiKey: string): Promise<Merchant | undefined> {
  if (typeof apiKey !== "string" || !apiKey) return undefined;
  const apiKeyHash = hashMerchantApiKey(apiKey);
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Merchant>(pgPool, "merchants", `"apiKeyHash" = $1`, [apiKeyHash]);
  const db = await getDb();
  if (!db) return Array.from(memory.merchants.values()).find((m) => m.apiKeyHash === apiKeyHash);
  const result = await db.select().from(merchants).where(eq(merchants.apiKeyHash, apiKeyHash)).limit(1);
  return result[0];
}

export async function getMerchantById(id: string): Promise<Merchant | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Merchant>(pgPool, "merchants", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.merchants.get(id);
  const result = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
  return result[0];
}

export async function createMerchant(data: InsertMerchant): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "merchants", data); return; }
  const db = await getDb();
  if (!db) { memory.merchants.set(data.id, withTimestamps(data) as Merchant); return; }
  await db.insert(merchants).values(data);
}

export async function updateMerchant(id: string, data: Partial<InsertMerchant>): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgUpdate(pgPool, "merchants", id, data); return; }
  const db = await getDb();
  if (!db) {
    const existing = memory.merchants.get(id);
    if (existing) memory.merchants.set(id, { ...existing, ...data, updatedAt: now() } as Merchant);
    return;
  }
  await db.update(merchants).set(data).where(eq(merchants.id, id));
}

// ─── Transaction helpers ──────────────────────────────────────────────────────

export async function createTransaction(data: InsertTransaction): Promise<void> {
  const normalizedData = normalizeTransactionFields(data);
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "transactions", normalizedData); return; }
  const db = await getDb();
  if (!db) {
    const transaction = withTimestamps(normalizedData) as Transaction;
    assertMemoryTerminalHashOwnership(transaction);
    assertMemoryActiveCheckoutAttemptOwnership(transaction);
    memory.transactions.set(normalizedData.id, transaction);
    return;
  }
  await db.insert(transactions).values(normalizedData);
}

export type CreateDirectTransactionReservationResult =
  | { outcome: "created"; transaction: Transaction }
  | {
      outcome: "binding_conflict";
      resource: "menu_order" | "payment_intent";
      resourceId: string;
    };

/**
 * Direct ERC-20 payments have no later off-chain submit step at which to claim
 * a checkout: the wallet broadcasts first. Reserve the linked obligation in
 * the same commit that creates its watch row, so a Sera attempt cannot claim
 * it while the transfer is already on its way.
 */
export async function createDirectTransactionWithReservation(input: {
  transaction: InsertTransaction;
  orderId?: string | null;
  paymentIntentId?: string | null;
  now?: Date;
}): Promise<CreateDirectTransactionReservationResult> {
  const normalizedData = normalizeTransactionFields(input.transaction);
  const checkTime = input.now ?? new Date();
  const candidate = withTimestamps(normalizedData) as Transaction;
  if (
    candidate.intentHash != null
    || candidate.status !== "pending"
    || candidate.verified !== 0
  ) throw new Error("Direct reservation requires a pending, unverified direct transaction");

  const validateOrder = async (
    order: MenuOrder | undefined,
    loadPreviousOwner: (id: string) => Promise<Transaction | undefined>,
  ) => {
    const previousOwnerId = order ? menuOrderSubmissionOwnerId(order, candidate.id) : null;
    const previousOwner = previousOwnerId && previousOwnerId !== "conflict"
      ? await loadPreviousOwner(previousOwnerId)
      : undefined;
    return Boolean(order && canClaimMenuOrderForSeraSubmission(order, candidate, previousOwner));
  };
  const validateIntent = async (
    intent: PaymentIntent | undefined,
    loadPreviousOwner: (id: string) => Promise<Transaction | undefined>,
  ) => {
    const previousOwner = intent?.transactionId && intent.transactionId !== candidate.id
      ? await loadPreviousOwner(intent.transactionId)
      : undefined;
    return Boolean(intent && canClaimPaymentIntentForSeraSubmission(intent, candidate, previousOwner, checkTime));
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      let order: MenuOrder | undefined;
      if (input.orderId) {
        order = (await client.query(`SELECT * FROM "menu_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]))
          .rows[0] as MenuOrder | undefined;
        if (!await validateOrder(order, async (id) => (
          await client.query(`SELECT * FROM "transactions" WHERE "id" = $1`, [id])
        ).rows[0] as Transaction | undefined)) {
          await client.query("ROLLBACK");
          return { outcome: "binding_conflict", resource: "menu_order", resourceId: input.orderId };
        }
      }
      let paymentIntent: PaymentIntent | undefined;
      if (input.paymentIntentId) {
        paymentIntent = (await client.query(
          `SELECT * FROM "payment_intents" WHERE "id" = $1 FOR UPDATE`,
          [input.paymentIntentId],
        )).rows[0] as PaymentIntent | undefined;
        if (!await validateIntent(paymentIntent, async (id) => (
          await client.query(`SELECT * FROM "transactions" WHERE "id" = $1`, [id])
        ).rows[0] as Transaction | undefined)) {
          await client.query("ROLLBACK");
          return { outcome: "binding_conflict", resource: "payment_intent", resourceId: input.paymentIntentId };
        }
      }
      const entries = Object.entries(normalizedData).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => q(key)).join(", ");
      const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");
      const values = entries.map(([, value]) => normalizeDbValue(value));
      const transaction = (await client.query(
        `INSERT INTO "transactions" (${columns}) VALUES (${placeholders}) RETURNING *`,
        values,
      )).rows[0] as Transaction;
      if (order) {
        await client.query(
          `UPDATE "menu_orders"
           SET "status" = 'payment_pending', "paymentId" = $1,
               "transactionId" = $1, "updatedAt" = now()
           WHERE "id" = $2 AND "merchantId" = $3`,
          [transaction.id, order.id, transaction.merchantId],
        );
      }
      if (paymentIntent) {
        await client.query(
          `UPDATE "payment_intents"
           SET "status" = 'processing', "transactionId" = $1, "updatedAt" = now()
           WHERE "id" = $2 AND "merchantId" = $3`,
          [transaction.id, paymentIntent.id, transaction.merchantId],
        );
      }
      await client.query("COMMIT");
      return { outcome: "created", transaction };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<CreateDirectTransactionReservationResult> => {
      let order: MenuOrder | undefined;
      if (input.orderId) {
        order = (await database.select().from(menuOrders)
          .where(eq(menuOrders.id, input.orderId)).limit(1).for("update"))[0] as MenuOrder | undefined;
        if (!await validateOrder(order, async (id) => (await database.select().from(transactions)
          .where(eq(transactions.id, id)).limit(1))[0] as Transaction | undefined)) {
          return { outcome: "binding_conflict", resource: "menu_order", resourceId: input.orderId };
        }
      }
      let paymentIntent: PaymentIntent | undefined;
      if (input.paymentIntentId) {
        paymentIntent = (await database.select().from(paymentIntents)
          .where(eq(paymentIntents.id, input.paymentIntentId)).limit(1).for("update"))[0] as PaymentIntent | undefined;
        if (!await validateIntent(paymentIntent, async (id) => (await database.select().from(transactions)
          .where(eq(transactions.id, id)).limit(1))[0] as Transaction | undefined)) {
          return { outcome: "binding_conflict", resource: "payment_intent", resourceId: input.paymentIntentId };
        }
      }
      const transaction = (await database.insert(transactions).values(normalizedData).returning())[0] as Transaction;
      if (order) await database.update(menuOrders).set({
        status: "payment_pending",
        paymentId: transaction.id,
        transactionId: transaction.id,
        updatedAt: new Date(),
      }).where(eq(menuOrders.id, order.id));
      if (paymentIntent) await database.update(paymentIntents).set({
        status: "processing",
        transactionId: transaction.id,
        updatedAt: new Date(),
      }).where(eq(paymentIntents.id, paymentIntent.id));
      return { outcome: "created", transaction };
    });
  }

  const order = input.orderId ? memory.menuOrders.get(input.orderId) : undefined;
  if (input.orderId && !await validateOrder(order, async (id) => memory.transactions.get(id))) {
    return { outcome: "binding_conflict", resource: "menu_order", resourceId: input.orderId };
  }
  const paymentIntent = input.paymentIntentId ? memory.paymentIntents.get(input.paymentIntentId) : undefined;
  if (input.paymentIntentId && !await validateIntent(paymentIntent, async (id) => memory.transactions.get(id))) {
    return { outcome: "binding_conflict", resource: "payment_intent", resourceId: input.paymentIntentId };
  }
  assertMemoryTerminalHashOwnership(candidate);
  assertMemoryActiveCheckoutAttemptOwnership(candidate);
  memory.transactions.set(candidate.id, candidate);
  if (order) memory.menuOrders.set(order.id, {
    ...order,
    status: "payment_pending",
    paymentId: candidate.id,
    transactionId: candidate.id,
    updatedAt: now(),
  } as MenuOrder);
  if (paymentIntent) memory.paymentIntents.set(paymentIntent.id, {
    ...paymentIntent,
    status: "processing",
    transactionId: candidate.id,
    updatedAt: now(),
  } as PaymentIntent);
  return { outcome: "created", transaction: candidate };
}

export async function getTransactionById(id: string): Promise<Transaction | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.transactions.get(id);
  const result = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
  return result[0];
}

/**
 * Recover the one nonterminal Sera transaction owned by a durable browser
 * checkout attempt. Direct-transfer rows are deliberately excluded even if a
 * caller accidentally supplies a checkout key.
 */
export async function getActiveSeraSwapTransactionByCheckoutAttemptKey(
  checkoutAttemptKey: string,
): Promise<Transaction | undefined> {
  const normalized = normalizeCheckoutAttemptKey(checkoutAttemptKey);
  if (!normalized) return undefined;

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions"
       WHERE lower(btrim("checkoutAttemptKey")) = $1
         AND "status" IN ('pending', 'confirming')
         AND ("quoteUuid" IS NOT NULL OR "intentHash" IS NOT NULL)
       ORDER BY "createdAt" ASC, "id" ASC
       LIMIT 1`,
      [normalized],
    );
    return result.rows[0] as Transaction | undefined;
  }

  const db = await getDb();
  if (!db) {
    return Array.from(memory.transactions.values())
      .filter((transaction) => (
        isActiveCheckoutAttemptOwner(transaction)
        && (transaction.quoteUuid != null || transaction.intentHash != null)
        && normalizeCheckoutAttemptKey(transaction.checkoutAttemptKey) === normalized
      ))
      .sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id)
      ))[0];
  }

  const result = await db.select().from(transactions).where(and(
    sql`lower(btrim(${transactions.checkoutAttemptKey})) = ${normalized}`,
    or(eq(transactions.status, "pending"), eq(transactions.status, "confirming")),
    or(isNotNull(transactions.quoteUuid), isNotNull(transactions.intentHash)),
  )).orderBy(asc(transactions.createdAt), asc(transactions.id)).limit(1);
  return result[0];
}

export async function getTransactionByHash(txHash: string): Promise<Transaction | undefined> {
  const normalized = txHash.trim().toLowerCase();
  if (!normalized) return undefined;
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions"
       WHERE lower("txHash") = $1
       ORDER BY CASE WHEN "status" = 'confirmed' AND "verified" = 1 THEN 0 ELSE 1 END,
         "createdAt" ASC, "id" ASC
       LIMIT 1`,
      [normalized],
    );
    return result.rows[0] as Transaction | undefined;
  }
  const db = await getDb();
  if (!db) {
    return Array.from(memory.transactions.values())
      .filter((tx) => tx.txHash?.toLowerCase() === normalized)
      .sort((left, right) => {
        const leftTerminal = left.status === "confirmed" && left.verified === 1 ? 0 : 1;
        const rightTerminal = right.status === "confirmed" && right.verified === 1 ? 0 : 1;
        return leftTerminal - rightTerminal
          || left.createdAt.getTime() - right.createdAt.getTime()
          || left.id.localeCompare(right.id);
      })[0];
  }
  const result = await db.select().from(transactions)
    .where(sql`lower(${transactions.txHash}) = ${normalized}`)
    .orderBy(
      sql`CASE WHEN ${transactions.status} = 'confirmed' AND ${transactions.verified} = 1 THEN 0 ELSE 1 END`,
      asc(transactions.createdAt),
      asc(transactions.id),
    )
    .limit(1);
  return result[0];
}

export async function getTransactionBySeraQuoteUuid(quoteUuid: string): Promise<Transaction | undefined> {
  const normalized = quoteUuid.trim();
  if (!normalized) return undefined;
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `"quoteUuid" = $1`, [normalized]);
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values()).find((tx) => tx.quoteUuid === normalized);
  const result = await db.select().from(transactions).where(eq(transactions.quoteUuid, normalized)).limit(1);
  return result[0];
}

export async function getTransactionBySeraIntentHash(intentHash: string): Promise<Transaction | undefined> {
  const normalized = intentHash.trim().toLowerCase();
  if (!normalized) return undefined;
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `lower("intentHash") = $1`, [normalized]);
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values()).find((tx) => tx.intentHash?.toLowerCase() === normalized);
  const result = await db.select().from(transactions).where(eq(transactions.intentHash, normalized)).limit(1);
  return result[0];
}

export async function getTransactionBySeraTradeId(tradeId: string): Promise<Transaction | undefined> {
  const normalized = tradeId.trim();
  if (!normalized) return undefined;
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `"tradeId" = $1`, [normalized]);
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values()).find((tx) => tx.tradeId === normalized);
  const result = await db.select().from(transactions).where(eq(transactions.tradeId, normalized)).limit(1);
  return result[0];
}

/**
 * Return every quote-time Sera Vault recorded for a chain. Keeping historical
 * deployments in this set lets direct-transfer scanners exclude Vault payouts
 * safely across Sera config rotations, including unresolved older swaps.
 */
export async function getSeraVaultAddressesForChain(chainId: number): Promise<string[]> {
  if (!Number.isInteger(chainId) || chainId <= 0) return [];

  let values: unknown[];
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT DISTINCT lower("seraVaultAddress") AS address
       FROM "transactions"
       WHERE "chainId" = $1 AND "seraVaultAddress" IS NOT NULL`,
      [chainId],
    );
    values = result.rows.map((row: { address?: unknown }) => row.address);
  } else {
    const db = await getDb();
    if (!db) {
      values = Array.from(memory.transactions.values())
        .filter((transaction) => transaction.chainId === chainId)
        .map((transaction) => transaction.seraVaultAddress);
    } else {
      const result = await db.selectDistinct({ address: transactions.seraVaultAddress })
        .from(transactions)
        .where(and(
          eq(transactions.chainId, chainId),
          isNotNull(transactions.seraVaultAddress),
        ));
      values = result.map((row: { address?: unknown }) => row.address);
    }
  }

  return Array.from(new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const normalized = value.trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(normalized) ? [normalized] : [];
  }))).sort();
}

export async function updateTransaction(id: string, data: Partial<InsertTransaction>): Promise<void> {
  const normalizedData = normalizeTransactionFields(data);
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgUpdate(pgPool, "transactions", id, normalizedData); return; }
  const db = await getDb();
  if (!db) {
    const existing = memory.transactions.get(id);
    if (existing) {
      const updated = { ...existing, ...normalizedData, updatedAt: now() } as Transaction;
      assertMemoryTerminalHashOwnership(updated);
      assertMemoryActiveCheckoutAttemptOwnership(updated);
      memory.transactions.set(id, updated);
    }
    return;
  }
  await db.update(transactions).set(normalizedData).where(eq(transactions.id, id));
}

function linkedMenuOrderIdFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    const orderId = typeof parsed.orderId === "string" ? parsed.orderId.trim() : "";
    return orderId || null;
  } catch {
    return null;
  }
}

export type ClaimDirectTransactionNotificationInput = {
  transactionId: string;
  txHash: string;
};

export type DirectTransactionNotificationDecision =
  | "claimable"
  | "already_claimed"
  | "not_found"
  | "invalid_state"
  | "hash_conflict";

export type ClaimDirectTransactionNotificationResult =
  | { outcome: "claimed" | "already_claimed"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined }
  | { outcome: "invalid_state" | "hash_conflict"; transaction: Transaction }
  | {
      outcome: "binding_conflict";
      transaction: Transaction;
      resource: "menu_order" | "payment_intent";
      resourceId: string;
      orderId?: string;
      paymentIntentId?: string;
    };

export function classifyDirectTransactionNotification(
  transaction: Transaction | undefined,
  txHash: string,
): DirectTransactionNotificationDecision {
  if (!transaction) return "not_found";
  const normalizedHash = txHash.trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(normalizedHash)) return "hash_conflict";
  if (transaction.intentHash != null || transaction.verified !== 0) return "invalid_state";

  const storedHash = transaction.txHash?.trim().toLowerCase() ?? null;
  if (storedHash != null && storedHash !== normalizedHash) return "hash_conflict";
  if (transaction.status === "pending" && storedHash == null) return "claimable";
  if (transaction.status === "confirming" && storedHash === normalizedHash) return "already_claimed";
  return "invalid_state";
}

function directNotificationOrderHasBindingConflict(order: MenuOrder, transaction: Transaction): boolean {
  const ownedByCurrent = order.paymentId === transaction.id || order.transactionId === transaction.id;
  const payableStatus = order.status === "created"
    || order.status === "payment_pending"
    || order.status === "failed"
    || (order.status === "payment_submitted" && ownedByCurrent);
  return !payableStatus
    || order.merchantId !== transaction.merchantId
    || (order.paymentId != null && order.paymentId !== transaction.id)
    || (order.transactionId != null && order.transactionId !== transaction.id)
    || order.status === "paid";
}

/**
 * Atomically accepts a direct-payment notification and binds its linked menu
 * order. This replaces the old two-write route sequence, which could leave a
 * transaction claimed while an order had concurrently moved to a Sera row.
 */
export async function claimDirectTransactionNotification(
  input: ClaimDirectTransactionNotificationInput,
): Promise<ClaimDirectTransactionNotificationResult> {
  const transactionId = input.transactionId.trim();
  const txHash = input.txHash.trim().toLowerCase();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  if (!TRANSACTION_HASH_PATTERN.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transactionResult = await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [transactionId],
      );
      const transaction = transactionResult.rows[0] as Transaction | undefined;
      const decision = classifyDirectTransactionNotification(transaction, txHash);
      if (decision === "not_found") {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (decision !== "claimable" && decision !== "already_claimed") {
        await client.query("ROLLBACK");
        return { outcome: decision, transaction: transaction! };
      }

      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      const orderId = references.orderId;
      let order: MenuOrder | undefined;
      if (orderId != null) {
        const orderResult = await client.query(
          `SELECT * FROM "menu_orders" WHERE "id" = $1 FOR UPDATE`,
          [orderId],
        );
        order = orderResult.rows[0] as MenuOrder | undefined;
        if (!order || directNotificationOrderHasBindingConflict(order, transaction!)) {
          await client.query("ROLLBACK");
          return {
            outcome: "binding_conflict",
            transaction: transaction!,
            resource: "menu_order",
            resourceId: orderId,
            orderId,
          };
        }
      }

      let paymentIntent: PaymentIntent | undefined;
      if (references.paymentIntentId) {
        paymentIntent = (await client.query(
          `SELECT * FROM "payment_intents" WHERE "id" = $1 FOR UPDATE`,
          [references.paymentIntentId],
        )).rows[0] as PaymentIntent | undefined;
        const previousOwner = paymentIntent?.transactionId && paymentIntent.transactionId !== transaction!.id
          ? (await client.query(
              `SELECT * FROM "transactions" WHERE "id" = $1`,
              [paymentIntent.transactionId],
            )).rows[0] as Transaction | undefined
          : undefined;
        if (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(
          paymentIntent,
          transaction!,
          previousOwner,
          new Date(),
        )) {
          await client.query("ROLLBACK");
          return {
            outcome: "binding_conflict",
            transaction: transaction!,
            resource: "payment_intent",
            resourceId: references.paymentIntentId,
            paymentIntentId: references.paymentIntentId,
          };
        }
      }

      const updateResult = await client.query(
        `UPDATE "transactions"
         SET "txHash" = $1, "fromAddress" = NULL, "status" = 'confirming',
           "notifiedAt" = COALESCE("notifiedAt", now()), "updatedAt" = now()
         WHERE "id" = $2 AND "intentHash" IS NULL AND "verified" = 0
           AND (
             ("status" = 'pending' AND "txHash" IS NULL)
             OR ("status" = 'confirming' AND lower("txHash") = $1)
           )
         RETURNING *`,
        [txHash, transactionId],
      );
      const updated = updateResult.rows[0] as Transaction | undefined;
      if (!updated) {
        await client.query("ROLLBACK");
        const current = await getTransactionById(transactionId);
        if (!current) return { outcome: "not_found" };
        const currentDecision = classifyDirectTransactionNotification(current, txHash);
        return {
          outcome: currentDecision === "claimable" || currentDecision === "not_found"
            ? "invalid_state"
            : currentDecision,
          transaction: current,
        };
      }

      if (order) {
        await client.query(
          `UPDATE "menu_orders"
           SET "status" = 'payment_submitted', "paymentId" = $1,
             "transactionId" = $1, "updatedAt" = now()
           WHERE "id" = $2 AND "merchantId" = $3
             AND ("paymentId" IS NULL OR "paymentId" = $1)
             AND ("transactionId" IS NULL OR "transactionId" = $1)`,
          [transactionId, order.id, updated.merchantId],
        );
      }
      if (paymentIntent) {
        await client.query(
          `UPDATE "payment_intents"
           SET "status" = 'processing', "transactionId" = $1, "updatedAt" = now()
           WHERE "id" = $2 AND "merchantId" = $3`,
          [transactionId, paymentIntent.id, updated.merchantId],
        );
      }
      await client.query("COMMIT");
      return { outcome: decision === "already_claimed" ? "already_claimed" : "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!databaseErrorHasConstraint(error, "uq_tx_direct_tx_hash")) throw error;
      const current = await getTransactionById(transactionId);
      return current
        ? { outcome: "hash_conflict", transaction: current }
        : { outcome: "not_found" };
    } finally {
      client.release();
    }
  }

  const db = await getDb();
  if (db) {
    try {
      return await db.transaction(async (database: typeof db) => {
      const rows = await database.select().from(transactions)
        .where(eq(transactions.id, transactionId)).for("update").limit(1);
      const transaction = rows[0] as Transaction | undefined;
      const decision = classifyDirectTransactionNotification(transaction, txHash);
      if (decision === "not_found") return { outcome: "not_found" } as const;
      if (decision !== "claimable" && decision !== "already_claimed") {
        return { outcome: decision, transaction: transaction! } as ClaimDirectTransactionNotificationResult;
      }
      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      const orderId = references.orderId;
      const order = orderId == null
        ? undefined
        : (await database.select().from(menuOrders)
            .where(eq(menuOrders.id, orderId)).for("update").limit(1))[0] as MenuOrder | undefined;
      if (orderId && (!order || directNotificationOrderHasBindingConflict(order, transaction!))) {
        return {
          outcome: "binding_conflict",
          transaction: transaction!,
          resource: "menu_order",
          resourceId: orderId,
          orderId,
        } as const;
      }
      const paymentIntent = references.paymentIntentId == null
        ? undefined
        : (await database.select().from(paymentIntents)
            .where(eq(paymentIntents.id, references.paymentIntentId)).for("update").limit(1))[0] as PaymentIntent | undefined;
      const previousIntentOwner = paymentIntent?.transactionId && paymentIntent.transactionId !== transaction!.id
        ? (await database.select().from(transactions)
            .where(eq(transactions.id, paymentIntent.transactionId)).limit(1))[0] as Transaction | undefined
        : undefined;
      if (references.paymentIntentId && (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(
        paymentIntent,
        transaction!,
        previousIntentOwner,
        new Date(),
      ))) {
        return {
          outcome: "binding_conflict",
          transaction: transaction!,
          resource: "payment_intent",
          resourceId: references.paymentIntentId,
          paymentIntentId: references.paymentIntentId,
        } as const;
      }
      const updatedRows = await database.update(transactions).set({
        txHash,
        fromAddress: null,
        status: "confirming",
        notifiedAt: transaction!.notifiedAt ?? new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(transactions.id, transactionId),
        isNull(transactions.intentHash),
        eq(transactions.verified, 0),
        or(
          and(eq(transactions.status, "pending"), isNull(transactions.txHash)),
          and(eq(transactions.status, "confirming"), sql`lower(${transactions.txHash}) = ${txHash}`),
        ),
      )).returning();
      const updated = updatedRows[0] as Transaction | undefined;
      if (!updated) return { outcome: "invalid_state", transaction: transaction! } as const;
      if (order) {
        await database.update(menuOrders).set({
          status: "payment_submitted",
          paymentId: transactionId,
          transactionId,
          updatedAt: new Date(),
        }).where(and(
          eq(menuOrders.id, order.id),
          eq(menuOrders.merchantId, updated.merchantId),
          or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, transactionId)),
          or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, transactionId)),
        ));
      }
      if (paymentIntent) {
        await database.update(paymentIntents).set({
          status: "processing",
          transactionId,
          updatedAt: new Date(),
        }).where(and(
          eq(paymentIntents.id, paymentIntent.id),
          eq(paymentIntents.merchantId, updated.merchantId),
        ));
      }
        return { outcome: decision === "already_claimed" ? "already_claimed" : "claimed", transaction: updated } as const;
      });
    } catch (error) {
      if (!databaseErrorHasConstraint(error, "uq_tx_direct_tx_hash")) throw error;
      const current = await getTransactionById(transactionId);
      return current
        ? { outcome: "hash_conflict", transaction: current }
        : { outcome: "not_found" };
    }
  }

  const transaction = memory.transactions.get(transactionId);
  const decision = classifyDirectTransactionNotification(transaction, txHash);
  if (decision === "not_found") return { outcome: "not_found" };
  if (decision !== "claimable" && decision !== "already_claimed") {
    return { outcome: decision, transaction: transaction! };
  }
  const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
  const orderId = references.orderId;
  const order = orderId == null ? undefined : memory.menuOrders.get(orderId);
  if (orderId && (!order || directNotificationOrderHasBindingConflict(order, transaction!))) {
    return {
      outcome: "binding_conflict",
      transaction: transaction!,
      resource: "menu_order",
      resourceId: orderId,
      orderId,
    };
  }
  const paymentIntent = references.paymentIntentId == null
    ? undefined
    : memory.paymentIntents.get(references.paymentIntentId);
  const previousIntentOwner = paymentIntent?.transactionId && paymentIntent.transactionId !== transaction!.id
    ? memory.transactions.get(paymentIntent.transactionId)
    : undefined;
  if (references.paymentIntentId && (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(
    paymentIntent,
    transaction!,
    previousIntentOwner,
    new Date(),
  ))) {
    return {
      outcome: "binding_conflict",
      transaction: transaction!,
      resource: "payment_intent",
      resourceId: references.paymentIntentId,
      paymentIntentId: references.paymentIntentId,
    };
  }
  const updated = {
    ...transaction!,
    txHash,
    fromAddress: null,
    status: "confirming",
    notifiedAt: transaction!.notifiedAt ?? now(),
    updatedAt: now(),
  } as Transaction;
  // Match the case-insensitive partial PostgreSQL index for all direct rows.
  for (const existing of memory.transactions.values()) {
    if (
      existing.id !== transactionId
      && existing.intentHash == null
      && existing.txHash?.trim().toLowerCase() === txHash
    ) {
      return { outcome: "hash_conflict", transaction: transaction! };
    }
  }
  memory.transactions.set(transactionId, updated);
  if (order) {
    memory.menuOrders.set(order.id, {
      ...order,
      status: "payment_submitted",
      paymentId: transactionId,
      transactionId,
      updatedAt: now(),
    } as MenuOrder);
  }
  if (paymentIntent) {
    memory.paymentIntents.set(paymentIntent.id, {
      ...paymentIntent,
      status: "processing",
      transactionId,
      updatedAt: now(),
    } as PaymentIntent);
  }
  return { outcome: decision === "already_claimed" ? "already_claimed" : "claimed", transaction: updated };
}

export type ReleaseTentativeDirectTransactionHashResult =
  | { outcome: "released"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined }
  | { outcome: "invalid_state"; transaction: Transaction };

/** Release a Vault-originated false direct notification without touching an order now owned by another payment. */
export async function releaseTentativeDirectTransactionHash(input: {
  transactionId: string;
  txHash: string;
}): Promise<ReleaseTentativeDirectTransactionHashResult> {
  const transactionId = input.transactionId.trim();
  const txHash = input.txHash.trim().toLowerCase();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  if (!TRANSACTION_HASH_PATTERN.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE "transactions"
         SET "status" = 'pending', "txHash" = NULL, "settlementTxHash" = NULL,
           "fromAddress" = NULL, "notifiedAt" = NULL, "updatedAt" = now()
         WHERE "id" = $1 AND "intentHash" IS NULL AND "status" = 'confirming'
           AND "verified" = 0 AND lower("txHash") = $2
         RETURNING *`,
        [transactionId, txHash],
      );
      const transaction = result.rows[0] as Transaction | undefined;
      if (!transaction) {
        const currentResult = await client.query(
          `SELECT * FROM "transactions" WHERE "id" = $1`,
          [transactionId],
        );
        await client.query("ROLLBACK");
        const current = currentResult.rows[0] as Transaction | undefined;
        return current
          ? { outcome: "invalid_state", transaction: current }
          : { outcome: "not_found" };
      }
      await client.query(
        `UPDATE "menu_orders"
         SET "status" = 'payment_pending', "updatedAt" = now()
         WHERE "merchantId" = $1 AND "status" <> 'paid'
           AND ("paymentId" = $2 OR "transactionId" = $2)`,
        [transaction.merchantId, transactionId],
      );
      await client.query(
        `UPDATE "payment_intents"
         SET "status" = 'open', "updatedAt" = now()
         WHERE "merchantId" = $1 AND "transactionId" = $2
           AND "status" = 'processing'`,
        [transaction.merchantId, transactionId],
      );
      await client.query("COMMIT");
      return { outcome: "released", transaction };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await getDb();
  if (db) {
    return db.transaction(async (database: typeof db) => {
      const result = await database.update(transactions).set({
        status: "pending",
        txHash: null,
        settlementTxHash: null,
        fromAddress: null,
        notifiedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(transactions.id, transactionId),
        isNull(transactions.intentHash),
        eq(transactions.status, "confirming"),
        eq(transactions.verified, 0),
        sql`lower(${transactions.txHash}) = ${txHash}`,
      )).returning();
      const transaction = result[0] as Transaction | undefined;
      if (!transaction) {
        const current = (await database.select().from(transactions)
          .where(eq(transactions.id, transactionId)).limit(1))[0] as Transaction | undefined;
        return current
          ? { outcome: "invalid_state", transaction: current } as const
          : { outcome: "not_found" } as const;
      }
      await database.update(menuOrders).set({ status: "payment_pending", updatedAt: new Date() }).where(and(
        eq(menuOrders.merchantId, transaction.merchantId),
        sql`${menuOrders.status} <> 'paid'`,
        or(eq(menuOrders.paymentId, transactionId), eq(menuOrders.transactionId, transactionId)),
      ));
      await database.update(paymentIntents).set({ status: "open", updatedAt: new Date() }).where(and(
        eq(paymentIntents.merchantId, transaction.merchantId),
        eq(paymentIntents.transactionId, transactionId),
        eq(paymentIntents.status, "processing"),
      ));
      return { outcome: "released", transaction } as const;
    });
  }

  const current = memory.transactions.get(transactionId);
  if (!current) return { outcome: "not_found" };
  if (
    current.intentHash != null
    || current.status !== "confirming"
    || current.verified !== 0
    || current.txHash?.trim().toLowerCase() !== txHash
  ) {
    return { outcome: "invalid_state", transaction: current };
  }
  const transaction = {
    ...current,
    status: "pending",
    txHash: null,
    settlementTxHash: null,
    fromAddress: null,
    notifiedAt: null,
    updatedAt: now(),
  } as Transaction;
  memory.transactions.set(transactionId, transaction);
  for (const order of memory.menuOrders.values()) {
    if (
      order.merchantId === transaction.merchantId
      && order.status !== "paid"
      && (order.paymentId === transactionId || order.transactionId === transactionId)
    ) {
      memory.menuOrders.set(order.id, { ...order, status: "payment_pending", updatedAt: now() } as MenuOrder);
    }
  }
  for (const intent of memory.paymentIntents.values()) {
    if (
      intent.merchantId === transaction.merchantId
      && intent.transactionId === transactionId
      && intent.status === "processing"
    ) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "open", updatedAt: now() } as PaymentIntent);
    }
  }
  return { outcome: "released", transaction };
}

export type ClaimDirectTransactionCancellationResult =
  | { outcome: "claimed" | "already_canceled" | "invalid_state"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

function classifyDirectTransactionCancellation(
  transaction: Transaction | undefined,
): "claimable" | "already_canceled" | "invalid_state" | "not_found" {
  if (!transaction) return "not_found";
  if (transaction.status === "canceled") return "already_canceled";
  return transaction.status === "pending"
    && transaction.verified === 0
    && transaction.txHash == null
    && transaction.quoteUuid == null
    && transaction.intentHash == null
    && transaction.submitState == null
    ? "claimable"
    : "invalid_state";
}

/** First of direct notification and cancellation owns the pending row. */
export async function claimDirectTransactionCancellation(input: {
  transactionId: string;
  notes: string;
  memo?: string | null;
}): Promise<ClaimDirectTransactionCancellationResult> {
  const transactionId = input.transactionId.trim();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  const resultFor = (transaction: Transaction | undefined): ClaimDirectTransactionCancellationResult => {
    const outcome = classifyDirectTransactionCancellation(transaction);
    return outcome === "not_found"
      ? { outcome }
      : { outcome: outcome === "claimable" ? "invalid_state" : outcome, transaction: transaction! };
  };
  const patch = {
    status: "canceled" as const,
    notes: input.notes,
    ...(input.memo !== undefined ? { memo: input.memo } : {}),
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transaction = (await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [transactionId],
      )).rows[0] as Transaction | undefined;
      if (classifyDirectTransactionCancellation(transaction) !== "claimable") {
        await client.query("ROLLBACK");
        return resultFor(transaction);
      }
      const updated = (await client.query(
        `UPDATE "transactions"
         SET "status" = 'canceled', "notes" = $1, "memo" = $2, "updatedAt" = now()
         WHERE "id" = $3 RETURNING *`,
        [input.notes, input.memo === undefined ? transaction!.memo : input.memo, transactionId],
      )).rows[0] as Transaction;
      await client.query(
        `UPDATE "menu_orders" SET "status" = 'canceled', "updatedAt" = now()
         WHERE "merchantId" = $1
           AND ("paymentId" = $2 OR "transactionId" = $2)
           AND ("paymentId" IS NULL OR "paymentId" = $2)
           AND ("transactionId" IS NULL OR "transactionId" = $2)`,
        [transaction!.merchantId, transactionId],
      );
      await client.query(
        `UPDATE "payment_intents" SET "status" = 'canceled', "updatedAt" = now()
         WHERE "merchantId" = $1 AND "transactionId" = $2`,
        [transaction!.merchantId, transactionId],
      );
      await client.query("COMMIT");
      return { outcome: "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<ClaimDirectTransactionCancellationResult> => {
      const transaction = (await database.select().from(transactions)
        .where(eq(transactions.id, transactionId)).limit(1).for("update"))[0] as Transaction | undefined;
      if (classifyDirectTransactionCancellation(transaction) !== "claimable") return resultFor(transaction);
      const updated = (await database.update(transactions).set({ ...patch, updatedAt: new Date() })
        .where(eq(transactions.id, transactionId)).returning())[0] as Transaction;
      await database.update(menuOrders).set({ status: "canceled", updatedAt: new Date() }).where(and(
        eq(menuOrders.merchantId, transaction!.merchantId),
        or(eq(menuOrders.paymentId, transactionId), eq(menuOrders.transactionId, transactionId)),
        or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, transactionId)),
        or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, transactionId)),
      ));
      await database.update(paymentIntents).set({ status: "canceled", updatedAt: new Date() }).where(and(
        eq(paymentIntents.merchantId, transaction!.merchantId),
        eq(paymentIntents.transactionId, transactionId),
      ));
      return { outcome: "claimed", transaction: updated };
    });
  }
  const transaction = memory.transactions.get(transactionId);
  if (classifyDirectTransactionCancellation(transaction) !== "claimable") return resultFor(transaction);
  const updated = { ...transaction!, ...patch, updatedAt: now() } as Transaction;
  memory.transactions.set(transactionId, updated);
  const updatedAt = now();
  for (const order of memory.menuOrders.values()) {
    if (
      order.merchantId === transaction!.merchantId
      && (order.paymentId === transactionId || order.transactionId === transactionId)
      && (order.paymentId == null || order.paymentId === transactionId)
      && (order.transactionId == null || order.transactionId === transactionId)
    ) memory.menuOrders.set(order.id, { ...order, status: "canceled", updatedAt } as MenuOrder);
  }
  for (const intent of memory.paymentIntents.values()) {
    if (intent.merchantId === transaction!.merchantId && intent.transactionId === transactionId) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "canceled", updatedAt } as PaymentIntent);
    }
  }
  return { outcome: "claimed", transaction: updated };
}

export type ClaimDirectTransactionConfirmationResult =
  | { outcome: "claimed" | "already_confirmed"; transaction: Transaction }
  | { outcome: "invalid_state" | "hash_conflict"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

function classifyDirectTransactionConfirmation(
  transaction: Transaction | undefined,
  txHash: string,
): "claimable" | "already_confirmed" | "invalid_state" | "hash_conflict" | "not_found" {
  if (!transaction) return "not_found";
  if (transaction.intentHash != null || transaction.quoteUuid != null || transaction.submitState != null) return "invalid_state";
  const storedHash = transaction.txHash?.trim().toLowerCase() ?? null;
  if (storedHash != null && storedHash !== txHash) return "hash_conflict";
  if (transaction.status === "confirmed" && transaction.verified === 1 && storedHash === txHash) return "already_confirmed";
  return transaction.verified === 0 && (
    (transaction.status === "pending" && storedHash == null)
    || (transaction.status === "confirming" && storedHash === txHash)
  ) ? "claimable" : "invalid_state";
}

/**
 * Claims final direct-transfer proof and marks only still-owned linked
 * resources paid in the same commit. Exact hash/state bindings prevent stale
 * verifiers from overwriting a different notification or cancellation.
 */
export async function claimDirectTransactionConfirmation(input: {
  transactionId: string;
  txHash: string;
  fromAddress?: string | null;
  payCoin?: string | null;
  payAmount?: string | null;
  notifiedAt?: Date;
  webhookSentAt?: Date | null;
}): Promise<ClaimDirectTransactionConfirmationResult> {
  const transactionId = input.transactionId.trim();
  const txHash = input.txHash.trim().toLowerCase();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  if (!TRANSACTION_HASH_PATTERN.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
  const resultFor = (transaction: Transaction | undefined): ClaimDirectTransactionConfirmationResult => {
    const outcome = classifyDirectTransactionConfirmation(transaction, txHash);
    return outcome === "not_found"
      ? { outcome }
      : { outcome: outcome === "claimable" ? "invalid_state" : outcome, transaction: transaction! };
  };
  const data: Partial<InsertTransaction> = {
    txHash,
    fromAddress: input.fromAddress?.trim().toLowerCase() || null,
    status: "confirmed",
    verified: 1,
    ...(input.payCoin !== undefined ? { payCoin: input.payCoin } : {}),
    ...(input.payAmount !== undefined ? { payAmount: input.payAmount } : {}),
    notifiedAt: input.notifiedAt ?? new Date(),
    ...(input.webhookSentAt !== undefined ? { webhookSentAt: input.webhookSentAt } : {}),
  };
  const updateLinkedPg = async (client: pg.PoolClient, transaction: Transaction) => {
    await client.query(
      `UPDATE "menu_orders" SET "status" = 'paid', "updatedAt" = now()
       WHERE "merchantId" = $1
         AND ("paymentId" = $2 OR "transactionId" = $2)
         AND ("paymentId" IS NULL OR "paymentId" = $2)
         AND ("transactionId" IS NULL OR "transactionId" = $2)`,
      [transaction.merchantId, transaction.id],
    );
    await client.query(
      `UPDATE "payment_intents" SET "status" = 'paid', "updatedAt" = now()
       WHERE "merchantId" = $1 AND "transactionId" = $2`,
      [transaction.merchantId, transaction.id],
    );
  };
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transaction = (await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [transactionId],
      )).rows[0] as Transaction | undefined;
      if (classifyDirectTransactionConfirmation(transaction, txHash) !== "claimable") {
        await client.query("ROLLBACK");
        return resultFor(transaction);
      }
      const entries = Object.entries(data).filter(([, value]) => value !== undefined);
      const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
      const values = entries.map(([, value]) => normalizeDbValue(value));
      values.push(transactionId);
      const updated = (await client.query(
        `UPDATE "transactions" SET ${set}, "updatedAt" = now()
         WHERE "id" = $${values.length} RETURNING *`,
        values,
      )).rows[0] as Transaction;
      await updateLinkedPg(client, updated);
      await client.query("COMMIT");
      return { outcome: "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        databaseErrorHasConstraint(error, "transaction_hash_terminal_owner")
        || databaseErrorHasConstraint(error, "uq_tx_direct_tx_hash")
      ) {
        const current = await getTransactionById(transactionId);
        return current ? { outcome: "hash_conflict", transaction: current } : { outcome: "not_found" };
      }
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await getDb();
  if (db) {
    try {
      return await db.transaction(async (database: any): Promise<ClaimDirectTransactionConfirmationResult> => {
        const transaction = (await database.select().from(transactions)
          .where(eq(transactions.id, transactionId)).limit(1).for("update"))[0] as Transaction | undefined;
        if (classifyDirectTransactionConfirmation(transaction, txHash) !== "claimable") return resultFor(transaction);
        const updated = (await database.update(transactions).set({ ...data, updatedAt: new Date() })
          .where(eq(transactions.id, transactionId)).returning())[0] as Transaction;
        await database.update(menuOrders).set({ status: "paid", updatedAt: new Date() }).where(and(
          eq(menuOrders.merchantId, updated.merchantId),
          or(eq(menuOrders.paymentId, updated.id), eq(menuOrders.transactionId, updated.id)),
          or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, updated.id)),
          or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, updated.id)),
        ));
        await database.update(paymentIntents).set({ status: "paid", updatedAt: new Date() }).where(and(
          eq(paymentIntents.merchantId, updated.merchantId),
          eq(paymentIntents.transactionId, updated.id),
        ));
        return { outcome: "claimed", transaction: updated };
      });
    } catch (error) {
      if (
        !databaseErrorHasConstraint(error, "transaction_hash_terminal_owner")
        && !databaseErrorHasConstraint(error, "uq_tx_direct_tx_hash")
      ) throw error;
      const current = await getTransactionById(transactionId);
      return current ? { outcome: "hash_conflict", transaction: current } : { outcome: "not_found" };
    }
  }
  const transaction = memory.transactions.get(transactionId);
  if (classifyDirectTransactionConfirmation(transaction, txHash) !== "claimable") return resultFor(transaction);
  const updated = { ...transaction!, ...data, updatedAt: now() } as Transaction;
  try {
    assertMemoryTerminalHashOwnership(updated);
  } catch {
    return { outcome: "hash_conflict", transaction: transaction! };
  }
  memory.transactions.set(transactionId, updated);
  const updatedAt = now();
  for (const order of memory.menuOrders.values()) {
    if (
      order.merchantId === updated.merchantId
      && (order.paymentId === updated.id || order.transactionId === updated.id)
      && (order.paymentId == null || order.paymentId === updated.id)
      && (order.transactionId == null || order.transactionId === updated.id)
    ) memory.menuOrders.set(order.id, { ...order, status: "paid", updatedAt } as MenuOrder);
  }
  for (const intent of memory.paymentIntents.values()) {
    if (intent.merchantId === updated.merchantId && intent.transactionId === updated.id) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "paid", updatedAt } as PaymentIntent);
    }
  }
  return { outcome: "claimed", transaction: updated };
}

export type ClaimDirectTransactionFailureResult =
  | { outcome: "claimed"; transaction: Transaction }
  | { outcome: "invalid_state"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

/** Atomically fail only the exact still-tentative direct hash and its owners. */
export async function claimDirectTransactionFailure(input: {
  transactionId: string;
  txHash: string;
  notes: string;
  memo?: string | null;
}): Promise<ClaimDirectTransactionFailureResult> {
  const transactionId = input.transactionId.trim();
  const txHash = input.txHash.trim().toLowerCase();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  if (!TRANSACTION_HASH_PATTERN.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
  const claimable = (transaction: Transaction | undefined) => Boolean(
    transaction
    && transaction.intentHash == null
    && transaction.quoteUuid == null
    && transaction.submitState == null
    && transaction.status === "confirming"
    && transaction.verified === 0
    && transaction.txHash?.trim().toLowerCase() === txHash
  );
  const notClaimed = (transaction: Transaction | undefined): ClaimDirectTransactionFailureResult => transaction
    ? { outcome: "invalid_state", transaction }
    : { outcome: "not_found" };
  const patch = {
    status: "failed" as const,
    notes: input.notes,
    ...(input.memo !== undefined ? { memo: input.memo } : {}),
  };
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transaction = (await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [transactionId],
      )).rows[0] as Transaction | undefined;
      if (!claimable(transaction)) {
        await client.query("ROLLBACK");
        return notClaimed(transaction);
      }
      const updated = (await client.query(
        `UPDATE "transactions" SET "status" = 'failed', "notes" = $1,
           "memo" = $2, "updatedAt" = now() WHERE "id" = $3 RETURNING *`,
        [input.notes, input.memo === undefined ? transaction!.memo : input.memo, transactionId],
      )).rows[0] as Transaction;
      await client.query(
        `UPDATE "menu_orders" SET "status" = 'failed', "updatedAt" = now()
         WHERE "merchantId" = $1
           AND ("paymentId" = $2 OR "transactionId" = $2)
           AND ("paymentId" IS NULL OR "paymentId" = $2)
           AND ("transactionId" IS NULL OR "transactionId" = $2)`,
        [updated.merchantId, updated.id],
      );
      await client.query(
        `UPDATE "payment_intents" SET "status" = 'failed', "updatedAt" = now()
         WHERE "merchantId" = $1 AND "transactionId" = $2`,
        [updated.merchantId, updated.id],
      );
      await client.query("COMMIT");
      return { outcome: "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<ClaimDirectTransactionFailureResult> => {
      const transaction = (await database.select().from(transactions)
        .where(eq(transactions.id, transactionId)).limit(1).for("update"))[0] as Transaction | undefined;
      if (!claimable(transaction)) return notClaimed(transaction);
      const updated = (await database.update(transactions).set({ ...patch, updatedAt: new Date() })
        .where(eq(transactions.id, transactionId)).returning())[0] as Transaction;
      await database.update(menuOrders).set({ status: "failed", updatedAt: new Date() }).where(and(
        eq(menuOrders.merchantId, updated.merchantId),
        or(eq(menuOrders.paymentId, updated.id), eq(menuOrders.transactionId, updated.id)),
        or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, updated.id)),
        or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, updated.id)),
      ));
      await database.update(paymentIntents).set({ status: "failed", updatedAt: new Date() }).where(and(
        eq(paymentIntents.merchantId, updated.merchantId),
        eq(paymentIntents.transactionId, updated.id),
      ));
      return { outcome: "claimed", transaction: updated };
    });
  }
  const transaction = memory.transactions.get(transactionId);
  if (!claimable(transaction)) return notClaimed(transaction);
  const updated = { ...transaction!, ...patch, updatedAt: now() } as Transaction;
  memory.transactions.set(transactionId, updated);
  const updatedAt = now();
  for (const order of memory.menuOrders.values()) {
    if (
      order.merchantId === updated.merchantId
      && (order.paymentId === updated.id || order.transactionId === updated.id)
      && (order.paymentId == null || order.paymentId === updated.id)
      && (order.transactionId == null || order.transactionId === updated.id)
    ) memory.menuOrders.set(order.id, { ...order, status: "failed", updatedAt } as MenuOrder);
  }
  for (const intent of memory.paymentIntents.values()) {
    if (intent.merchantId === updated.merchantId && intent.transactionId === updated.id) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "failed", updatedAt } as PaymentIntent);
    }
  }
  return { outcome: "claimed", transaction: updated };
}

export { SERA_SWAP_SUBMIT_STATES };
export type { SeraSwapSubmitState };

export const SERA_SWAP_ALREADY_CLAIMED_STATES = [
  "submitting",
  "submitted",
  "settlement_unknown",
  "settled",
] as const satisfies readonly SeraSwapSubmitState[];

const seraSwapAlreadyClaimedStateSet = new Set<string>(SERA_SWAP_ALREADY_CLAIMED_STATES);

/**
 * The only failed state that an authoritative on-chain settlement proof may
 * supersede.  This state means a finalized, post-deadline scan found no match;
 * it does not mean an on-chain match is invalid if one is subsequently found
 * (for example, because two reconcilers raced at the scan/commit boundary).
 */
export const SERA_NO_SETTLEMENT_FAILURE_CODE = "no_settlement_after_deadline";

export type SeraSwapLifecyclePatch = Partial<Pick<InsertTransaction,
  | "status"
  | "verified"
  | "txHash"
  | "notes"
  | "notifiedAt"
  | "webhookSentAt"
  | "amount"
  | "payAmount"
  | "quoteUuid"
  | "routeUuid"
  | "intentHash"
  | "tradeId"
  | "seraAddress"
  | "seraVaultAddress"
  | "seraSorAddress"
  | "payTokenAddress"
  | "receiveTokenAddress"
  | "payTokenDecimals"
  | "receiveTokenDecimals"
  | "requestedPayAmountRaw"
  | "maximumPayAmountRaw"
  | "targetReceiveAmountRaw"
  | "minimumReceiveAmountRaw"
  | "initialDepositAmountRaw"
  | "quoteExpiresAt"
  | "intentDeadline"
  | "permitRequired"
  | "permitDeadline"
  | "submitState"
  | "submittedBlockNumber"
  | "seraStatus"
  | "intentMatchedAt"
  | "intentMatchedTxHash"
  | "intentMatchedBlockNumber"
  | "provisionalSettlementAt"
  | "provisionalSettlementTxHash"
  | "provisionalSettlementBlockNumber"
  | "provisionalSettlementBlockHash"
  | "provisionalSettlementConfirmations"
  | "seraOutcomeSyncedAt"
  | "actualPayAmountRaw"
  | "actualReceiveAmountRaw"
  | "feeAmountRaw"
  | "feeTokenAddress"
  | "settlementTxHash"
  | "failureCode"
>>;

/**
 * Persist a coherent Sera lifecycle/economics patch and return the resulting
 * row.  The narrow patch type keeps route code from accidentally mixing an
 * unrelated merchant/payment identity update into a settlement write.
 */
export async function updateSeraSwapLifecycle(
  transactionId: string,
  data: SeraSwapLifecyclePatch,
): Promise<Transaction | undefined> {
  if (data.submitState != null && !SERA_SWAP_SUBMIT_STATES.includes(data.submitState)) {
    throw new Error(`Invalid Sera submit state: ${String(data.submitState)}`);
  }

  const normalizedData = normalizeTransactionFields(data);
  const entries = Object.entries(normalizedData).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return getTransactionById(transactionId);

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    values.push(transactionId);
    const result = await pgPool.query(
      `UPDATE "transactions" SET ${set}, "updatedAt" = now() WHERE "id" = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] as Transaction | undefined;
  }

  const db = await getDb();
  if (!db) {
    const existing = memory.transactions.get(transactionId);
    if (!existing) return undefined;
    const updated = { ...existing, ...normalizedData, updatedAt: now() } as Transaction;
    assertMemoryTerminalHashOwnership(updated);
    assertMemoryActiveCheckoutAttemptOwnership(updated);
    memory.transactions.set(transactionId, updated);
    return updated;
  }
  const result = await db.update(transactions)
    .set({ ...normalizedData, updatedAt: new Date() })
    .where(eq(transactions.id, transactionId))
    .returning();
  return result[0];
}

const SERA_POST_NETWORK_WRITABLE_STATES = ["submitting", "submitted", "settlement_unknown"] as const;
const seraPostNetworkWritableStateSet = new Set<string>(SERA_POST_NETWORK_WRITABLE_STATES);
const SERA_POST_NETWORK_PATCH_FIELDS = new Set<string>([
  "notes",
  "notifiedAt",
  "tradeId",
  "seraStatus",
  "actualPayAmountRaw",
  "actualReceiveAmountRaw",
  "feeAmountRaw",
  "feeTokenAddress",
  "failureCode",
  "status",
  "submitState",
]);

/**
 * Fields that a response received from Sera's HTTP API may persist. Contract
 * identity, quote economics, `txHash`, `verified`, and the authoritative
 * `settled` state are deliberately absent: only an on-chain proof may write
 * those settlement facts.
 */
export type SeraSwapPostNetworkPatch = Partial<Pick<InsertTransaction,
  | "notes"
  | "notifiedAt"
  | "tradeId"
  | "seraStatus"
  | "actualPayAmountRaw"
  | "actualReceiveAmountRaw"
  | "feeAmountRaw"
  | "feeTokenAddress"
  | "failureCode"
>> & {
  status?: "pending" | "confirming" | "failed";
  submitState?: "quote_ready" | "submitting" | "submitted" | "settlement_unknown" | "failed" | "expired";
};

export type ClaimSeraSwapPostNetworkUpdateInput = {
  transactionId: string;
  /** Exact durable bindings held before the Sera network request began. */
  intentHash: string;
  quoteUuid: string;
  /** Bind GET /orders writes; omit while POST /swap is assigning tradeId. */
  expectedTradeId?: string;
  patch: SeraSwapPostNetworkPatch;
};

export type SeraSwapPostNetworkUpdateDecision =
  | "claimable"
  | "not_found"
  | "binding_mismatch"
  | "invalid_state";

export type ClaimSeraSwapPostNetworkUpdateResult =
  | { outcome: "claimed"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined }
  | { outcome: "binding_mismatch" | "invalid_state"; transaction: Transaction };

/** Pure state/binding classifier for post-request Sera API writes. */
export function classifySeraSwapPostNetworkUpdate(
  transaction: Transaction | undefined,
  input: Pick<
    ClaimSeraSwapPostNetworkUpdateInput,
    "transactionId" | "intentHash" | "quoteUuid" | "expectedTradeId"
  >,
): SeraSwapPostNetworkUpdateDecision {
  if (!transaction) return "not_found";

  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  if (
    !quoteUuid
    || !/^0x[0-9a-f]{64}$/.test(intentHash)
    || transaction.id !== input.transactionId
    || transaction.quoteUuid !== quoteUuid
    || transaction.intentHash?.toLowerCase() !== intentHash
    || (expectedTradeId != null && transaction.tradeId !== expectedTradeId)
  ) {
    return "binding_mismatch";
  }

  return transaction.status === "confirming"
    && transaction.verified === 0
    && transaction.submitState != null
    && seraPostNetworkWritableStateSet.has(transaction.submitState)
    ? "claimable"
    : "invalid_state";
}

/**
 * Atomically persists advisory POST /swap or GET /orders data only while the
 * exact quote/Intent remains unresolved. A concurrent chain confirmation or
 * terminal-failure claim changes the guarded state first, making the stale
 * network response a no-op that returns the current row.
 */
export async function claimSeraSwapPostNetworkUpdate(
  input: ClaimSeraSwapPostNetworkUpdateInput,
): Promise<ClaimSeraSwapPostNetworkUpdateResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!quoteUuid) throw new Error("quoteUuid cannot be empty");
  if (expectedTradeId != null && !expectedTradeId) throw new Error("expectedTradeId cannot be empty");

  const patch = input.patch;
  for (const key of Object.keys(patch)) {
    if (!SERA_POST_NETWORK_PATCH_FIELDS.has(key)) {
      throw new Error(`Invalid post-network Sera patch field: ${key}`);
    }
  }
  if (patch.status != null && !["pending", "confirming", "failed"].includes(patch.status)) {
    throw new Error(`Invalid post-network Sera status: ${String(patch.status)}`);
  }
  if (patch.submitState != null && ![
    "quote_ready",
    "submitting",
    "submitted",
    "settlement_unknown",
    "failed",
    "expired",
  ].includes(patch.submitState)) {
    throw new Error(`Invalid post-network Sera submit state: ${String(patch.submitState)}`);
  }
  for (const key of ["actualPayAmountRaw", "actualReceiveAmountRaw", "feeAmountRaw"] as const) {
    const value = patch[key];
    if (value != null && !/^\d+$/.test(value)) throw new Error(`${key} must be an unsigned integer string`);
  }
  const data: SeraSwapLifecyclePatch = {
    ...patch,
    // A terminal provider rejection needs linked-order recovery just like a
    // finalized no-settlement failure. This field is intentionally not part
    // of the caller-controlled post-network patch type.
    ...(patch.status === "failed" ? { seraOutcomeSyncedAt: null, webhookSentAt: null } : {}),
  };
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new Error("A post-network Sera lifecycle patch is required");
  const classifyWrite = (transaction: Transaction | undefined) => {
    const decision = classifySeraSwapPostNetworkUpdate(transaction, {
      ...input,
      intentHash,
      quoteUuid,
    });
    return decision === "claimable" && patch.status === "failed" && Boolean(
      transaction?.intentMatchedAt != null
      || transaction?.provisionalSettlementAt != null
      || transaction?.provisionalSettlementTxHash != null
      || transaction?.provisionalSettlementBlockNumber != null
      || transaction?.provisionalSettlementBlockHash != null
      || transaction?.provisionalSettlementConfirmations != null
    )
      ? "invalid_state" as const
      : decision;
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    values.push(input.transactionId, intentHash, quoteUuid);
    const transactionIdParameter = entries.length + 1;
    const intentHashParameter = entries.length + 2;
    const quoteUuidParameter = entries.length + 3;
    let additionalBindings = "";
    if (expectedTradeId != null) {
      values.push(expectedTradeId);
      additionalBindings = ` AND "tradeId" = $${values.length}`;
    }
    if (patch.status === "failed") {
      additionalBindings += ` AND "intentMatchedAt" IS NULL
        AND "provisionalSettlementAt" IS NULL
        AND "provisionalSettlementTxHash" IS NULL
        AND "provisionalSettlementBlockNumber" IS NULL
        AND "provisionalSettlementBlockHash" IS NULL
        AND "provisionalSettlementConfirmations" IS NULL`;
    }
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET ${set}, "updatedAt" = now()
       WHERE "id" = $${transactionIdParameter}
         AND lower("intentHash") = $${intentHashParameter}
         AND "quoteUuid" = $${quoteUuidParameter}
         AND "status" = 'confirming'
         AND "verified" = 0
         AND "submitState" IN ('submitting', 'submitted', 'settlement_unknown')${additionalBindings}
       RETURNING *`,
      values,
    );
    if (result.rows[0]) return { outcome: "claimed", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const conditions = [
        eq(transactions.id, input.transactionId),
        sql`lower(${transactions.intentHash}) = ${intentHash}`,
        eq(transactions.quoteUuid, quoteUuid),
        eq(transactions.status, "confirming"),
        eq(transactions.verified, 0),
        inArray(transactions.submitState, [...SERA_POST_NETWORK_WRITABLE_STATES]),
      ];
      if (patch.status === "failed") conditions.push(
        isNull(transactions.intentMatchedAt),
        isNull(transactions.provisionalSettlementAt),
        isNull(transactions.provisionalSettlementTxHash),
        isNull(transactions.provisionalSettlementBlockNumber),
        isNull(transactions.provisionalSettlementBlockHash),
        isNull(transactions.provisionalSettlementConfirmations),
      );
      if (expectedTradeId != null) conditions.push(eq(transactions.tradeId, expectedTradeId));
      const result = await db.update(transactions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      if (result[0]) return { outcome: "claimed", transaction: result[0] };
    } else {
      // No await occurs between classification and Map.set, so this fallback
      // preserves the same compare-and-set semantics in one Node process.
      const existing = memory.transactions.get(input.transactionId);
      const decision = classifyWrite(existing);
      if (decision === "claimable" && existing) {
        const updated = { ...existing, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(input.transactionId, updated);
        return { outcome: "claimed", transaction: updated };
      }
      if (decision === "not_found") return { outcome: "not_found" };
      return { outcome: decision === "claimable" ? "invalid_state" : decision, transaction: existing! };
    }
  }

  const current = await getTransactionById(input.transactionId);
  const decision = classifyWrite(current);
  if (decision === "not_found") return { outcome: "not_found" };
  return {
    outcome: decision === "claimable" ? "invalid_state" : decision,
    transaction: current!,
  };
}

export type ReopenSeraSwapAfterStaleRejectionInput = {
  transactionId: string;
  intentHash: string;
  quoteUuid: string;
  notes: string;
};

/**
 * A documented QUOTE_STALE response proves Sera did not accept the order. Put
 * the exact attempt back into its refreshable state and rewind only linked
 * resources still owned by that attempt. Transaction + resource changes are
 * one commit, so another payment can never observe a half-released checkout.
 */
export async function reopenSeraSwapAfterStaleRejection(
  input: ReopenSeraSwapAfterStaleRejectionInput,
): Promise<ClaimSeraSwapPostNetworkUpdateResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!quoteUuid) throw new Error("quoteUuid cannot be empty");

  const classify = (transaction: Transaction | undefined): SeraSwapPostNetworkUpdateDecision => {
    const decision = classifySeraSwapPostNetworkUpdate(transaction, {
      transactionId: input.transactionId,
      intentHash,
      quoteUuid,
    });
    const hasSettlementEvidence = Boolean(
      transaction?.intentMatchedAt != null
      || transaction?.provisionalSettlementAt != null
      || transaction?.provisionalSettlementTxHash != null
      || transaction?.provisionalSettlementBlockNumber != null
      || transaction?.provisionalSettlementBlockHash != null
      || transaction?.provisionalSettlementConfirmations != null
    );
    return decision === "claimable" && (transaction?.submitState !== "submitting" || hasSettlementEvidence)
      ? "invalid_state"
      : decision;
  };
  const patch: SeraSwapLifecyclePatch = {
    status: "pending",
    submitState: "quote_ready",
    seraStatus: "quote_stale",
    failureCode: "quote_stale",
    notes: input.notes,
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [input.transactionId],
      );
      const transaction = result.rows[0] as Transaction | undefined;
      const decision = classify(transaction);
      if (decision !== "claimable") {
        await client.query("ROLLBACK");
        return decision === "not_found"
          ? { outcome: "not_found" }
          : { outcome: decision, transaction: transaction! };
      }
      const updatedResult = await client.query(
        `UPDATE "transactions"
         SET "status" = 'pending', "submitState" = 'quote_ready',
             "seraStatus" = 'quote_stale', "failureCode" = 'quote_stale',
             "notes" = $1, "updatedAt" = now()
         WHERE "id" = $2
         RETURNING *`,
        [input.notes, input.transactionId],
      );
      const updated = updatedResult.rows[0] as Transaction;
      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      if (references.orderId) {
        await client.query(
          `UPDATE "menu_orders"
           SET "status" = 'payment_pending', "updatedAt" = now()
           WHERE "id" = $1 AND "merchantId" = $2
             AND ("paymentId" = $3 OR "transactionId" = $3)
             AND ("paymentId" IS NULL OR "paymentId" = $3)
             AND ("transactionId" IS NULL OR "transactionId" = $3)`,
          [references.orderId, transaction!.merchantId, transaction!.id],
        );
      }
      if (references.paymentIntentId) {
        await client.query(
          `UPDATE "payment_intents"
           SET "status" = 'open', "updatedAt" = now()
           WHERE "id" = $1 AND "merchantId" = $2
             AND "transactionId" = $3 AND "status" = 'processing'`,
          [references.paymentIntentId, transaction!.merchantId, transaction!.id],
        );
      }
      await client.query("COMMIT");
      return { outcome: "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<ClaimSeraSwapPostNetworkUpdateResult> => {
      const transaction = (await database.select().from(transactions)
        .where(eq(transactions.id, input.transactionId)).limit(1).for("update"))[0] as Transaction | undefined;
      const decision = classify(transaction);
      if (decision !== "claimable") {
        return decision === "not_found"
          ? { outcome: "not_found" }
          : { outcome: decision, transaction: transaction! };
      }
      const updated = (await database.update(transactions).set({ ...patch, updatedAt: new Date() })
        .where(eq(transactions.id, input.transactionId)).returning())[0] as Transaction;
      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      if (references.orderId) {
        await database.update(menuOrders).set({ status: "payment_pending", updatedAt: new Date() }).where(and(
          eq(menuOrders.id, references.orderId),
          eq(menuOrders.merchantId, transaction!.merchantId),
          or(eq(menuOrders.paymentId, transaction!.id), eq(menuOrders.transactionId, transaction!.id)),
          or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, transaction!.id)),
          or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, transaction!.id)),
        ));
      }
      if (references.paymentIntentId) {
        await database.update(paymentIntents).set({ status: "open", updatedAt: new Date() }).where(and(
          eq(paymentIntents.id, references.paymentIntentId),
          eq(paymentIntents.merchantId, transaction!.merchantId),
          eq(paymentIntents.transactionId, transaction!.id),
          eq(paymentIntents.status, "processing"),
        ));
      }
      return { outcome: "claimed", transaction: updated };
    });
  }

  const transaction = memory.transactions.get(input.transactionId);
  const decision = classify(transaction);
  if (decision !== "claimable") {
    return decision === "not_found"
      ? { outcome: "not_found" }
      : { outcome: decision, transaction: transaction! };
  }
  const updated = { ...transaction!, ...patch, updatedAt: now() } as Transaction;
  memory.transactions.set(updated.id, updated);
  const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
  if (references.orderId) {
    const order = memory.menuOrders.get(references.orderId);
    if (
      order
      && order.merchantId === transaction!.merchantId
      && (order.paymentId === transaction!.id || order.transactionId === transaction!.id)
      && (order.paymentId == null || order.paymentId === transaction!.id)
      && (order.transactionId == null || order.transactionId === transaction!.id)
    ) {
      memory.menuOrders.set(order.id, { ...order, status: "payment_pending", updatedAt: now() } as MenuOrder);
    }
  }
  if (references.paymentIntentId) {
    const intent = memory.paymentIntents.get(references.paymentIntentId);
    if (
      intent
      && intent.merchantId === transaction!.merchantId
      && intent.transactionId === transaction!.id
      && intent.status === "processing"
    ) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "open", updatedAt: now() } as PaymentIntent);
    }
  }
  return { outcome: "claimed", transaction: updated };
}

export type ClaimSeraSwapCancellationInput = {
  transactionId: string;
  intentHash: string;
  quoteUuid: string;
  notes: string;
  memo?: string | null;
};

export type ClaimSeraSwapCancellationResult =
  | { outcome: "claimed" | "already_canceled" | "binding_mismatch" | "invalid_state"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

type SeraSwapCancellationDecision =
  | "claimable"
  | "already_canceled"
  | "binding_mismatch"
  | "invalid_state"
  | "not_found";

function classifySeraSwapCancellation(
  transaction: Transaction | undefined,
  input: Pick<ClaimSeraSwapCancellationInput, "transactionId" | "intentHash" | "quoteUuid">,
): SeraSwapCancellationDecision {
  if (!transaction) return "not_found";
  const intentHash = input.intentHash.trim().toLowerCase();
  if (
    transaction.id !== input.transactionId
    || transaction.quoteUuid !== input.quoteUuid.trim()
    || transaction.intentHash?.toLowerCase() !== intentHash
  ) return "binding_mismatch";
  if (transaction.status === "canceled" && transaction.submitState === "canceled") return "already_canceled";
  return transaction.status === "pending"
    && transaction.verified === 0
    && transaction.submitState === "quote_ready"
    ? "claimable"
    : "invalid_state";
}

/** First of merchant cancellation and Sera submission wins the row lock. */
export async function claimSeraSwapCancellation(
  input: ClaimSeraSwapCancellationInput,
): Promise<ClaimSeraSwapCancellationResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!quoteUuid) throw new Error("quoteUuid cannot be empty");
  const decisionFor = (transaction: Transaction | undefined) => classifySeraSwapCancellation(
    transaction,
    { ...input, intentHash, quoteUuid },
  );
  const classify = (transaction: Transaction | undefined): ClaimSeraSwapCancellationResult => {
    const decision = decisionFor(transaction);
    const outcome = decision === "claimable" ? "invalid_state" : decision;
    return outcome === "not_found" ? { outcome } : { outcome, transaction: transaction! };
  };
  const patch: SeraSwapLifecyclePatch = {
    status: "canceled",
    submitState: "canceled",
    seraStatus: "cancelled",
    failureCode: "canceled",
    notes: input.notes,
    ...(input.memo !== undefined ? { memo: input.memo } : {}),
  };
  const updateLinked = async (database: any, transaction: Transaction) => {
    const references = parseSeraLinkedOutcomeReferences(transaction.notes);
    if (references.orderId) {
      await database.update(menuOrders).set({ status: "canceled", updatedAt: new Date() }).where(and(
        eq(menuOrders.id, references.orderId),
        eq(menuOrders.merchantId, transaction.merchantId),
        or(eq(menuOrders.paymentId, transaction.id), eq(menuOrders.transactionId, transaction.id)),
        or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, transaction.id)),
        or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, transaction.id)),
      ));
    }
    if (references.paymentIntentId) {
      await database.update(paymentIntents).set({ status: "canceled", updatedAt: new Date() }).where(and(
        eq(paymentIntents.id, references.paymentIntentId),
        eq(paymentIntents.merchantId, transaction.merchantId),
        eq(paymentIntents.transactionId, transaction.id),
      ));
    }
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transaction = (await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [input.transactionId],
      )).rows[0] as Transaction | undefined;
      if (decisionFor(transaction) !== "claimable") {
        await client.query("ROLLBACK");
        return classify(transaction);
      }
      const updated = (await client.query(
        `UPDATE "transactions"
         SET "status" = 'canceled', "submitState" = 'canceled',
             "seraStatus" = 'cancelled', "failureCode" = 'canceled',
             "notes" = $1, "memo" = $2, "updatedAt" = now()
         WHERE "id" = $3 RETURNING *`,
        [input.notes, input.memo === undefined ? transaction!.memo : input.memo, input.transactionId],
      )).rows[0] as Transaction;
      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      if (references.orderId) {
        await client.query(
          `UPDATE "menu_orders" SET "status" = 'canceled', "updatedAt" = now()
           WHERE "id" = $1 AND "merchantId" = $2
             AND ("paymentId" = $3 OR "transactionId" = $3)
             AND ("paymentId" IS NULL OR "paymentId" = $3)
             AND ("transactionId" IS NULL OR "transactionId" = $3)`,
          [references.orderId, transaction!.merchantId, transaction!.id],
        );
      }
      if (references.paymentIntentId) {
        await client.query(
          `UPDATE "payment_intents" SET "status" = 'canceled', "updatedAt" = now()
           WHERE "id" = $1 AND "merchantId" = $2 AND "transactionId" = $3`,
          [references.paymentIntentId, transaction!.merchantId, transaction!.id],
        );
      }
      await client.query("COMMIT");
      return { outcome: "claimed", transaction: updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<ClaimSeraSwapCancellationResult> => {
      const transaction = (await database.select().from(transactions)
        .where(eq(transactions.id, input.transactionId)).limit(1).for("update"))[0] as Transaction | undefined;
      if (decisionFor(transaction) !== "claimable") return classify(transaction);
      const updated = (await database.update(transactions).set({ ...patch, updatedAt: new Date() })
        .where(eq(transactions.id, input.transactionId)).returning())[0] as Transaction;
      await updateLinked(database, transaction!);
      return { outcome: "claimed", transaction: updated };
    });
  }
  const transaction = memory.transactions.get(input.transactionId);
  if (decisionFor(transaction) !== "claimable") return classify(transaction);
  const updated = { ...transaction!, ...patch, updatedAt: now() } as Transaction;
  memory.transactions.set(updated.id, updated);
  const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
  if (references.orderId) {
    const order = memory.menuOrders.get(references.orderId);
    if (
      order
      && order.merchantId === transaction!.merchantId
      && (order.paymentId === transaction!.id || order.transactionId === transaction!.id)
      && (order.paymentId == null || order.paymentId === transaction!.id)
      && (order.transactionId == null || order.transactionId === transaction!.id)
    ) memory.menuOrders.set(order.id, { ...order, status: "canceled", updatedAt: now() } as MenuOrder);
  }
  if (references.paymentIntentId) {
    const intent = memory.paymentIntents.get(references.paymentIntentId);
    if (intent && intent.merchantId === transaction!.merchantId && intent.transactionId === transaction!.id) {
      memory.paymentIntents.set(intent.id, { ...intent, status: "canceled", updatedAt: now() } as PaymentIntent);
    }
  }
  return { outcome: "claimed", transaction: updated };
}

export type SeraSwapQuoteRefreshPatch = SeraSwapLifecyclePatch & {
  /** Adopted on refresh for pre-migration quotes that did not yet store it. */
  checkoutAttemptKey?: string | null;
  quoteUuid: string;
  routeUuid: string;
  intentHash: string;
  seraAddress: string;
  seraVaultAddress: string;
  seraSorAddress: string;
  payTokenAddress: string;
  receiveTokenAddress: string;
  payTokenDecimals: number;
  receiveTokenDecimals: number;
  requestedPayAmountRaw: string;
  maximumPayAmountRaw: string;
  targetReceiveAmountRaw: string;
  minimumReceiveAmountRaw: string;
  initialDepositAmountRaw: string;
  quoteExpiresAt: Date;
  intentDeadline: Date;
  permitRequired: number;
  permitDeadline: Date | null;
  status?: "pending";
  submitState?: "quote_ready";
};

/**
 * Pure predicate for the quote-refresh compare-and-set.
 *
 * Passing `null` for the expected quote is an explicit, one-time adoption path
 * for a pre-migration notes-only row.  It never matches a row that already has
 * a durable quote UUID, and a non-null expected UUID never matches a legacy
 * null submit state.
 */
export function isSeraSwapQuoteRefreshable(
  transaction: Transaction | undefined,
  expectedOldQuoteUuid: string | null,
): boolean {
  if (!transaction || transaction.status !== "pending") return false;

  if (expectedOldQuoteUuid === null) {
    return transaction.quoteUuid == null
      && (transaction.submitState === null || transaction.submitState === "quote_ready");
  }

  const expected = expectedOldQuoteUuid.trim();
  return expected.length > 0
    && transaction.quoteUuid === expected
    && transaction.submitState === "quote_ready";
}

/**
 * Atomically replaces an unsubmitted Sera quote.
 *
 * The old UUID and lifecycle state are checked in the same UPDATE that writes
 * the new route.  Consequently, a concurrent submission claim changing
 * quote_ready -> submitting wins or this refresh wins, but they can never
 * overwrite one another.
 */
export async function refreshSeraSwapQuote(
  transactionId: string,
  expectedOldQuoteUuid: string | null,
  lifecyclePatch: SeraSwapQuoteRefreshPatch,
): Promise<Transaction | undefined> {
  if (expectedOldQuoteUuid !== null && !expectedOldQuoteUuid.trim()) {
    throw new Error("expectedOldQuoteUuid must be a non-empty string or null");
  }
  if (!lifecyclePatch.quoteUuid?.trim()) throw new Error("A refreshed Sera quote UUID is required");
  for (const key of ["seraAddress", "seraVaultAddress", "seraSorAddress"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(lifecyclePatch[key])) {
      throw new Error(`${key} must be a 20-byte hex address`);
    }
  }
  for (const key of ["payTokenDecimals", "receiveTokenDecimals"] as const) {
    const value = lifecyclePatch[key];
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`${key} must be an integer from 0 to 255`);
    }
  }
  if (lifecyclePatch.status != null && lifecyclePatch.status !== "pending") {
    throw new Error("A Sera quote refresh must remain pending");
  }
  if (lifecyclePatch.submitState != null && lifecyclePatch.submitState !== "quote_ready") {
    throw new Error("A Sera quote refresh must remain quote_ready");
  }

  // No settlement/submission residue can be carried into a refreshed quote.
  // These overrides also make the legacy adoption result structurally equal to
  // a newly-created quote row.
  const data: SeraSwapLifecyclePatch = {
    ...lifecyclePatch,
    status: "pending",
    submitState: "quote_ready",
    tradeId: null,
    submittedBlockNumber: null,
    seraStatus: null,
    seraOutcomeSyncedAt: null,
    actualPayAmountRaw: null,
    actualReceiveAmountRaw: null,
    feeAmountRaw: null,
    feeTokenAddress: null,
    settlementTxHash: null,
    failureCode: null,
    provisionalSettlementAt: null,
    provisionalSettlementTxHash: null,
    provisionalSettlementBlockNumber: null,
    provisionalSettlementBlockHash: null,
    provisionalSettlementConfirmations: null,
    txHash: null,
    verified: 0,
    notifiedAt: null,
    webhookSentAt: null,
  };
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const normalizedExpected = expectedOldQuoteUuid?.trim() ?? null;
  const pgPool = await getPostgresPool();

  if (pgPool) {
    const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    values.push(transactionId);
    const transactionIdParameter = values.length;
    let bindingPredicate: string;
    if (normalizedExpected === null) {
      bindingPredicate = `"quoteUuid" IS NULL AND ("submitState" IS NULL OR "submitState" = 'quote_ready')`;
    } else {
      values.push(normalizedExpected);
      bindingPredicate = `"quoteUuid" = $${values.length} AND "submitState" = 'quote_ready'`;
    }
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET ${set}, "updatedAt" = now()
       WHERE "id" = $${transactionIdParameter}
         AND "status" = 'pending'
         AND ${bindingPredicate}
       RETURNING *`,
      values,
    );
    return result.rows[0] as Transaction | undefined;
  }

  const db = await getDb();
  if (db) {
    const bindingCondition = normalizedExpected === null
      ? and(
          isNull(transactions.quoteUuid),
          or(isNull(transactions.submitState), eq(transactions.submitState, "quote_ready")),
        )
      : and(
          eq(transactions.quoteUuid, normalizedExpected),
          eq(transactions.submitState, "quote_ready"),
        );
    const result = await db.update(transactions)
      .set({ ...data, updatedAt: new Date() })
      .where(and(
        eq(transactions.id, transactionId),
        eq(transactions.status, "pending"),
        bindingCondition,
      ))
      .returning();
    return result[0];
  }

  const existing = memory.transactions.get(transactionId);
  if (!isSeraSwapQuoteRefreshable(existing, normalizedExpected)) return undefined;
  const updated = { ...existing!, ...data, updatedAt: now() } as Transaction;
  memory.transactions.set(transactionId, updated);
  return updated;
}

export type ClaimSeraSwapSubmissionInput = {
  transactionId: string;
  quoteUuid: string;
  /** Include when the caller has independently reconstructed the signed route. */
  intentHash?: string;
  /** Last chain block observed immediately before submission. */
  submittedBlockNumber?: string | null;
  /** Injectable only for deterministic expiry tests. */
  now?: Date;
};

export type SeraSwapSubmissionClaimDecision =
  | "claimable"
  | "already_claimed"
  | "not_found"
  | "binding_mismatch"
  | "invalid_state";

export type ClaimSeraSwapSubmissionResult =
  | { outcome: "claimed"; transaction: Transaction }
  | { outcome: Exclude<SeraSwapSubmissionClaimDecision, "claimable" | "not_found">; transaction: Transaction }
  | {
      outcome: "binding_conflict";
      transaction: Transaction;
      resource: "menu_order" | "payment_intent";
      resourceId: string;
    }
  | { outcome: "not_found"; transaction?: undefined };

function replaceableSubmissionOwner(transaction: Transaction | undefined): boolean {
  if (!transaction) return false;
  if (transaction.status === "canceled") return true;
  if (transaction.status !== "failed") return false;
  // A Sera failure is retryable only after its linked/outbound outcome work
  // completed. Until then a racing finalized success may still supersede the
  // narrow no-settlement result.
  const sera = transaction.quoteUuid != null || transaction.intentHash != null || transaction.submitState != null;
  return !sera || (transaction.seraOutcomeSyncedAt != null && transaction.intentMatchedAt == null);
}

function menuOrderSubmissionOwnerId(order: MenuOrder, transactionId: string): string | null | "conflict" {
  const owners = Array.from(new Set([order.paymentId, order.transactionId]
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id !== transactionId)));
  return owners.length > 1 ? "conflict" : owners[0] ?? null;
}

function canClaimMenuOrderForSeraSubmission(
  order: MenuOrder,
  transaction: Transaction,
  previousOwner: Transaction | undefined,
): boolean {
  if (order.merchantId !== transaction.merchantId) return false;
  const previousOwnerId = menuOrderSubmissionOwnerId(order, transaction.id);
  if (previousOwnerId === "conflict") return false;
  if (order.status === "failed") {
    return previousOwnerId === null || replaceableSubmissionOwner(previousOwner);
  }
  if (order.status === "payment_submitted") {
    return previousOwnerId === null
      && (order.paymentId === transaction.id || order.transactionId === transaction.id);
  }
  return (order.status === "created" || order.status === "payment_pending")
    && previousOwnerId === null;
}

function canClaimPaymentIntentForSeraSubmission(
  intent: PaymentIntent,
  transaction: Transaction,
  previousOwner: Transaction | undefined,
  checkTime: Date,
): boolean {
  if (intent.merchantId !== transaction.merchantId) return false;
  if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= checkTime.getTime()) return false;
  const ownerId = intent.transactionId;
  if (intent.status === "processing") return ownerId === transaction.id;
  if (intent.status === "failed") {
    return ownerId == null || ownerId === transaction.id || replaceableSubmissionOwner(previousOwner);
  }
  return (intent.status === "created" || intent.status === "open")
    && (ownerId == null || ownerId === transaction.id);
}

/** Pure classifier shared by the PostgreSQL CAS and the in-memory fallback. */
export function classifySeraSwapSubmissionClaim(
  transaction: Transaction | undefined,
  input: ClaimSeraSwapSubmissionInput,
): SeraSwapSubmissionClaimDecision {
  if (!transaction) return "not_found";

  // A direct transfer (or a legacy notes-only swap) cannot safely enter the
  // new submission processor.  All three durable binding markers are needed.
  if (!transaction.quoteUuid || !transaction.intentHash || !transaction.submitState) {
    return "invalid_state";
  }

  const expectedQuoteUuid = input.quoteUuid.trim();
  const expectedIntentHash = input.intentHash?.trim().toLowerCase();
  if (
    !expectedQuoteUuid
    || transaction.quoteUuid !== expectedQuoteUuid
    || (expectedIntentHash != null && transaction.intentHash.toLowerCase() !== expectedIntentHash)
  ) {
    return "binding_mismatch";
  }

  if (transaction.status === "failed" || transaction.status === "canceled") {
    return "invalid_state";
  }

  // Once submission may have left this process, it is never safe to consume
  // the quote again.  The caller should return/reconcile the stored outcome.
  if (
    seraSwapAlreadyClaimedStateSet.has(transaction.submitState)
    || transaction.status === "confirming"
    || transaction.status === "confirmed"
  ) {
    return "already_claimed";
  }

  const checkTime = input.now ?? new Date();
  if (
    transaction.submitState !== "quote_ready"
    || transaction.status !== "pending"
    || (transaction.quoteExpiresAt != null && transaction.quoteExpiresAt <= checkTime)
    || (transaction.intentDeadline != null && transaction.intentDeadline <= checkTime)
  ) {
    return "invalid_state";
  }

  return "claimable";
}

/**
 * Atomically changes `quote_ready` to `submitting` before POST /swap starts.
 * Only one concurrent caller can receive `claimed`; every later call observes
 * `already_claimed` and must reconcile/return that transaction instead of
 * sending the single-use quote to Sera again.
 */
export async function claimSeraSwapSubmission(
  input: ClaimSeraSwapSubmissionInput,
): Promise<ClaimSeraSwapSubmissionResult> {
  const quoteUuid = input.quoteUuid.trim();
  const intentHash = input.intentHash?.trim().toLowerCase();
  const submittedBlockNumber = input.submittedBlockNumber?.trim();
  if (submittedBlockNumber != null && !/^\d+$/.test(submittedBlockNumber)) {
    throw new Error("submittedBlockNumber must be an unsigned integer string");
  }
  const checkTime = input.now ?? new Date();
  const pgPool = await getPostgresPool();

  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transactionResult = await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [input.transactionId],
      );
      const transaction = transactionResult.rows[0] as Transaction | undefined;
      const decision = classifySeraSwapSubmissionClaim(transaction, { ...input, quoteUuid, intentHash, now: checkTime });
      if (decision === "not_found") {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (decision !== "claimable") {
        await client.query("ROLLBACK");
        return { outcome: decision, transaction: transaction! };
      }

      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      let order: MenuOrder | undefined;
      if (references.orderId) {
        const orderResult = await client.query(
          `SELECT * FROM "menu_orders" WHERE "id" = $1 FOR UPDATE`,
          [references.orderId],
        );
        order = orderResult.rows[0] as MenuOrder | undefined;
        const previousOwnerId = order ? menuOrderSubmissionOwnerId(order, transaction!.id) : null;
        const previousOwnerResult = previousOwnerId && previousOwnerId !== "conflict"
          ? await client.query(`SELECT * FROM "transactions" WHERE "id" = $1`, [previousOwnerId])
          : { rows: [] };
        if (!order || !canClaimMenuOrderForSeraSubmission(
          order,
          transaction!,
          previousOwnerResult.rows[0] as Transaction | undefined,
        )) {
          await client.query("ROLLBACK");
          return {
            outcome: "binding_conflict",
            transaction: transaction!,
            resource: "menu_order",
            resourceId: references.orderId,
          };
        }
      }

      let paymentIntent: PaymentIntent | undefined;
      if (references.paymentIntentId) {
        const intentResult = await client.query(
          `SELECT * FROM "payment_intents" WHERE "id" = $1 FOR UPDATE`,
          [references.paymentIntentId],
        );
        paymentIntent = intentResult.rows[0] as PaymentIntent | undefined;
        const previousOwnerResult = paymentIntent?.transactionId && paymentIntent.transactionId !== transaction!.id
          ? await client.query(`SELECT * FROM "transactions" WHERE "id" = $1`, [paymentIntent.transactionId])
          : { rows: [] };
        if (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(
          paymentIntent,
          transaction!,
          previousOwnerResult.rows[0] as Transaction | undefined,
          checkTime,
        )) {
          await client.query("ROLLBACK");
          return {
            outcome: "binding_conflict",
            transaction: transaction!,
            resource: "payment_intent",
            resourceId: references.paymentIntentId,
          };
        }
      }

      const values: unknown[] = [input.transactionId, quoteUuid, checkTime, submittedBlockNumber ?? null];
      let intentPredicate = "";
      if (intentHash != null) {
        values.push(intentHash);
        intentPredicate = ` AND lower("intentHash") = $${values.length}`;
      }
      const result = await client.query(
        `UPDATE "transactions"
         SET "submitState" = 'submitting',
             "status" = 'confirming',
             "submittedBlockNumber" = COALESCE($4, "submittedBlockNumber"),
             "notifiedAt" = $3,
             "updatedAt" = now()
         WHERE "id" = $1
           AND "quoteUuid" = $2
           AND "submitState" = 'quote_ready'
           AND "status" = 'pending'
           AND ("quoteExpiresAt" IS NULL OR "quoteExpiresAt" > $3)
           AND ("intentDeadline" IS NULL OR "intentDeadline" > $3)${intentPredicate}
         RETURNING *`,
        values,
      );
      const updated = result.rows[0] as Transaction | undefined;
      if (!updated) {
        await client.query("ROLLBACK");
      } else {
        if (order) {
          await client.query(
            `UPDATE "menu_orders"
             SET "status" = 'payment_submitted', "paymentId" = $1,
                 "transactionId" = $1, "updatedAt" = now()
             WHERE "id" = $2 AND "merchantId" = $3`,
            [updated.id, order.id, updated.merchantId],
          );
        }
        if (paymentIntent) {
          await client.query(
            `UPDATE "payment_intents"
             SET "status" = 'processing', "transactionId" = $1, "updatedAt" = now()
             WHERE "id" = $2 AND "merchantId" = $3`,
            [updated.id, paymentIntent.id, updated.merchantId],
          );
        }
        await client.query("COMMIT");
        return { outcome: "claimed", transaction: updated };
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = await getDb();
    if (db) {
      const claimed = await db.transaction(async (database: any): Promise<ClaimSeraSwapSubmissionResult> => {
        const rows = await database.select().from(transactions)
          .where(eq(transactions.id, input.transactionId)).limit(1).for("update");
        const transaction = rows[0] as Transaction | undefined;
        const decision = classifySeraSwapSubmissionClaim(transaction, { ...input, quoteUuid, intentHash, now: checkTime });
        if (decision === "not_found") return { outcome: "not_found" };
        if (decision !== "claimable") return { outcome: decision, transaction: transaction! };

        const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
        let order: MenuOrder | undefined;
        if (references.orderId) {
          order = (await database.select().from(menuOrders)
            .where(eq(menuOrders.id, references.orderId)).limit(1).for("update"))[0] as MenuOrder | undefined;
          const previousOwnerId = order ? menuOrderSubmissionOwnerId(order, transaction!.id) : null;
          const previousOwner = previousOwnerId && previousOwnerId !== "conflict"
            ? (await database.select().from(transactions)
                .where(eq(transactions.id, previousOwnerId)).limit(1))[0] as Transaction | undefined
            : undefined;
          if (!order || !canClaimMenuOrderForSeraSubmission(order, transaction!, previousOwner)) {
            return {
              outcome: "binding_conflict",
              transaction: transaction!,
              resource: "menu_order",
              resourceId: references.orderId,
            };
          }
        }

        let paymentIntent: PaymentIntent | undefined;
        if (references.paymentIntentId) {
          paymentIntent = (await database.select().from(paymentIntents)
            .where(eq(paymentIntents.id, references.paymentIntentId)).limit(1).for("update"))[0] as PaymentIntent | undefined;
          const previousOwner = paymentIntent?.transactionId && paymentIntent.transactionId !== transaction!.id
            ? (await database.select().from(transactions)
                .where(eq(transactions.id, paymentIntent.transactionId)).limit(1))[0] as Transaction | undefined
            : undefined;
          if (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(
            paymentIntent,
            transaction!,
            previousOwner,
            checkTime,
          )) {
            return {
              outcome: "binding_conflict",
              transaction: transaction!,
              resource: "payment_intent",
              resourceId: references.paymentIntentId,
            };
          }
        }

        const conditions = [
          eq(transactions.id, input.transactionId),
          eq(transactions.quoteUuid, quoteUuid),
          eq(transactions.submitState, "quote_ready"),
          eq(transactions.status, "pending"),
          or(isNull(transactions.quoteExpiresAt), gt(transactions.quoteExpiresAt, checkTime)),
          or(isNull(transactions.intentDeadline), gt(transactions.intentDeadline, checkTime)),
        ];
        if (intentHash != null) conditions.push(eq(transactions.intentHash, intentHash));
        const result = await database.update(transactions).set({
          submitState: "submitting",
          status: "confirming",
          notifiedAt: checkTime,
          ...(submittedBlockNumber != null ? { submittedBlockNumber } : {}),
          updatedAt: new Date(),
        }).where(and(...conditions)).returning();
        const updated = result[0] as Transaction | undefined;
        if (!updated) return { outcome: "invalid_state", transaction: transaction! };
        if (order) {
          await database.update(menuOrders).set({
            status: "payment_submitted",
            paymentId: updated.id,
            transactionId: updated.id,
            updatedAt: new Date(),
          }).where(and(eq(menuOrders.id, order.id), eq(menuOrders.merchantId, updated.merchantId)));
        }
        if (paymentIntent) {
          await database.update(paymentIntents).set({
            status: "processing",
            transactionId: updated.id,
            updatedAt: new Date(),
          }).where(and(eq(paymentIntents.id, paymentIntent.id), eq(paymentIntents.merchantId, updated.merchantId)));
        }
        return { outcome: "claimed", transaction: updated };
      });
      return claimed;
    } else {
      const existing = memory.transactions.get(input.transactionId);
      const decision = classifySeraSwapSubmissionClaim(existing, { ...input, quoteUuid, intentHash, now: checkTime });
      if (decision === "claimable" && existing) {
        const references = parseSeraLinkedOutcomeReferences(existing.notes);
        const order = references.orderId ? memory.menuOrders.get(references.orderId) : undefined;
        if (references.orderId) {
          const previousOwnerId = order ? menuOrderSubmissionOwnerId(order, existing.id) : null;
          const previousOwner = previousOwnerId && previousOwnerId !== "conflict"
            ? memory.transactions.get(previousOwnerId)
            : undefined;
          if (!order || !canClaimMenuOrderForSeraSubmission(order, existing, previousOwner)) {
            return {
              outcome: "binding_conflict",
              transaction: existing,
              resource: "menu_order",
              resourceId: references.orderId,
            };
          }
        }
        const paymentIntent = references.paymentIntentId
          ? memory.paymentIntents.get(references.paymentIntentId)
          : undefined;
        if (references.paymentIntentId) {
          const previousOwner = paymentIntent?.transactionId && paymentIntent.transactionId !== existing.id
            ? memory.transactions.get(paymentIntent.transactionId)
            : undefined;
          if (!paymentIntent || !canClaimPaymentIntentForSeraSubmission(paymentIntent, existing, previousOwner, checkTime)) {
            return {
              outcome: "binding_conflict",
              transaction: existing,
              resource: "payment_intent",
              resourceId: references.paymentIntentId,
            };
          }
        }
        const updated = {
          ...existing,
          submitState: "submitting" as const,
          status: "confirming" as const,
          notifiedAt: checkTime,
          ...(submittedBlockNumber != null ? { submittedBlockNumber } : {}),
          updatedAt: now(),
        };
        memory.transactions.set(input.transactionId, updated);
        if (order) {
          memory.menuOrders.set(order.id, {
            ...order,
            status: "payment_submitted",
            paymentId: updated.id,
            transactionId: updated.id,
            updatedAt: now(),
          } as MenuOrder);
        }
        if (paymentIntent) {
          memory.paymentIntents.set(paymentIntent.id, {
            ...paymentIntent,
            status: "processing",
            transactionId: updated.id,
            updatedAt: now(),
          } as PaymentIntent);
        }
        return { outcome: "claimed", transaction: updated };
      }
      if (decision === "not_found") return { outcome: "not_found" };
      return {
        outcome: decision === "claimable" ? "invalid_state" : decision,
        transaction: existing!,
      };
    }
  }

  const current = await getTransactionById(input.transactionId);
  const decision = classifySeraSwapSubmissionClaim(current, { ...input, quoteUuid, intentHash, now: checkTime });
  if (decision === "not_found") return { outcome: "not_found" };
  // A competing request can win between our UPDATE and this read, which is
  // precisely the already_claimed result this second classification exposes.
  return {
    outcome: decision === "claimable" ? "invalid_state" : decision,
    transaction: current!,
  };
}

export type SeraSwapSettlementConfirmationPatch = Partial<Pick<InsertTransaction,
  | "notes"
  | "amount"
  | "payAmount"
  | "actualPayAmountRaw"
  | "actualReceiveAmountRaw"
  | "feeAmountRaw"
  | "feeTokenAddress"
  | "notifiedAt"
>>;

export type ClaimSeraSwapSettlementConfirmationInput = {
  transactionId: string;
  /** Hash of the exact durable Intent whose on-chain match was verified. */
  intentHash: string;
  /** Transaction containing both IntentMatched and the merchant payout. */
  txHash: string;
  /** Optional additional durable bindings when the caller has them. */
  expectedQuoteUuid?: string;
  expectedTradeId?: string;
  patch?: SeraSwapSettlementConfirmationPatch;
};

export type SeraSwapSettlementConfirmationDecision =
  | "claimable"
  | "already_confirmed"
  | "not_found"
  | "binding_mismatch"
  | "invalid_state"
  | "hash_conflict";

export type ClaimSeraSwapSettlementConfirmationResult =
  | { outcome: "claimed"; transaction: Transaction }
  | {
      outcome: Exclude<SeraSwapSettlementConfirmationDecision, "claimable" | "not_found">;
      transaction: Transaction;
    }
  | { outcome: "not_found"; transaction?: undefined };

const SERA_SETTLEMENT_CLAIMABLE_STATES = ["submitting", "submitted", "settlement_unknown"] as const;
const seraSettlementClaimableStateSet = new Set<string>(SERA_SETTLEMENT_CLAIMABLE_STATES);

function isRecoverableSeraNoSettlementFailure(transaction: Transaction): boolean {
  return transaction.status === "failed"
    && transaction.verified === 0
    && transaction.submitState === "failed"
    && transaction.failureCode === SERA_NO_SETTLEMENT_FAILURE_CODE
    && transaction.intentMatchedAt == null
    && transaction.seraOutcomeSyncedAt == null;
}

/**
 * A Sera solver can settle several independently signed Intents in one
 * Ethereum transaction.  Such rows are allowed to share that transaction
 * hash, but only when the other row is durably owned by a well-formed Sera
 * Intent and neither hash column points at a different transaction.
 *
 * Direct-transfer rows have no Intent hash, so they can never opt into this
 * exception.  They remain protected by both this classifier and the partial
 * unique database index on direct-transfer `txHash` values.
 */
export function isCompatibleSeraBatchSettlementHashOwner(
  transaction: Transaction,
  txHash: string,
): boolean {
  const normalized = txHash.trim().toLowerCase();
  const ownership = getTerminalTransactionHashOwnership(transaction);
  return ownership?.kind === "sera" && ownership.txHash === normalized;
}

export type MarkSeraIntentMatchedEvidenceResult =
  | { outcome: "claimed" | "already_marked" | "already_confirmed"; transaction: Transaction }
  | { outcome: "binding_mismatch" | "invalid_state"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

export type ClaimSeraSwapProvisionalSettlementInput = {
  transactionId: string;
  quoteUuid: string;
  intentHash: string;
  txHash: string;
  blockNumber: string;
  blockHash: string;
  confirmations: number;
  expectedTradeId?: string;
  observedAt?: Date;
};

export type SeraSwapProvisionalSettlementDecision =
  | "claimable"
  | "already_observed"
  | "not_found"
  | "binding_mismatch"
  | "evidence_conflict"
  | "invalid_state";

export type ClaimSeraSwapProvisionalSettlementResult =
  | { outcome: "claimed"; transaction: Transaction }
  | {
      outcome: Exclude<SeraSwapProvisionalSettlementDecision, "claimable" | "not_found">;
      transaction: Transaction;
    }
  | { outcome: "not_found"; transaction?: undefined };

function validProvisionalSettlementInput(input: ClaimSeraSwapProvisionalSettlementInput) {
  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  const txHash = input.txHash.trim().toLowerCase();
  const blockHash = input.blockHash.trim().toLowerCase();
  const blockNumber = input.blockNumber.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  const observedAt = input.observedAt ?? new Date();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!quoteUuid) throw new Error("quoteUuid cannot be empty");
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) throw new Error("blockHash must be a 32-byte hex hash");
  if (!/^\d+$/.test(blockNumber)) throw new Error("blockNumber must be an unsigned integer string");
  if (!Number.isInteger(input.confirmations) || input.confirmations < 1 || input.confirmations > 2) {
    throw new Error("confirmations must be 1 or 2");
  }
  if (expectedTradeId != null && !expectedTradeId) throw new Error("expectedTradeId cannot be empty");
  if (!validDate(observedAt)) throw new Error("observedAt must be a valid Date");
  return { intentHash, quoteUuid, txHash, blockHash, blockNumber: BigInt(blockNumber).toString(), expectedTradeId, observedAt };
}

/** Pure classifier for the durable, non-terminal latest-head observation. */
export function classifySeraSwapProvisionalSettlement(
  transaction: Transaction | undefined,
  input: ClaimSeraSwapProvisionalSettlementInput,
): SeraSwapProvisionalSettlementDecision {
  if (!transaction) return "not_found";
  const normalized = validProvisionalSettlementInput(input);
  if (
    transaction.id !== input.transactionId
    || transaction.quoteUuid !== normalized.quoteUuid
    || transaction.intentHash?.toLowerCase() !== normalized.intentHash
    || (normalized.expectedTradeId != null && transaction.tradeId !== normalized.expectedTradeId)
  ) return "binding_mismatch";

  const existingTxHash = transaction.provisionalSettlementTxHash?.trim().toLowerCase() ?? null;
  const existingBlockHash = transaction.provisionalSettlementBlockHash?.trim().toLowerCase() ?? null;
  const existingBlockNumber = transaction.provisionalSettlementBlockNumber == null
    ? null
    : String(transaction.provisionalSettlementBlockNumber);
  const existingConfirmations = transaction.provisionalSettlementConfirmations;
  if (
    transaction.provisionalSettlementAt != null
    && existingTxHash === normalized.txHash
    && existingBlockHash === normalized.blockHash
    && existingBlockNumber === normalized.blockNumber
    && (existingConfirmations === 1 || existingConfirmations === 2)
  ) return "already_observed";
  if (
    transaction.provisionalSettlementAt != null
    || existingTxHash != null
    || existingBlockHash != null
    || existingBlockNumber != null
    || existingConfirmations != null
  ) return "evidence_conflict";
  return transaction.status === "confirming"
    && transaction.verified === 0
    && transaction.submitState != null
    && seraSettlementClaimableStateSet.has(transaction.submitState)
    ? "claimable"
    : "invalid_state";
}

/**
 * Persist an exact canonical receipt/event/payout observation without changing
 * payment ownership. The row stays confirming/unverified; no linked order,
 * terminal hash tombstone, notification, or webhook is created here.
 */
export async function claimSeraSwapProvisionalSettlement(
  input: ClaimSeraSwapProvisionalSettlementInput,
): Promise<ClaimSeraSwapProvisionalSettlementResult> {
  const normalized = validProvisionalSettlementInput(input);
  const data: SeraSwapLifecyclePatch = {
    provisionalSettlementAt: normalized.observedAt,
    provisionalSettlementTxHash: normalized.txHash,
    provisionalSettlementBlockNumber: normalized.blockNumber,
    provisionalSettlementBlockHash: normalized.blockHash,
    provisionalSettlementConfirmations: input.confirmations,
  };
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const values: unknown[] = [
      normalized.observedAt,
      normalized.txHash,
      normalized.blockNumber,
      normalized.blockHash,
      input.confirmations,
      input.transactionId,
      normalized.intentHash,
      normalized.quoteUuid,
    ];
    let tradeBinding = "";
    if (normalized.expectedTradeId != null) {
      values.push(normalized.expectedTradeId);
      tradeBinding = ` AND "tradeId" = $${values.length}`;
    }
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET "provisionalSettlementAt" = $1,
           "provisionalSettlementTxHash" = $2,
           "provisionalSettlementBlockNumber" = $3,
           "provisionalSettlementBlockHash" = $4,
           "provisionalSettlementConfirmations" = $5,
           "updatedAt" = now()
       WHERE "id" = $6 AND lower("intentHash") = $7 AND "quoteUuid" = $8
         AND "status" = 'confirming' AND "verified" = 0
         AND "submitState" IN ('submitting', 'submitted', 'settlement_unknown')
         AND "provisionalSettlementAt" IS NULL
         AND "provisionalSettlementTxHash" IS NULL
         AND "provisionalSettlementBlockNumber" IS NULL
         AND "provisionalSettlementBlockHash" IS NULL
         AND "provisionalSettlementConfirmations" IS NULL${tradeBinding}
       RETURNING *`,
      values,
    );
    if (result.rows[0]) return { outcome: "claimed", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const conditions = [
        eq(transactions.id, input.transactionId),
        sql`lower(${transactions.intentHash}) = ${normalized.intentHash}`,
        eq(transactions.quoteUuid, normalized.quoteUuid),
        eq(transactions.status, "confirming"),
        eq(transactions.verified, 0),
        inArray(transactions.submitState, [...SERA_SETTLEMENT_CLAIMABLE_STATES]),
        isNull(transactions.provisionalSettlementAt),
        isNull(transactions.provisionalSettlementTxHash),
        isNull(transactions.provisionalSettlementBlockNumber),
        isNull(transactions.provisionalSettlementBlockHash),
        isNull(transactions.provisionalSettlementConfirmations),
      ];
      if (normalized.expectedTradeId != null) conditions.push(eq(transactions.tradeId, normalized.expectedTradeId));
      const result = await db.update(transactions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      if (result[0]) return { outcome: "claimed", transaction: result[0] };
    } else {
      const existing = memory.transactions.get(input.transactionId);
      const decision = classifySeraSwapProvisionalSettlement(existing, input);
      if (decision === "claimable" && existing) {
        const updated = { ...existing, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(updated.id, updated);
        return { outcome: "claimed", transaction: updated };
      }
    }
  }
  const current = await getTransactionById(input.transactionId);
  const decision = classifySeraSwapProvisionalSettlement(current, input);
  return decision === "not_found"
    ? { outcome: decision }
    : { outcome: decision === "claimable" ? "invalid_state" : decision, transaction: current! };
}

export type ClearSeraSwapProvisionalSettlementResult =
  | { outcome: "cleared" | "already_clear" | "evidence_mismatch" | "invalid_state"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

/**
 * Clear only the exact provisional envelope whose block is now explicitly
 * non-canonical. Transient receipt/RPC failures must never call this helper.
 */
export async function clearSeraSwapProvisionalSettlement(input: {
  transactionId: string;
  quoteUuid: string;
  intentHash: string;
  txHash: string;
  blockNumber: string;
  blockHash: string;
}): Promise<ClearSeraSwapProvisionalSettlementResult> {
  const normalized = validProvisionalSettlementInput({ ...input, confirmations: 1 });
  const classify = (transaction: Transaction | undefined): Exclude<ClearSeraSwapProvisionalSettlementResult["outcome"], "cleared"> => {
    if (!transaction) return "not_found";
    if (
      transaction.id !== input.transactionId
      || transaction.quoteUuid !== normalized.quoteUuid
      || transaction.intentHash?.toLowerCase() !== normalized.intentHash
    ) return "invalid_state";
    if (
      transaction.provisionalSettlementAt == null
      && transaction.provisionalSettlementTxHash == null
      && transaction.provisionalSettlementBlockNumber == null
      && transaction.provisionalSettlementBlockHash == null
      && transaction.provisionalSettlementConfirmations == null
    ) return "already_clear";
    const exactEvidence = transaction.provisionalSettlementTxHash?.toLowerCase() === normalized.txHash
      && String(transaction.provisionalSettlementBlockNumber) === normalized.blockNumber
      && transaction.provisionalSettlementBlockHash?.toLowerCase() === normalized.blockHash;
    if (!exactEvidence) return "evidence_mismatch";
    // An exact unresolved row would have matched the UPDATE. Reaching this
    // branch means another state transition won between the CAS and reload.
    return "invalid_state";
  };
  const data: SeraSwapLifecyclePatch = {
    provisionalSettlementAt: null,
    provisionalSettlementTxHash: null,
    provisionalSettlementBlockNumber: null,
    provisionalSettlementBlockHash: null,
    provisionalSettlementConfirmations: null,
  };
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET "provisionalSettlementAt" = NULL,
           "provisionalSettlementTxHash" = NULL,
           "provisionalSettlementBlockNumber" = NULL,
           "provisionalSettlementBlockHash" = NULL,
           "provisionalSettlementConfirmations" = NULL,
           "updatedAt" = now()
       WHERE "id" = $1 AND lower("intentHash") = $2 AND "quoteUuid" = $3
         AND "status" = 'confirming' AND "verified" = 0
         AND lower("provisionalSettlementTxHash") = $4
         AND "provisionalSettlementBlockNumber" = $5::numeric
         AND lower("provisionalSettlementBlockHash") = $6
       RETURNING *`,
      [input.transactionId, normalized.intentHash, normalized.quoteUuid, normalized.txHash, normalized.blockNumber, normalized.blockHash],
    );
    if (result.rows[0]) return { outcome: "cleared", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const result = await db.update(transactions).set({ ...data, updatedAt: new Date() }).where(and(
        eq(transactions.id, input.transactionId),
        sql`lower(${transactions.intentHash}) = ${normalized.intentHash}`,
        eq(transactions.quoteUuid, normalized.quoteUuid),
        eq(transactions.status, "confirming"),
        eq(transactions.verified, 0),
        sql`lower(${transactions.provisionalSettlementTxHash}) = ${normalized.txHash}`,
        eq(transactions.provisionalSettlementBlockNumber, normalized.blockNumber),
        sql`lower(${transactions.provisionalSettlementBlockHash}) = ${normalized.blockHash}`,
      )).returning();
      if (result[0]) return { outcome: "cleared", transaction: result[0] };
    } else {
      const existing = memory.transactions.get(input.transactionId);
      const matching = existing
        && existing.status === "confirming"
        && existing.verified === 0
        && existing.quoteUuid === normalized.quoteUuid
        && existing.intentHash?.toLowerCase() === normalized.intentHash
        && existing.provisionalSettlementTxHash?.toLowerCase() === normalized.txHash
        && String(existing.provisionalSettlementBlockNumber) === normalized.blockNumber
        && existing.provisionalSettlementBlockHash?.toLowerCase() === normalized.blockHash;
      if (matching) {
        const updated = { ...existing, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(updated.id, updated);
        return { outcome: "cleared", transaction: updated };
      }
    }
  }
  const current = await getTransactionById(input.transactionId);
  const outcome = classify(current);
  return outcome === "not_found" ? { outcome } : { outcome, transaction: current! };
}

/**
 * Permanently records an exact finalized IntentMatched before querying the
 * secondary ERC-20 payout evidence. It is allowed to supersede the one narrow
 * no-settlement failure, making positive chain evidence authoritative in
 * either replica race order.
 */
export async function markSeraIntentMatchedEvidence(input: {
  transactionId: string;
  intentHash: string;
  quoteUuid: string;
  settlementTxHash: string;
  blockNumber: string;
  observedAt?: Date;
}): Promise<MarkSeraIntentMatchedEvidenceResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const quoteUuid = input.quoteUuid.trim();
  const settlementTxHash = input.settlementTxHash.trim().toLowerCase();
  const blockNumber = input.blockNumber.trim();
  const observedAt = input.observedAt ?? new Date();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!/^0x[0-9a-f]{64}$/.test(settlementTxHash)) throw new Error("settlementTxHash must be a 32-byte hex hash");
  if (!/^\d+$/.test(blockNumber)) throw new Error("blockNumber must be an unsigned integer string");
  if (!quoteUuid) throw new Error("quoteUuid cannot be empty");
  if (!validDate(observedAt)) throw new Error("observedAt must be a valid Date");

  const classify = (transaction: Transaction | undefined): Exclude<MarkSeraIntentMatchedEvidenceResult["outcome"], "claimed"> => {
    if (!transaction) return "not_found";
    if (
      transaction.id !== input.transactionId
      || transaction.quoteUuid !== quoteUuid
      || transaction.intentHash?.toLowerCase() !== intentHash
    ) return "binding_mismatch";
    if (transaction.status === "confirmed" && transaction.verified === 1 && transaction.submitState === "settled") {
      return "already_confirmed";
    }
    if (transaction.intentMatchedAt != null) return "already_marked";
    const unresolved = transaction.status === "confirming"
      && transaction.verified === 0
      && transaction.submitState != null
      && seraSettlementClaimableStateSet.has(transaction.submitState);
    const recoverableFailure = transaction.status === "failed"
      && transaction.verified === 0
      && transaction.submitState === "failed"
      && transaction.txHash == null
      && transaction.settlementTxHash == null;
    return unresolved || recoverableFailure ? "invalid_state" : "invalid_state";
  };
  const isClaimable = (transaction: Transaction | undefined) => Boolean(
    transaction
    && transaction.id === input.transactionId
    && transaction.quoteUuid === quoteUuid
    && transaction.intentHash?.toLowerCase() === intentHash
    && transaction.intentMatchedAt == null
    && (
      (transaction.status === "confirming"
        && transaction.verified === 0
        && transaction.submitState != null
        && seraSettlementClaimableStateSet.has(transaction.submitState))
      || (transaction.status === "failed"
        && transaction.verified === 0
        && transaction.submitState === "failed"
        && transaction.txHash == null
        && transaction.settlementTxHash == null)
    )
  );
  const data: SeraSwapLifecyclePatch = {
    status: "confirming",
    verified: 0,
    intentMatchedAt: observedAt,
    intentMatchedTxHash: settlementTxHash,
    intentMatchedBlockNumber: blockNumber,
    submitState: "settlement_unknown",
    seraStatus: "settlement_unknown",
    failureCode: "payout_evidence_pending",
    seraOutcomeSyncedAt: null,
    webhookSentAt: null,
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET "status" = 'confirming', "verified" = 0,
           "intentMatchedAt" = $1, "submitState" = 'settlement_unknown',
           "intentMatchedTxHash" = $2, "intentMatchedBlockNumber" = $3,
           "seraStatus" = 'settlement_unknown', "failureCode" = 'payout_evidence_pending',
           "seraOutcomeSyncedAt" = NULL, "webhookSentAt" = NULL,
           "updatedAt" = now()
       WHERE "id" = $4 AND "quoteUuid" = $5 AND lower("intentHash") = $6
         AND "intentMatchedAt" IS NULL
         AND (
           ("status" = 'confirming' AND "verified" = 0
             AND "submitState" IN ('submitting', 'submitted', 'settlement_unknown'))
           OR ("status" = 'failed' AND "verified" = 0 AND "submitState" = 'failed'
             AND "txHash" IS NULL AND "settlementTxHash" IS NULL)
         )
       RETURNING *`,
      [observedAt, settlementTxHash, blockNumber, input.transactionId, quoteUuid, intentHash],
    );
    if (result.rows[0]) return { outcome: "claimed", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const result = await db.update(transactions).set({ ...data, updatedAt: new Date() }).where(and(
        eq(transactions.id, input.transactionId),
        eq(transactions.quoteUuid, quoteUuid),
        sql`lower(${transactions.intentHash}) = ${intentHash}`,
        isNull(transactions.intentMatchedAt),
        or(
          and(
            eq(transactions.status, "confirming"),
            eq(transactions.verified, 0),
            inArray(transactions.submitState, [...SERA_SETTLEMENT_CLAIMABLE_STATES]),
          ),
          and(
            eq(transactions.status, "failed"),
            eq(transactions.verified, 0),
            eq(transactions.submitState, "failed"),
            isNull(transactions.txHash),
            isNull(transactions.settlementTxHash),
          ),
        ),
      )).returning();
      if (result[0]) return { outcome: "claimed", transaction: result[0] };
    } else {
      const transaction = memory.transactions.get(input.transactionId);
      if (isClaimable(transaction)) {
        const updated = { ...transaction!, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(updated.id, updated);
        return { outcome: "claimed", transaction: updated };
      }
    }
  }
  const current = await getTransactionById(input.transactionId);
  const outcome = classify(current);
  return outcome === "not_found" ? { outcome } : { outcome, transaction: current! };
}

/**
 * Pure settlement classifier used after a failed CAS and by unit tests.
 * `hashOwner` is an incompatible row found by the settlement hash (it may be
 * `transaction`). A compatible Sera row may share a batched settlement hash.
 */
export function classifySeraSwapSettlementConfirmation(
  transaction: Transaction | undefined,
  input: ClaimSeraSwapSettlementConfirmationInput,
  hashOwner?: Transaction | TerminalTransactionHashOwnership,
): SeraSwapSettlementConfirmationDecision {
  if (!transaction) return "not_found";

  const intentHash = input.intentHash.trim().toLowerCase();
  const txHash = input.txHash.trim().toLowerCase();
  const expectedQuoteUuid = input.expectedQuoteUuid?.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  const hashOwnership = hashOwner == null
    ? undefined
    : "kind" in hashOwner
      ? hashOwner
      : getTerminalTransactionHashOwnership(hashOwner);

  if (
    !/^0x[0-9a-f]{64}$/.test(intentHash)
    || !transaction.quoteUuid
    || !transaction.intentHash
    || transaction.intentHash.toLowerCase() !== intentHash
    || (expectedQuoteUuid != null && transaction.quoteUuid !== expectedQuoteUuid)
    || (expectedTradeId != null && transaction.tradeId !== expectedTradeId)
  ) {
    return "binding_mismatch";
  }

  if (
    !/^0x[0-9a-f]{64}$/.test(txHash)
    || (
      hashOwnership?.kind === "direct"
      && hashOwnership.txHash === txHash
    )
    || (transaction.txHash != null && transaction.txHash.toLowerCase() !== txHash)
    || (transaction.settlementTxHash != null && transaction.settlementTxHash.toLowerCase() !== txHash)
  ) {
    return "hash_conflict";
  }

  if (
    transaction.status === "confirmed"
    && transaction.verified === 1
    && transaction.submitState === "settled"
    && transaction.txHash?.toLowerCase() === txHash
    && transaction.settlementTxHash?.toLowerCase() === txHash
  ) {
    return "already_confirmed";
  }

  if (
    (
      transaction.status === "confirming"
      && transaction.verified === 0
      && transaction.submitState != null
      && seraSettlementClaimableStateSet.has(transaction.submitState)
    )
    || isRecoverableSeraNoSettlementFailure(transaction)
  ) {
    return "claimable";
  }

  return "invalid_state";
}

function databaseErrorHasConstraint(error: unknown, constraint: string, depth = 0): boolean {
  if (depth > 3 || error == null || typeof error !== "object") return false;
  const record = error as { constraint?: unknown; cause?: unknown };
  return record.constraint === constraint
    || databaseErrorHasConstraint(record.cause, constraint, depth + 1);
}

async function findIncompatibleTransactionBySettlementHash(
  txHash: string,
  excludeTransactionId?: string,
): Promise<Transaction | TerminalTransactionHashOwnership | undefined> {
  const normalized = txHash.toLowerCase();
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT "ownerKind", "directTransactionId"
       FROM "transaction_hash_ownership"
       WHERE "txHash" = $1 AND "ownerKind" = 'direct'
       LIMIT 1`,
      [normalized],
    );
    const owner = result.rows[0] as { ownerKind?: unknown; directTransactionId?: unknown } | undefined;
    if (
      owner?.ownerKind === "direct"
      && typeof owner.directTransactionId === "string"
    ) {
      return { kind: "direct", txHash: normalized, directTransactionId: owner.directTransactionId };
    }
    return undefined;
  }

  const db = await getDb();
  if (!db) {
    const owner = memory.transactionHashOwnership.get(normalized);
    return owner?.kind === "direct"
      ? owner
      : undefined;
  }
  const hashCondition = and(
    sql`lower(${transactions.txHash}) = ${normalized}`,
    isNull(transactions.intentHash),
    eq(transactions.status, "confirmed"),
    eq(transactions.verified, 1),
  );
  const result = await db.select().from(transactions).where(
    excludeTransactionId == null
      ? hashCondition
      : and(sql`${transactions.id} <> ${excludeTransactionId}`, hashCondition),
  );
  return result[0];
}

/**
 * Atomically grants one replica ownership of a verified Sera settlement.
 *
 * Only a confirming transaction whose single-use quote may already have left
 * this process can transition. `submitting` is included so a process crash
 * after POST /swap but before storing its response remains recoverable from
 * the authoritative on-chain proof. The exact
 * Intent is part of the compare-and-set, and both hash columns are written in
 * the same statement.  Callers emit payment notifications only for `claimed`;
 * `already_confirmed` is an idempotent success without notification ownership.
 */
export async function claimSeraSwapSettlementConfirmation(
  input: ClaimSeraSwapSettlementConfirmationInput,
): Promise<ClaimSeraSwapSettlementConfirmationResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const txHash = input.txHash.trim().toLowerCase();
  const expectedQuoteUuid = input.expectedQuoteUuid?.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
  if (expectedQuoteUuid != null && !expectedQuoteUuid) throw new Error("expectedQuoteUuid cannot be empty");
  if (expectedTradeId != null && !expectedTradeId) throw new Error("expectedTradeId cannot be empty");

  const patch = input.patch ?? {};
  for (const key of ["actualPayAmountRaw", "actualReceiveAmountRaw", "feeAmountRaw"] as const) {
    const value = patch[key];
    if (value != null && !/^\d+$/.test(value)) throw new Error(`${key} must be an unsigned integer string`);
  }

  const data: SeraSwapLifecyclePatch = {
    ...patch,
    status: "confirmed",
    verified: 1,
    txHash,
    settlementTxHash: txHash,
    submitState: "settled",
    seraStatus: "settled",
    provisionalSettlementAt: null,
    provisionalSettlementTxHash: null,
    provisionalSettlementBlockNumber: null,
    provisionalSettlementBlockHash: null,
    provisionalSettlementConfirmations: null,
    seraOutcomeSyncedAt: null,
    webhookSentAt: null,
    failureCode: null,
  };
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const pgPool = await getPostgresPool();

  try {
    if (pgPool) {
      const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
      const values = entries.map(([, value]) => normalizeDbValue(value));
      values.push(input.transactionId, intentHash, txHash);
      const transactionIdParameter = entries.length + 1;
      const intentHashParameter = entries.length + 2;
      const txHashParameter = entries.length + 3;
      let additionalBindings = "";
      if (expectedQuoteUuid != null) {
        values.push(expectedQuoteUuid);
        additionalBindings += ` AND "quoteUuid" = $${values.length}`;
      }
      if (expectedTradeId != null) {
        values.push(expectedTradeId);
        additionalBindings += ` AND "tradeId" = $${values.length}`;
      }
      const result = await pgPool.query(
        `UPDATE "transactions"
         SET ${set}, "updatedAt" = now()
         WHERE "id" = $${transactionIdParameter}
           AND lower("intentHash") = $${intentHashParameter}
           AND "quoteUuid" IS NOT NULL
           AND "verified" = 0
           AND (
             ("status" = 'confirming' AND "submitState" IN ('submitting', 'submitted', 'settlement_unknown'))
             OR ("status" = 'failed' AND "submitState" = 'failed'
               AND "failureCode" = '${SERA_NO_SETTLEMENT_FAILURE_CODE}'
               AND "intentMatchedAt" IS NULL
               AND "seraOutcomeSyncedAt" IS NULL)
           )
           AND ("txHash" IS NULL OR lower("txHash") = $${txHashParameter})
           AND ("settlementTxHash" IS NULL OR lower("settlementTxHash") = $${txHashParameter})
           ${additionalBindings}
         RETURNING *`,
        values,
      );
      if (result.rows[0]) return { outcome: "claimed", transaction: result.rows[0] as Transaction };
    } else {
      const db = await getDb();
      if (db) {
        const conditions = [
          eq(transactions.id, input.transactionId),
          sql`lower(${transactions.intentHash}) = ${intentHash}`,
          isNotNull(transactions.quoteUuid),
          eq(transactions.verified, 0),
          or(
            and(
              eq(transactions.status, "confirming"),
              inArray(transactions.submitState, [...SERA_SETTLEMENT_CLAIMABLE_STATES]),
            ),
            and(
              eq(transactions.status, "failed"),
              eq(transactions.submitState, "failed"),
              eq(transactions.failureCode, SERA_NO_SETTLEMENT_FAILURE_CODE),
              isNull(transactions.intentMatchedAt),
              isNull(transactions.seraOutcomeSyncedAt),
            ),
          ),
          or(isNull(transactions.txHash), sql`lower(${transactions.txHash}) = ${txHash}`),
          or(isNull(transactions.settlementTxHash), sql`lower(${transactions.settlementTxHash}) = ${txHash}`),
        ];
        if (expectedQuoteUuid != null) conditions.push(eq(transactions.quoteUuid, expectedQuoteUuid));
        if (expectedTradeId != null) conditions.push(eq(transactions.tradeId, expectedTradeId));
        const result = await db.update(transactions)
          .set({ ...data, updatedAt: new Date() })
          .where(and(...conditions))
          .returning();
        if (result[0]) return { outcome: "claimed", transaction: result[0] };
      } else {
        // There is no await between classification and Map.set, making this
        // compare-and-set indivisible within the Node event loop.
        const existing = memory.transactions.get(input.transactionId);
        const permanentOwner = memory.transactionHashOwnership.get(txHash);
        const hashOwner = permanentOwner?.kind === "direct"
          ? permanentOwner
          : Array.from(memory.transactions.values()).find((transaction) => (
              transaction.id !== input.transactionId
              && getTerminalTransactionHashOwnership(transaction)?.kind === "direct"
              && getTerminalTransactionHashOwnership(transaction)?.txHash === txHash
            ));
        const decision = classifySeraSwapSettlementConfirmation(
          existing,
          { ...input, intentHash, txHash, expectedQuoteUuid, expectedTradeId },
          hashOwner,
        );
        if (decision === "claimable" && existing) {
          const updated = { ...existing, ...data, updatedAt: now() } as Transaction;
          assertMemoryTerminalHashOwnership(updated);
          memory.transactions.set(input.transactionId, updated);
          return { outcome: "claimed", transaction: updated };
        }
        if (decision === "not_found") return { outcome: "not_found" };
        return { outcome: decision === "claimable" ? "invalid_state" : decision, transaction: existing! };
      }
    }
  } catch (error) {
    // Only the cross-kind ownership trigger is an expected settlement race.
    // Other uniqueness violations indicate schema drift or a programming
    // error and must remain visible rather than being misclassified.
    if (!databaseErrorHasConstraint(error, "transaction_hash_terminal_owner")) throw error;
  }

  const [current, hashOwner] = await Promise.all([
    getTransactionById(input.transactionId),
    findIncompatibleTransactionBySettlementHash(txHash, input.transactionId),
  ]);
  const decision = classifySeraSwapSettlementConfirmation(
    current,
    { ...input, intentHash, txHash, expectedQuoteUuid, expectedTradeId },
    hashOwner,
  );
  if (decision === "not_found") return { outcome: "not_found" };
  return {
    outcome: decision === "claimable" ? "invalid_state" : decision,
    transaction: current!,
  };
}

export type SeraSwapTerminalFailurePatch = Partial<Pick<InsertTransaction,
  | "notes"
  | "seraStatus"
>>;

export type ClaimSeraSwapTerminalFailureInput = {
  transactionId: string;
  /** Hash of the exact durable Intent covered by the empty settlement scan. */
  intentHash: string;
  /** Optional additional durable bindings when the caller has them. */
  expectedQuoteUuid?: string;
  expectedTradeId?: string;
  /**
   * Inclusive, gap-free range queried for IntentMatched. The through block
   * must be finalized according to the chain client before this helper is
   * called; the database can validate the range but cannot attest RPC data.
   */
  finalizedScanFromBlock: string;
  finalizedScanThroughBlock: string;
  /** Timestamp read from finalizedScanThroughBlock, not the local clock. */
  finalizedScanThroughTimestamp: Date;
  patch?: SeraSwapTerminalFailurePatch;
  /** Injectable only for deterministic deadline tests. */
  now?: Date;
};

export type SeraSwapTerminalFailureDecision =
  | "claimable"
  | "already_failed"
  | "already_confirmed"
  | "not_found"
  | "binding_mismatch"
  | "scan_incomplete"
  | "invalid_state";

export type ClaimSeraSwapTerminalFailureResult =
  | { outcome: "claimed"; transaction: Transaction }
  | {
      outcome: Exclude<SeraSwapTerminalFailureDecision, "claimable" | "not_found">;
      transaction: Transaction;
    }
  | { outcome: "not_found"; transaction?: undefined };

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Pure classifier for the post-deadline, no-settlement compare-and-set.
 *
 * A process crash immediately before or after POST /swap is deliberately
 * indistinguishable: both remain `submitting` until either an on-chain match
 * confirms them or a complete finalized scan proves that the Intent can no
 * longer settle. `submittedBlockNumber` is the durable lower-bound anchor.
 */
export function classifySeraSwapTerminalFailure(
  transaction: Transaction | undefined,
  input: ClaimSeraSwapTerminalFailureInput,
): SeraSwapTerminalFailureDecision {
  if (!transaction) return "not_found";

  const intentHash = input.intentHash.trim().toLowerCase();
  const expectedQuoteUuid = input.expectedQuoteUuid?.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  if (
    !/^0x[0-9a-f]{64}$/.test(intentHash)
    || !transaction.quoteUuid
    || !transaction.intentHash
    || transaction.intentHash.toLowerCase() !== intentHash
    || (expectedQuoteUuid != null && transaction.quoteUuid !== expectedQuoteUuid)
    || (expectedTradeId != null && transaction.tradeId !== expectedTradeId)
  ) {
    return "binding_mismatch";
  }

  if (
    transaction.status === "confirmed"
    && transaction.verified === 1
    && transaction.submitState === "settled"
  ) {
    return "already_confirmed";
  }
  if (isRecoverableSeraNoSettlementFailure(transaction)) return "already_failed";

  if (
    transaction.status !== "confirming"
    || transaction.verified !== 0
    || transaction.intentMatchedAt != null
    || transaction.provisionalSettlementAt != null
    || transaction.provisionalSettlementTxHash != null
    || transaction.provisionalSettlementBlockNumber != null
    || transaction.provisionalSettlementBlockHash != null
    || transaction.provisionalSettlementConfirmations != null
    || transaction.submitState == null
    || !seraSettlementClaimableStateSet.has(transaction.submitState)
    || transaction.txHash != null
    || transaction.settlementTxHash != null
  ) {
    return "invalid_state";
  }

  const nowAt = input.now ?? new Date();
  if (
    !/^\d+$/.test(input.finalizedScanFromBlock)
    || !/^\d+$/.test(input.finalizedScanThroughBlock)
    || !transaction.submittedBlockNumber
    || !/^\d+$/.test(transaction.submittedBlockNumber)
    || !transaction.intentDeadline
    || !validDate(new Date(transaction.intentDeadline))
    || !validDate(input.finalizedScanThroughTimestamp)
    || !validDate(nowAt)
  ) {
    return "scan_incomplete";
  }

  const scanFrom = BigInt(input.finalizedScanFromBlock);
  const scanThrough = BigInt(input.finalizedScanThroughBlock);
  const submittedBlock = BigInt(transaction.submittedBlockNumber);
  const intentDeadlineMs = new Date(transaction.intentDeadline).getTime();
  const scannedThroughTimestampMs = input.finalizedScanThroughTimestamp.getTime();
  const nowMs = nowAt.getTime();
  if (
    scanFrom > submittedBlock
    || scanThrough < submittedBlock
    || scanThrough < scanFrom
    || intentDeadlineMs > nowMs
    || intentDeadlineMs > scannedThroughTimestampMs
    || scannedThroughTimestampMs > nowMs
  ) {
    return "scan_incomplete";
  }

  return "claimable";
}

/**
 * Atomically marks a possibly-submitted swap failed only after a finalized,
 * post-deadline scan covered its submission anchor and found no Intent match.
 *
 * A verified settlement CAS is intentionally allowed to supersede this one
 * narrow failure code. Therefore an on-chain success is authoritative in
 * either race order, while unrelated failed/canceled rows remain immutable.
 * Only the caller receiving `claimed` owns failure notifications.
 */
export async function claimSeraSwapTerminalFailure(
  input: ClaimSeraSwapTerminalFailureInput,
): Promise<ClaimSeraSwapTerminalFailureResult> {
  const intentHash = input.intentHash.trim().toLowerCase();
  const expectedQuoteUuid = input.expectedQuoteUuid?.trim();
  const expectedTradeId = input.expectedTradeId?.trim();
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) throw new Error("intentHash must be a 32-byte hex hash");
  if (expectedQuoteUuid != null && !expectedQuoteUuid) throw new Error("expectedQuoteUuid cannot be empty");
  if (expectedTradeId != null && !expectedTradeId) throw new Error("expectedTradeId cannot be empty");
  if (!/^\d+$/.test(input.finalizedScanFromBlock)) throw new Error("finalizedScanFromBlock must be an unsigned integer string");
  if (!/^\d+$/.test(input.finalizedScanThroughBlock)) throw new Error("finalizedScanThroughBlock must be an unsigned integer string");
  if (!validDate(input.finalizedScanThroughTimestamp)) throw new Error("finalizedScanThroughTimestamp must be a valid Date");
  const checkTime = input.now ?? new Date();
  if (!validDate(checkTime)) throw new Error("now must be a valid Date");

  const scanFrom = BigInt(input.finalizedScanFromBlock).toString();
  const scanThrough = BigInt(input.finalizedScanThroughBlock).toString();
  const patch = input.patch ?? {};
  const data: SeraSwapLifecyclePatch = {
    ...patch,
    status: "failed",
    verified: 0,
    submitState: "failed",
    provisionalSettlementAt: null,
    provisionalSettlementTxHash: null,
    provisionalSettlementBlockNumber: null,
    provisionalSettlementBlockHash: null,
    provisionalSettlementConfirmations: null,
    seraOutcomeSyncedAt: null,
    webhookSentAt: null,
    failureCode: SERA_NO_SETTLEMENT_FAILURE_CODE,
  };
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const pgPool = await getPostgresPool();

  if (pgPool) {
    const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    values.push(
      input.transactionId,
      intentHash,
      checkTime,
      scanFrom,
      scanThrough,
      input.finalizedScanThroughTimestamp,
    );
    const transactionIdParameter = entries.length + 1;
    const intentHashParameter = entries.length + 2;
    const nowParameter = entries.length + 3;
    const scanFromParameter = entries.length + 4;
    const scanThroughParameter = entries.length + 5;
    const scanTimestampParameter = entries.length + 6;
    let additionalBindings = "";
    if (expectedQuoteUuid != null) {
      values.push(expectedQuoteUuid);
      additionalBindings += ` AND "quoteUuid" = $${values.length}`;
    }
    if (expectedTradeId != null) {
      values.push(expectedTradeId);
      additionalBindings += ` AND "tradeId" = $${values.length}`;
    }
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET ${set}, "updatedAt" = now()
       WHERE "id" = $${transactionIdParameter}
         AND lower("intentHash") = $${intentHashParameter}
         AND "quoteUuid" IS NOT NULL
         AND "status" = 'confirming'
         AND "verified" = 0
         AND "intentMatchedAt" IS NULL
         AND "provisionalSettlementAt" IS NULL
         AND "provisionalSettlementTxHash" IS NULL
         AND "provisionalSettlementBlockNumber" IS NULL
         AND "provisionalSettlementBlockHash" IS NULL
         AND "provisionalSettlementConfirmations" IS NULL
         AND "submitState" IN ('submitting', 'submitted', 'settlement_unknown')
         AND "txHash" IS NULL
         AND "settlementTxHash" IS NULL
         AND "intentDeadline" IS NOT NULL
         AND "intentDeadline" <= $${nowParameter}
         AND "intentDeadline" <= $${scanTimestampParameter}
         AND $${scanTimestampParameter} <= $${nowParameter}
         AND "submittedBlockNumber" IS NOT NULL
         AND "submittedBlockNumber" >= $${scanFromParameter}::numeric
         AND "submittedBlockNumber" <= $${scanThroughParameter}::numeric${additionalBindings}
       RETURNING *`,
      values,
    );
    if (result.rows[0]) return { outcome: "claimed", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const conditions = [
        eq(transactions.id, input.transactionId),
        sql`lower(${transactions.intentHash}) = ${intentHash}`,
        isNotNull(transactions.quoteUuid),
        eq(transactions.status, "confirming"),
        eq(transactions.verified, 0),
        isNull(transactions.intentMatchedAt),
        isNull(transactions.provisionalSettlementAt),
        isNull(transactions.provisionalSettlementTxHash),
        isNull(transactions.provisionalSettlementBlockNumber),
        isNull(transactions.provisionalSettlementBlockHash),
        isNull(transactions.provisionalSettlementConfirmations),
        inArray(transactions.submitState, [...SERA_SETTLEMENT_CLAIMABLE_STATES]),
        isNull(transactions.txHash),
        isNull(transactions.settlementTxHash),
        isNotNull(transactions.intentDeadline),
        lte(transactions.intentDeadline, checkTime),
        lte(transactions.intentDeadline, input.finalizedScanThroughTimestamp),
        sql`${input.finalizedScanThroughTimestamp} <= ${checkTime}`,
        isNotNull(transactions.submittedBlockNumber),
        gte(transactions.submittedBlockNumber, scanFrom),
        lte(transactions.submittedBlockNumber, scanThrough),
      ];
      if (expectedQuoteUuid != null) conditions.push(eq(transactions.quoteUuid, expectedQuoteUuid));
      if (expectedTradeId != null) conditions.push(eq(transactions.tradeId, expectedTradeId));
      const result = await db.update(transactions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      if (result[0]) return { outcome: "claimed", transaction: result[0] };
    } else {
      // No await separates classification from Map.set, so this remains an
      // indivisible compare-and-set in the in-memory test/development store.
      const existing = memory.transactions.get(input.transactionId);
      const decision = classifySeraSwapTerminalFailure(existing, {
        ...input,
        intentHash,
        expectedQuoteUuid,
        expectedTradeId,
        finalizedScanFromBlock: scanFrom,
        finalizedScanThroughBlock: scanThrough,
        now: checkTime,
      });
      if (decision === "claimable" && existing) {
        const updated = { ...existing, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(input.transactionId, updated);
        return { outcome: "claimed", transaction: updated };
      }
      if (decision === "not_found") return { outcome: "not_found" };
      return { outcome: decision === "claimable" ? "invalid_state" : decision, transaction: existing! };
    }
  }

  const current = await getTransactionById(input.transactionId);
  const decision = classifySeraSwapTerminalFailure(current, {
    ...input,
    intentHash,
    expectedQuoteUuid,
    expectedTradeId,
    finalizedScanFromBlock: scanFrom,
    finalizedScanThroughBlock: scanThrough,
    now: checkTime,
  });
  if (decision === "not_found") return { outcome: "not_found" };
  return {
    outcome: decision === "claimable" ? "invalid_state" : decision,
    transaction: current!,
  };
}

export type SeraSwapTerminalOutcome =
  | {
      kind: "confirmed";
      quoteUuid: string;
      intentHash: string;
      txHash: string;
    }
  | {
      kind: "failed";
      quoteUuid: string;
      intentHash: string;
      failureCode: string;
    };

/**
 * Return a stable fingerprint only for a complete Phase-1 terminal state.
 * Linked-outcome workers carry this fingerprint from prepare to complete, so
 * an authoritative success that supersedes a no-settlement failure cannot be
 * acknowledged using the stale failure result.
 */
export function getSeraSwapTerminalOutcome(
  transaction: Transaction | undefined,
): SeraSwapTerminalOutcome | null {
  if (!transaction?.quoteUuid || !transaction.intentHash) return null;
  const quoteUuid = transaction.quoteUuid.trim();
  const intentHash = transaction.intentHash.trim().toLowerCase();
  if (!quoteUuid || !/^0x[0-9a-f]{64}$/.test(intentHash)) return null;

  if (
    transaction.status === "confirmed"
    && transaction.verified === 1
    && transaction.submitState === "settled"
    && transaction.txHash
    && transaction.settlementTxHash
  ) {
    const txHash = transaction.txHash.trim().toLowerCase();
    if (
      /^0x[0-9a-f]{64}$/.test(txHash)
      && transaction.settlementTxHash.trim().toLowerCase() === txHash
    ) {
      return { kind: "confirmed", quoteUuid, intentHash, txHash };
    }
  }

  if (
    transaction.status === "failed"
    && transaction.verified === 0
    && transaction.intentMatchedAt == null
    && transaction.submitState === "failed"
    && transaction.failureCode?.trim()
    && transaction.txHash == null
    && transaction.settlementTxHash == null
  ) {
    return {
      kind: "failed",
      quoteUuid,
      intentHash,
      failureCode: transaction.failureCode.trim(),
    };
  }

  return null;
}

type SeraLinkedOutcomeReferences = {
  orderId: string | null;
  paymentIntentId: string | null;
};

function parseSeraLinkedOutcomeReferences(notes: string | null): SeraLinkedOutcomeReferences {
  if (!notes) return { orderId: null, paymentIntentId: null };
  try {
    const value = JSON.parse(notes) as Record<string, unknown>;
    const orderId = typeof value.orderId === "string" ? value.orderId.trim() : "";
    const paymentIntentId = typeof value.paymentIntentId === "string" ? value.paymentIntentId.trim() : "";
    return {
      orderId: orderId || null,
      paymentIntentId: paymentIntentId || null,
    };
  } catch {
    return { orderId: null, paymentIntentId: null };
  }
}

type SeraLinkedOutcomePlan = {
  menuOrderPatches: Array<{
    id: string;
    status: string;
    paymentId: string | null;
    transactionId: string | null;
    paymentIntentId: string | null;
  }>;
  paymentIntentPatches: Array<{
    id: string;
    status: "paid" | "failed";
    transactionId: string | null;
  }>;
};

type SeraLinkedOutcomeConflict = {
  resource: "menu_order" | "payment_intent";
  id: string;
};

function planSeraLinkedOutcomeSync(
  transaction: Transaction,
  terminalOutcome: SeraSwapTerminalOutcome,
  references: SeraLinkedOutcomeReferences,
  orders: MenuOrder[],
  intents: PaymentIntent[],
): SeraLinkedOutcomePlan | SeraLinkedOutcomeConflict {
  for (const order of orders) {
    if (
      order.merchantId !== transaction.merchantId
      || (order.transactionId != null && order.transactionId !== transaction.id)
      || (order.paymentId != null && order.paymentId !== transaction.id)
      || (
        references.paymentIntentId != null
        && order.paymentIntentId != null
        && order.paymentIntentId !== references.paymentIntentId
      )
    ) {
      return { resource: "menu_order", id: order.id };
    }
  }
  for (const intent of intents) {
    if (
      intent.merchantId !== transaction.merchantId
      || (intent.transactionId != null && intent.transactionId !== transaction.id)
    ) {
      return { resource: "payment_intent", id: intent.id };
    }
  }

  const menuOrderPatches: SeraLinkedOutcomePlan["menuOrderPatches"] = [];
  for (const order of orders) {
    // A failed swap must never erase a paid result from another authoritative
    // payment path. Leave the whole paid row untouched, including an absent
    // binding, unless this Sera transaction itself is confirmed.
    if (terminalOutcome.kind === "failed" && order.status === "paid") continue;
    menuOrderPatches.push({
      id: order.id,
      status: terminalOutcome.kind === "confirmed" ? "paid" : "failed",
      paymentId: order.paymentId ?? transaction.id,
      transactionId: order.transactionId ?? transaction.id,
      paymentIntentId: order.paymentIntentId ?? references.paymentIntentId,
    });
  }

  const paymentIntentPatches: SeraLinkedOutcomePlan["paymentIntentPatches"] = [];
  for (const intent of intents) {
    if (terminalOutcome.kind === "failed" && intent.status === "paid") continue;
    paymentIntentPatches.push({
      id: intent.id,
      status: terminalOutcome.kind === "confirmed" ? "paid" : "failed",
      transactionId: intent.transactionId ?? transaction.id,
    });
  }
  return { menuOrderPatches, paymentIntentPatches };
}

function isSeraLinkedOutcomeConflict(
  value: SeraLinkedOutcomePlan | SeraLinkedOutcomeConflict,
): value is SeraLinkedOutcomeConflict {
  return "resource" in value;
}

export type PrepareSeraSwapOutcomeSyncResult =
  | {
      outcome: "prepared";
      transaction: Transaction;
      terminalOutcome: SeraSwapTerminalOutcome;
    }
  | {
      outcome: "already_synced" | "invalid_state";
      transaction: Transaction;
      terminalOutcome: SeraSwapTerminalOutcome | null;
    }
  | {
      outcome: "binding_conflict";
      transaction: Transaction;
      terminalOutcome: SeraSwapTerminalOutcome;
      resource: "menu_order" | "payment_intent";
      resourceId: string;
    }
  | { outcome: "not_found"; transaction?: undefined; terminalOutcome?: undefined };

function classifySeraOutcomePreparation(
  transaction: Transaction | undefined,
): Exclude<PrepareSeraSwapOutcomeSyncResult, { outcome: "binding_conflict" }> {
  if (!transaction) return { outcome: "not_found" };
  const terminalOutcome = getSeraSwapTerminalOutcome(transaction);
  if (!terminalOutcome) return { outcome: "invalid_state", transaction, terminalOutcome: null };
  if (transaction.seraOutcomeSyncedAt != null) {
    return { outcome: "already_synced", transaction, terminalOutcome };
  }
  return { outcome: "prepared", transaction, terminalOutcome };
}

function menuOrderMatchesSeraOutcomeReference(
  order: MenuOrder,
  transactionId: string,
  orderId: string | null,
  paymentIntentId: string | null,
): boolean {
  return order.id === orderId
    || order.transactionId === transactionId
    || order.paymentId === transactionId
    || (paymentIntentId != null && order.paymentIntentId === paymentIntentId);
}

/**
 * Lock the terminal Sera transaction and synchronize every discoverable bound
 * menu order/payment intent in the same database transaction. This operation
 * intentionally leaves `seraOutcomeSyncedAt` null: external effects happen
 * after commit, and `completeSeraSwapOutcomeSync` acknowledges them with the
 * exact terminal fingerprint.
 */
export async function prepareSeraSwapOutcomeSync(
  transactionId: string,
): Promise<PrepareSeraSwapOutcomeSyncResult> {
  const normalizedTransactionId = transactionId.trim();
  if (!normalizedTransactionId) throw new Error("transactionId cannot be empty");

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const transactionResult = await client.query(
        `SELECT * FROM "transactions" WHERE "id" = $1 FOR UPDATE`,
        [normalizedTransactionId],
      );
      const transaction = transactionResult.rows[0] as Transaction | undefined;
      const classification = classifySeraOutcomePreparation(transaction);
      if (classification.outcome !== "prepared") {
        await client.query("COMMIT");
        return classification;
      }

      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      const orderResult = await client.query(
        `SELECT * FROM "menu_orders"
         WHERE "transactionId" = $1 OR "paymentId" = $1
           OR ($2::varchar IS NOT NULL AND "id" = $2)
           OR ($3::varchar IS NOT NULL AND "paymentIntentId" = $3)
         FOR UPDATE`,
        [normalizedTransactionId, references.orderId, references.paymentIntentId],
      );
      const orders = orderResult.rows as MenuOrder[];
      const paymentIntentIds = Array.from(new Set([
        references.paymentIntentId,
        ...orders.map((order) => order.paymentIntentId),
      ].filter((id): id is string => typeof id === "string" && id.length > 0)));
      const intentResult = paymentIntentIds.length === 0
        ? { rows: [] }
        : await client.query(
            `SELECT * FROM "payment_intents" WHERE "id" = ANY($1::varchar[]) FOR UPDATE`,
            [paymentIntentIds],
          );
      const plan = planSeraLinkedOutcomeSync(
        transaction!,
        classification.terminalOutcome,
        references,
        orders,
        intentResult.rows as PaymentIntent[],
      );
      if (isSeraLinkedOutcomeConflict(plan)) {
        await client.query("ROLLBACK");
        return {
          outcome: "binding_conflict",
          transaction: transaction!,
          terminalOutcome: classification.terminalOutcome,
          resource: plan.resource,
          resourceId: plan.id,
        };
      }

      for (const order of plan.menuOrderPatches) {
        await client.query(
          `UPDATE "menu_orders"
           SET "status" = $1, "paymentId" = $2, "transactionId" = $3,
               "paymentIntentId" = $4, "updatedAt" = now()
           WHERE "id" = $5`,
          [order.status, order.paymentId, order.transactionId, order.paymentIntentId, order.id],
        );
      }
      for (const intent of plan.paymentIntentPatches) {
        await client.query(
          `UPDATE "payment_intents"
           SET "status" = $1, "transactionId" = $2, "updatedAt" = now()
           WHERE "id" = $3`,
          [intent.status, intent.transactionId, intent.id],
        );
      }
      await client.query("COMMIT");
      return classification;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await getDb();
  if (db) {
    return db.transaction(async (database: any): Promise<PrepareSeraSwapOutcomeSyncResult> => {
      const transactionResult = await database.select().from(transactions)
        .where(eq(transactions.id, normalizedTransactionId)).limit(1).for("update");
      const transaction = transactionResult[0] as Transaction | undefined;
      const classification = classifySeraOutcomePreparation(transaction);
      if (classification.outcome !== "prepared") return classification;

      const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
      const orderConditions = [
        eq(menuOrders.transactionId, normalizedTransactionId),
        eq(menuOrders.paymentId, normalizedTransactionId),
      ];
      if (references.orderId != null) orderConditions.push(eq(menuOrders.id, references.orderId));
      if (references.paymentIntentId != null) {
        orderConditions.push(eq(menuOrders.paymentIntentId, references.paymentIntentId));
      }
      const orders = await database.select().from(menuOrders)
        .where(or(...orderConditions)).for("update") as MenuOrder[];
      const paymentIntentIds = Array.from(new Set([
        references.paymentIntentId,
        ...orders.map((order) => order.paymentIntentId),
      ].filter((id): id is string => typeof id === "string" && id.length > 0)));
      const intents = paymentIntentIds.length === 0
        ? []
        : await database.select().from(paymentIntents)
            .where(inArray(paymentIntents.id, paymentIntentIds)).for("update") as PaymentIntent[];
      const plan = planSeraLinkedOutcomeSync(
        transaction!,
        classification.terminalOutcome,
        references,
        orders,
        intents,
      );
      if (isSeraLinkedOutcomeConflict(plan)) {
        return {
          outcome: "binding_conflict",
          transaction: transaction!,
          terminalOutcome: classification.terminalOutcome,
          resource: plan.resource,
          resourceId: plan.id,
        };
      }
      for (const order of plan.menuOrderPatches) {
        await database.update(menuOrders).set({
          status: order.status,
          paymentId: order.paymentId,
          transactionId: order.transactionId,
          paymentIntentId: order.paymentIntentId,
          updatedAt: new Date(),
        }).where(eq(menuOrders.id, order.id));
      }
      for (const intent of plan.paymentIntentPatches) {
        await database.update(paymentIntents).set({
          status: intent.status,
          transactionId: intent.transactionId,
          updatedAt: new Date(),
        }).where(eq(paymentIntents.id, intent.id));
      }
      return classification;
    });
  }

  // After getDb() resolves there is no await in this branch, so validation and
  // all related Map writes are indivisible in the in-memory event loop.
  const transaction = memory.transactions.get(normalizedTransactionId);
  const classification = classifySeraOutcomePreparation(transaction);
  if (classification.outcome !== "prepared") return classification;
  const references = parseSeraLinkedOutcomeReferences(transaction!.notes);
  const orders = Array.from(memory.menuOrders.values()).filter((order) => (
    menuOrderMatchesSeraOutcomeReference(
      order,
      normalizedTransactionId,
      references.orderId,
      references.paymentIntentId,
    )
  ));
  const paymentIntentIds = new Set([
    references.paymentIntentId,
    ...orders.map((order) => order.paymentIntentId),
  ].filter((id): id is string => typeof id === "string" && id.length > 0));
  const intents = Array.from(memory.paymentIntents.values()).filter((intent) => paymentIntentIds.has(intent.id));
  const plan = planSeraLinkedOutcomeSync(
    transaction!,
    classification.terminalOutcome,
    references,
    orders,
    intents,
  );
  if (isSeraLinkedOutcomeConflict(plan)) {
    return {
      outcome: "binding_conflict",
      transaction: transaction!,
      terminalOutcome: classification.terminalOutcome,
      resource: plan.resource,
      resourceId: plan.id,
    };
  }
  const updatedAt = now();
  for (const order of plan.menuOrderPatches) {
    const existing = memory.menuOrders.get(order.id)!;
    memory.menuOrders.set(order.id, { ...existing, ...order, updatedAt } as MenuOrder);
  }
  for (const intent of plan.paymentIntentPatches) {
    const existing = memory.paymentIntents.get(intent.id)!;
    memory.paymentIntents.set(intent.id, {
      ...existing,
      status: intent.status,
      transactionId: intent.transactionId,
      updatedAt,
    } as PaymentIntent);
  }
  return classification;
}

export type CompleteSeraSwapOutcomeSyncInput = {
  transactionId: string;
  /** Exact fingerprint returned by prepareSeraSwapOutcomeSync. */
  terminalOutcome: SeraSwapTerminalOutcome;
  /** Delivery may fail; only a true delivered result writes webhookSentAt. */
  webhookRequested?: boolean;
  webhookDelivered?: boolean;
  /** Injectable for deterministic tests. */
  completedAt?: Date;
};

export type CompleteSeraSwapOutcomeSyncResult =
  | { outcome: "completed" | "already_synced" | "state_changed"; transaction: Transaction }
  | { outcome: "not_found"; transaction?: undefined };

function normalizeSeraTerminalOutcome(outcome: SeraSwapTerminalOutcome): SeraSwapTerminalOutcome {
  const quoteUuid = outcome.quoteUuid.trim();
  const intentHash = outcome.intentHash.trim().toLowerCase();
  if (!quoteUuid) throw new Error("terminalOutcome.quoteUuid cannot be empty");
  if (!/^0x[0-9a-f]{64}$/.test(intentHash)) {
    throw new Error("terminalOutcome.intentHash must be a 32-byte hex hash");
  }
  if (outcome.kind === "confirmed") {
    const txHash = outcome.txHash.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      throw new Error("terminalOutcome.txHash must be a 32-byte hex hash");
    }
    return { kind: "confirmed", quoteUuid, intentHash, txHash };
  }
  const failureCode = outcome.failureCode.trim();
  if (!failureCode) throw new Error("terminalOutcome.failureCode cannot be empty");
  return { kind: "failed", quoteUuid, intentHash, failureCode };
}

function sameSeraTerminalOutcome(
  current: SeraSwapTerminalOutcome | null,
  expected: SeraSwapTerminalOutcome,
): boolean {
  if (!current || current.kind !== expected.kind) return false;
  if (current.quoteUuid !== expected.quoteUuid || current.intentHash !== expected.intentHash) return false;
  return current.kind === "confirmed"
    ? current.txHash === (expected as Extract<SeraSwapTerminalOutcome, { kind: "confirmed" }>).txHash
    : current.failureCode === (expected as Extract<SeraSwapTerminalOutcome, { kind: "failed" }>).failureCode;
}

/**
 * Acknowledge external outcome delivery only if the transaction still has the
 * exact terminal fingerprint prepared by the caller. For confirmed swaps this
 * includes both persisted settlement hash columns; for failures it includes
 * the exact failure code and absence of settlement hashes.
 */
export async function completeSeraSwapOutcomeSync(
  input: CompleteSeraSwapOutcomeSyncInput,
): Promise<CompleteSeraSwapOutcomeSyncResult> {
  const transactionId = input.transactionId.trim();
  if (!transactionId) throw new Error("transactionId cannot be empty");
  const terminalOutcome = normalizeSeraTerminalOutcome(input.terminalOutcome);
  const webhookRequested = input.webhookRequested === true;
  const webhookDelivered = input.webhookDelivered === true;
  if (webhookDelivered && !webhookRequested) {
    throw new Error("A delivered webhook must also have been requested");
  }
  const completedAt = input.completedAt ?? new Date();
  if (!validDate(completedAt)) throw new Error("completedAt must be a valid Date");
  const data: SeraSwapLifecyclePatch = {
    seraOutcomeSyncedAt: completedAt,
    webhookSentAt: webhookDelivered ? completedAt : null,
  };

  const pgPool = await getPostgresPool();
  if (pgPool) {
    const values: unknown[] = [completedAt, transactionId, terminalOutcome.quoteUuid, terminalOutcome.intentHash];
    const webhookSet = webhookDelivered ? `, "webhookSentAt" = $1` : `, "webhookSentAt" = NULL`;
    let terminalPredicate: string;
    if (terminalOutcome.kind === "confirmed") {
      values.push(terminalOutcome.txHash);
      terminalPredicate = `"status" = 'confirmed' AND "verified" = 1 AND "submitState" = 'settled'
        AND lower("txHash") = $5 AND lower("settlementTxHash") = $5`;
    } else {
      values.push(terminalOutcome.failureCode);
      terminalPredicate = `"status" = 'failed' AND "verified" = 0 AND "submitState" = 'failed'
        AND "failureCode" = $5 AND "intentMatchedAt" IS NULL
        AND "txHash" IS NULL AND "settlementTxHash" IS NULL`;
    }
    const result = await pgPool.query(
      `UPDATE "transactions"
       SET "seraOutcomeSyncedAt" = $1${webhookSet}, "updatedAt" = now()
       WHERE "id" = $2 AND "quoteUuid" = $3 AND lower("intentHash") = $4
         AND "seraOutcomeSyncedAt" IS NULL AND ${terminalPredicate}
       RETURNING *`,
      values,
    );
    if (result.rows[0]) return { outcome: "completed", transaction: result.rows[0] as Transaction };
  } else {
    const db = await getDb();
    if (db) {
      const terminalConditions = terminalOutcome.kind === "confirmed"
        ? [
            eq(transactions.status, "confirmed"),
            eq(transactions.verified, 1),
            eq(transactions.submitState, "settled"),
            sql`lower(${transactions.txHash}) = ${terminalOutcome.txHash}`,
            sql`lower(${transactions.settlementTxHash}) = ${terminalOutcome.txHash}`,
          ]
        : [
            eq(transactions.status, "failed"),
            eq(transactions.verified, 0),
            eq(transactions.submitState, "failed"),
            eq(transactions.failureCode, terminalOutcome.failureCode),
            isNull(transactions.intentMatchedAt),
            isNull(transactions.txHash),
            isNull(transactions.settlementTxHash),
          ];
      const result = await db.update(transactions).set({ ...data, updatedAt: new Date() }).where(and(
        eq(transactions.id, transactionId),
        eq(transactions.quoteUuid, terminalOutcome.quoteUuid),
        sql`lower(${transactions.intentHash}) = ${terminalOutcome.intentHash}`,
        isNull(transactions.seraOutcomeSyncedAt),
        ...terminalConditions,
      )).returning();
      if (result[0]) return { outcome: "completed", transaction: result[0] };
    } else {
      const current = memory.transactions.get(transactionId);
      if (current && current.seraOutcomeSyncedAt == null
        && sameSeraTerminalOutcome(getSeraSwapTerminalOutcome(current), terminalOutcome)) {
        const updated = { ...current, ...data, updatedAt: now() } as Transaction;
        memory.transactions.set(transactionId, updated);
        return { outcome: "completed", transaction: updated };
      }
    }
  }

  const current = await getTransactionById(transactionId);
  if (!current) return { outcome: "not_found" };
  const sameOutcome = sameSeraTerminalOutcome(getSeraSwapTerminalOutcome(current), terminalOutcome);
  return {
    outcome: sameOutcome && current.seraOutcomeSyncedAt != null ? "already_synced" : "state_changed",
    transaction: current,
  };
}

/** Oldest terminal Sera outcomes whose linked/external effects remain due. */
export async function getUnsyncedSeraSwapOutcomes(limit = 100): Promise<Transaction[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions"
       WHERE "quoteUuid" IS NOT NULL AND btrim("quoteUuid") <> ''
         AND COALESCE("intentHash" ~* '^0x[0-9a-f]{64}$', FALSE)
         AND "seraOutcomeSyncedAt" IS NULL
         AND (
           ("status" = 'confirmed' AND "verified" = 1 AND "submitState" = 'settled'
             AND COALESCE("txHash" ~* '^0x[0-9a-f]{64}$', FALSE)
             AND lower("settlementTxHash") = lower("txHash"))
           OR
           ("status" = 'failed' AND "verified" = 0 AND "submitState" = 'failed'
             AND "intentMatchedAt" IS NULL
             AND "failureCode" IS NOT NULL AND btrim("failureCode") <> ''
             AND "txHash" IS NULL AND "settlementTxHash" IS NULL)
         )
       ORDER BY "updatedAt" ASC, "id" ASC
       LIMIT $1`,
      [boundedLimit],
    );
    return (result.rows as Transaction[]).filter((transaction) => getSeraSwapTerminalOutcome(transaction) != null);
  }

  const db = await getDb();
  if (!db) {
    return Array.from(memory.transactions.values())
      .filter((transaction) => transaction.seraOutcomeSyncedAt == null && getSeraSwapTerminalOutcome(transaction) != null)
      .sort((a, b) => {
        const timestampDifference = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        return timestampDifference || a.id.localeCompare(b.id);
      })
      .slice(0, boundedLimit);
  }
  const result = await db.select().from(transactions).where(and(
    isNotNull(transactions.quoteUuid),
    isNotNull(transactions.intentHash),
    sql`btrim(${transactions.quoteUuid}) <> ''`,
    sql`COALESCE(${transactions.intentHash} ~* '^0x[0-9a-f]{64}$', FALSE)`,
    isNull(transactions.seraOutcomeSyncedAt),
    or(
      and(
        eq(transactions.status, "confirmed"),
        eq(transactions.verified, 1),
        eq(transactions.submitState, "settled"),
        isNotNull(transactions.txHash),
        sql`COALESCE(${transactions.txHash} ~* '^0x[0-9a-f]{64}$', FALSE)`,
        sql`lower(${transactions.settlementTxHash}) = lower(${transactions.txHash})`,
      ),
      and(
        eq(transactions.status, "failed"),
        eq(transactions.verified, 0),
        eq(transactions.submitState, "failed"),
        isNull(transactions.intentMatchedAt),
        isNotNull(transactions.failureCode),
        sql`btrim(${transactions.failureCode}) <> ''`,
        isNull(transactions.txHash),
        isNull(transactions.settlementTxHash),
      ),
    ),
  )).orderBy(asc(transactions.updatedAt), asc(transactions.id)).limit(boundedLimit);
  return (result as Transaction[]).filter((transaction) => getSeraSwapTerminalOutcome(transaction) != null);
}

/**
 * Move a poisoned/conflicting terminal outcome behind other due work without
 * pretending its effects completed. The next maintenance pass retries it,
 * while a fixed oldest-first page can continue making global progress.
 */
export async function deferSeraSwapOutcomeSync(transactionId: string): Promise<void> {
  const id = transactionId.trim();
  if (!id) throw new Error("transactionId cannot be empty");
  const pgPool = await getPostgresPool();
  if (pgPool) {
    await pgPool.query(
      `UPDATE "transactions" SET "updatedAt" = now()
       WHERE "id" = $1 AND "seraOutcomeSyncedAt" IS NULL
         AND (
           ("status" = 'confirmed' AND "verified" = 1 AND "submitState" = 'settled')
           OR ("status" = 'failed' AND "verified" = 0 AND "submitState" = 'failed')
         )`,
      [id],
    );
    return;
  }
  const db = await getDb();
  if (db) {
    await db.update(transactions).set({ updatedAt: new Date() }).where(and(
      eq(transactions.id, id),
      isNull(transactions.seraOutcomeSyncedAt),
      or(
        and(eq(transactions.status, "confirmed"), eq(transactions.verified, 1), eq(transactions.submitState, "settled")),
        and(eq(transactions.status, "failed"), eq(transactions.verified, 0), eq(transactions.submitState, "failed")),
      ),
    ));
    return;
  }
  const transaction = memory.transactions.get(id);
  if (transaction && transaction.seraOutcomeSyncedAt == null && getSeraSwapTerminalOutcome(transaction)) {
    memory.transactions.set(id, { ...transaction, updatedAt: now() } as Transaction);
  }
}

export async function getMerchantTransactions(merchantId: string, limit = 50, offset = 0): Promise<Transaction[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions" WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
      [merchantId, limit, offset],
    );
    return result.rows as Transaction[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values())
    .filter((tx) => tx.merchantId === merchantId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(offset, offset + limit);
  return db.select().from(transactions)
    .where(eq(transactions.merchantId, merchantId))
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getPendingTransactions(): Promise<Transaction[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions" WHERE "status" IN ('pending', 'confirming') AND "verified" = 0 ORDER BY "createdAt" DESC LIMIT 100`,
    );
    return result.rows as Transaction[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values())
    .filter((tx) => (tx.status === "pending" || tx.status === "confirming") && tx.verified === 0)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, 100);
  return db.select().from(transactions)
    .where(and(or(eq(transactions.status, "pending"), eq(transactions.status, "confirming")), eq(transactions.verified, 0)))
    .orderBy(desc(transactions.createdAt))
    .limit(100);
}

/**
 * A separate recovery queue for Sera swaps.
 *
 * The generic pending query intentionally serves the direct-transfer scanner
 * and is capped to the newest 100 rows. Reusing it for swap recovery can leave
 * an older submitted Intent unreconciled indefinitely whenever newer pending
 * payments keep arriving. Sera ownership is therefore detected from its
 * first-class lifecycle columns and processed oldest first.
 */
export const DEFAULT_SERA_RECONCILIATION_BATCH_SIZE = 500;
export const MAX_SERA_RECONCILIATION_BATCH_SIZE = 2_000;

type SeraReconciliationCandidate = Pick<
  Transaction,
  "status" | "verified" | "quoteUuid" | "intentHash" | "submitState"
>;

export function isUnresolvedSeraSwapForReconciliation(
  transaction: SeraReconciliationCandidate,
): boolean {
  return transaction.status === "confirming"
    && transaction.verified === 0
    && (
      transaction.quoteUuid != null
      || transaction.intentHash != null
      || transaction.submitState != null
    );
}

function normalizeSeraReconciliationBatchSize(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SERA_RECONCILIATION_BATCH_SIZE;
  return Math.min(MAX_SERA_RECONCILIATION_BATCH_SIZE, Math.max(1, Math.trunc(limit)));
}

export async function getPendingSeraSwapTransactions(
  limit = DEFAULT_SERA_RECONCILIATION_BATCH_SIZE,
): Promise<Transaction[]> {
  const batchSize = normalizeSeraReconciliationBatchSize(limit);
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT *
         FROM "transactions"
        WHERE "status" = 'confirming'
          AND "verified" = 0
          AND ("quoteUuid" IS NOT NULL OR "intentHash" IS NOT NULL OR "submitState" IS NOT NULL)
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT $1`,
      [batchSize],
    );
    return result.rows as Transaction[];
  }

  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values())
    .filter(isUnresolvedSeraSwapForReconciliation)
    .sort((a, b) => {
      const createdAtDifference = +new Date(a.createdAt) - +new Date(b.createdAt);
      return createdAtDifference || a.id.localeCompare(b.id);
    })
    .slice(0, batchSize);

  return db.select().from(transactions)
    .where(and(
      eq(transactions.status, "confirming"),
      eq(transactions.verified, 0),
      or(
        isNotNull(transactions.quoteUuid),
        isNotNull(transactions.intentHash),
        isNotNull(transactions.submitState),
      ),
    ))
    .orderBy(asc(transactions.createdAt), asc(transactions.id))
    .limit(batchSize);
}

/**
 * Small newest-first hot queue used only for payer-facing acknowledgement.
 * Apply Sera predicates before LIMIT so a burst of direct QR watch rows cannot
 * crowd every just-submitted swap out of the five-second path.
 */
export async function getRecentPendingSeraSwapTransactions(limit = 100): Promise<Transaction[]> {
  const batchSize = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 100)));
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT *
         FROM "transactions"
        WHERE "status" = 'confirming'
          AND "verified" = 0
          AND ("quoteUuid" IS NOT NULL OR "intentHash" IS NOT NULL OR "submitState" IS NOT NULL)
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT $1`,
      [batchSize],
    );
    return result.rows as Transaction[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values())
    .filter(isUnresolvedSeraSwapForReconciliation)
    .sort((left, right) => {
      const createdAtDifference = +new Date(right.createdAt) - +new Date(left.createdAt);
      return createdAtDifference || right.id.localeCompare(left.id);
    })
    .slice(0, batchSize);
  return db.select().from(transactions)
    .where(and(
      eq(transactions.status, "confirming"),
      eq(transactions.verified, 0),
      or(
        isNotNull(transactions.quoteUuid),
        isNotNull(transactions.intentHash),
        isNotNull(transactions.submitState),
      ),
    ))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(batchSize);
}

export async function createWebhookLog(data: InsertWebhookLog): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "webhook_logs", data); return; }
  const db = await getDb();
  if (!db) { memory.webhookLogs.set(data.id, { sentAt: now(), ...data } as WebhookLog); return; }
  await db.insert(webhookLogs).values(data);
}

export async function getTransactionsByFromAddress(fromAddress: string, limit = 50): Promise<Transaction[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "transactions" WHERE "fromAddress" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
      [fromAddress.toLowerCase(), limit],
    );
    return result.rows as Transaction[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values())
    .filter((tx) => tx.fromAddress === fromAddress.toLowerCase())
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, limit);
  return db.select().from(transactions)
    .where(eq(transactions.fromAddress, fromAddress.toLowerCase()))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

export async function getMerchantWebhookLogs(merchantId: string, limit = 50): Promise<WebhookLog[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "webhook_logs" WHERE "merchantId" = $1 ORDER BY "sentAt" DESC LIMIT $2`,
      [merchantId, limit],
    );
    return result.rows as WebhookLog[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.webhookLogs.values())
    .filter((log) => log.merchantId === merchantId)
    .sort((a, b) => +new Date(b.sentAt) - +new Date(a.sentAt))
    .slice(0, limit);
  return db.select().from(webhookLogs)
    .where(eq(webhookLogs.merchantId, merchantId))
    .orderBy(desc(webhookLogs.sentAt))
    .limit(limit);
}

export async function getApiKeyConfigRecord(merchantId: string): Promise<ApiKeyConfigRecord | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<ApiKeyConfigRecord>(pgPool, "api_key_configs", `"merchantId" = $1`, [merchantId]);
  const db = await getDb();
  if (!db) return memory.apiKeyConfigs.get(merchantId);
  const result = await db.select().from(apiKeyConfigs).where(eq(apiKeyConfigs.merchantId, merchantId)).limit(1);
  return result[0];
}

export async function upsertApiKeyConfig(data: InsertApiKeyConfig): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => q(key)).join(", ");
    const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    const updates = entries
      .filter(([key]) => !["id", "merchantId", "createdAt"].includes(key))
      .map(([key]) => `${q(key)} = EXCLUDED.${q(key)}`)
      .concat(`"updatedAt" = now()`)
      .join(", ");
    await pgPool.query(
      `INSERT INTO "api_key_configs" (${columns}) VALUES (${placeholders})
       ON CONFLICT ("merchantId") DO UPDATE SET ${updates}`,
      values,
    );
    return;
  }
  const db = await getDb();
  if (!db) {
    const existing = memory.apiKeyConfigs.get(data.merchantId);
    memory.apiKeyConfigs.set(data.merchantId, { ...(existing ?? withTimestamps(data)), ...data, updatedAt: now() } as ApiKeyConfigRecord);
    return;
  }
  await db.insert(apiKeyConfigs).values(data).onConflictDoUpdate({
    target: apiKeyConfigs.merchantId,
    set: {
      seraApiBaseUrl: data.seraApiBaseUrl,
      seraApiKeyEncrypted: data.seraApiKeyEncrypted,
      seraApiKeyLast4: data.seraApiKeyLast4,
      seraWebhookSecretEncrypted: data.seraWebhookSecretEncrypted,
      seraWebhookSecretLast4: data.seraWebhookSecretLast4,
      mode: data.mode,
      updatedAt: new Date(),
    },
  });
}

export async function listSubWallets(merchantId: string): Promise<SubWallet[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "sub_wallets" WHERE "merchantId" = $1 AND "status" = 'active' ORDER BY "createdAt" DESC`,
      [merchantId],
    );
    return result.rows as SubWallet[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.subWallets.values())
    .filter((wallet) => wallet.merchantId === merchantId && wallet.status === "active")
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return db.select().from(subWallets)
    .where(and(eq(subWallets.merchantId, merchantId), eq(subWallets.status, "active")))
    .orderBy(desc(subWallets.createdAt));
}

export async function getSubWalletById(id: string): Promise<SubWallet | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<SubWallet>(pgPool, "sub_wallets", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.subWallets.get(id);
  const result = await db.select().from(subWallets).where(eq(subWallets.id, id)).limit(1);
  return result[0];
}

export async function getSubWalletByAddress(address: string): Promise<SubWallet | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<SubWallet>(pgPool, "sub_wallets", `"address" = $1 AND "status" = 'active'`, [address.toLowerCase()]);
  const db = await getDb();
  if (!db) return Array.from(memory.subWallets.values()).find((wallet) => wallet.address === address.toLowerCase() && wallet.status === "active");
  const result = await db.select().from(subWallets).where(and(eq(subWallets.address, address.toLowerCase()), eq(subWallets.status, "active"))).limit(1);
  return result[0];
}

export async function createSubWallet(data: InsertSubWallet): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "sub_wallets", data); return; }
  const db = await getDb();
  if (!db) { memory.subWallets.set(data.id, withTimestamps(data) as SubWallet); return; }
  await db.insert(subWallets).values(data);
}

export async function updateSubWallet(id: string, data: Partial<InsertSubWallet>): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgUpdate(pgPool, "sub_wallets", id, data); return; }
  const db = await getDb();
  if (!db) {
    const existing = memory.subWallets.get(id);
    if (existing) memory.subWallets.set(id, { ...existing, ...data, updatedAt: now() } as SubWallet);
    return;
  }
  await db.update(subWallets).set({ ...data, updatedAt: new Date() }).where(eq(subWallets.id, id));
}

export async function listPaymentIntents(merchantId: string, limit = 50): Promise<PaymentIntent[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "payment_intents" WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
      [merchantId, limit],
    );
    return result.rows as PaymentIntent[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.paymentIntents.values())
    .filter((intent) => intent.merchantId === merchantId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, limit);
  return db.select().from(paymentIntents)
    .where(eq(paymentIntents.merchantId, merchantId))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit);
}

export async function getPaymentIntentById(id: string): Promise<PaymentIntent | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<PaymentIntent>(pgPool, "payment_intents", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.paymentIntents.get(id);
  const result = await db.select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1);
  return result[0];
}

export async function createPaymentIntent(data: InsertPaymentIntent): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "payment_intents", data); return; }
  const db = await getDb();
  if (!db) { memory.paymentIntents.set(data.id, withTimestamps(data) as PaymentIntent); return; }
  await db.insert(paymentIntents).values(data);
}

export async function updatePaymentIntent(id: string, data: Partial<InsertPaymentIntent>): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgUpdate(pgPool, "payment_intents", id, data); return; }
  const db = await getDb();
  if (!db) {
    const existing = memory.paymentIntents.get(id);
    if (existing) memory.paymentIntents.set(id, { ...existing, ...data, updatedAt: now() } as PaymentIntent);
    return;
  }
  await db.update(paymentIntents).set(data).where(eq(paymentIntents.id, id));
}

/**
 * Change linked direct-payment resources only while this transaction remains
 * their durable owner. This makes delayed verification/failure effects unable
 * to overwrite a checkout that a newer Sera or direct attempt has claimed.
 */
export async function updateDirectLinkedPaymentStatus(input: {
  transactionId: string;
  merchantId: string;
  status: "paid" | "failed" | "canceled" | "payment_pending";
}): Promise<void> {
  const { transactionId, merchantId, status } = input;
  const intentStatus = status === "payment_pending" ? "open" : status;
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE "menu_orders" SET "status" = $1, "updatedAt" = now()
         WHERE "merchantId" = $2
           AND ("paymentId" = $3 OR "transactionId" = $3)
           AND ("paymentId" IS NULL OR "paymentId" = $3)
           AND ("transactionId" IS NULL OR "transactionId" = $3)`,
        [status, merchantId, transactionId],
      );
      await client.query(
        `UPDATE "payment_intents" SET "status" = $1, "updatedAt" = now()
         WHERE "merchantId" = $2 AND "transactionId" = $3`,
        [intentStatus, merchantId, transactionId],
      );
      await client.query("COMMIT");
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await getDb();
  if (db) {
    await db.transaction(async (database: any) => {
      await database.update(menuOrders).set({ status, updatedAt: new Date() }).where(and(
        eq(menuOrders.merchantId, merchantId),
        or(eq(menuOrders.paymentId, transactionId), eq(menuOrders.transactionId, transactionId)),
        or(isNull(menuOrders.paymentId), eq(menuOrders.paymentId, transactionId)),
        or(isNull(menuOrders.transactionId), eq(menuOrders.transactionId, transactionId)),
      ));
      await database.update(paymentIntents).set({ status: intentStatus, updatedAt: new Date() }).where(and(
        eq(paymentIntents.merchantId, merchantId),
        eq(paymentIntents.transactionId, transactionId),
      ));
    });
    return;
  }
  const updatedAt = now();
  for (const order of memory.menuOrders.values()) {
    if (
      order.merchantId === merchantId
      && (order.paymentId === transactionId || order.transactionId === transactionId)
      && (order.paymentId == null || order.paymentId === transactionId)
      && (order.transactionId == null || order.transactionId === transactionId)
    ) memory.menuOrders.set(order.id, { ...order, status, updatedAt } as MenuOrder);
  }
  for (const intent of memory.paymentIntents.values()) {
    if (intent.merchantId === merchantId && intent.transactionId === transactionId) {
      memory.paymentIntents.set(intent.id, { ...intent, status: intentStatus, updatedAt } as PaymentIntent);
    }
  }
}

function toPgMenuOrderColumns(data: InsertMenuOrder): Record<string, unknown> {
  const raw = data as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "category1") mapped.category_1 = value;
    else if (key === "category2") mapped.category_2 = value;
    else if (key === "category3") mapped.category_3 = value;
    else if (key === "category4") mapped.category_4 = value;
    else if (key === "category5") mapped.category_5 = value;
    else if (key === "category6") mapped.category_6 = value;
    else mapped[key] = value;
  }
  return mapped;
}

export async function getMenuOrderById(id: string): Promise<MenuOrder | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<MenuOrder>(pgPool, "menu_orders", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.menuOrders.get(id);
  const result = await db.select().from(menuOrders).where(eq(menuOrders.id, id)).limit(1);
  return result[0];
}

export async function createMenuOrder(data: InsertMenuOrder): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "menu_orders", toPgMenuOrderColumns(data)); return; }
  const db = await getDb();
  if (!db) { memory.menuOrders.set(data.id, withTimestamps(data) as MenuOrder); return; }
  await db.insert(menuOrders).values(data);
}

export async function updateMenuOrderPayment(
  orderId: string,
  merchantId: string,
  data: Partial<Pick<InsertMenuOrder, "paymentId" | "paymentIntentId" | "transactionId" | "status">>,
): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const set = entries.map(([key], index) => `${q(key)} = $${index + 1}`).join(", ");
    const values = entries.map(([, value]) => normalizeDbValue(value));
    values.push(orderId, merchantId);
    await pgPool.query(`UPDATE "menu_orders" SET ${set}, "updatedAt" = now() WHERE "id" = $${values.length - 1} AND "merchantId" = $${values.length}`, values);
    return;
  }
  const db = await getDb();
  if (!db) {
    const existing = memory.menuOrders.get(orderId);
    if (existing && existing.merchantId === merchantId) {
      memory.menuOrders.set(orderId, { ...existing, ...data, updatedAt: now() } as MenuOrder);
    }
    return;
  }
  await db.update(menuOrders).set({ ...data, updatedAt: new Date() }).where(and(eq(menuOrders.id, orderId), eq(menuOrders.merchantId, merchantId)));
}

export async function createSeraApiRequestLog(data: InsertSeraApiRequestLog): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "sera_api_request_logs", data); return; }
  const db = await getDb();
  if (!db) { memory.seraApiLogs.set(data.id, { createdAt: now(), ...data } as SeraApiRequestLog); return; }
  await db.insert(seraApiRequestLogs).values(data);
}

export async function listSeraApiRequestLogs(merchantId: string, limit = 50): Promise<SeraApiRequestLog[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "sera_api_request_logs" WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
      [merchantId, Math.min(limit, 100)],
    );
    return result.rows as SeraApiRequestLog[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.seraApiLogs.values())
    .filter((log) => log.merchantId === merchantId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, Math.min(limit, 100));
  return db
    .select()
    .from(seraApiRequestLogs)
    .where(eq(seraApiRequestLogs.merchantId, merchantId))
    .orderBy(desc(seraApiRequestLogs.createdAt))
    .limit(Math.min(limit, 100));
}

export async function createComplianceScreeningLog(data: InsertComplianceScreeningLog): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "compliance_screening_logs", data); return; }
  const db = await getDb();
  if (!db) { memory.complianceLogs.set(data.id, { createdAt: now(), ...data } as ComplianceScreeningLog); return; }
  await db.insert(complianceScreeningLogs).values(data);
}

export async function listComplianceScreeningLogs(merchantId: string, limit = 50): Promise<ComplianceScreeningLog[]> {
  const pgPool = await getPostgresPool();
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT * FROM "compliance_screening_logs" WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
      [merchantId, Math.min(limit, 100)],
    );
    return result.rows as ComplianceScreeningLog[];
  }
  const db = await getDb();
  if (!db) return Array.from(memory.complianceLogs.values())
    .filter((log) => log.merchantId === merchantId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, Math.min(limit, 100));
  return db
    .select()
    .from(complianceScreeningLogs)
    .where(eq(complianceScreeningLogs.merchantId, merchantId))
    .orderBy(desc(complianceScreeningLogs.createdAt))
    .limit(Math.min(limit, 100));
}
