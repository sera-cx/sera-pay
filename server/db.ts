import { eq, desc, and, or } from "drizzle-orm";
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
} from "../drizzle/schema";
import { ENV } from './_core/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;
let _pgPool: pg.Pool | null = null;
let _pgSchemaReady = false;
let _pgUnavailableReason: string | null = null;

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
      "apiKey" varchar(80) NOT NULL UNIQUE,
      "receiveCoin" varchar(20) DEFAULT 'USDC',
      "logoData" text,
      "webhookUrl" varchar(512),
      "webhookSecret" varchar(64),
      "storeAddress" varchar(42),
      "qrFgColor" varchar(9),
      "qrBgColor" varchar(9),
      "qrStyle" varchar(20),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "description" varchar(500);
    CREATE INDEX IF NOT EXISTS "idx_merchants_wallet" ON "merchants" ("walletAddress");

    CREATE TABLE IF NOT EXISTS "transactions" (
      "id" varchar(36) PRIMARY KEY,
      "merchantId" varchar(36) NOT NULL REFERENCES "merchants" ("id") ON DELETE CASCADE,
      "txHash" varchar(66) UNIQUE,
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
      "verified" integer NOT NULL DEFAULT 0,
      "notifiedAt" timestamptz,
      "webhookSentAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_tx_merchant_created" ON "transactions" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_tx_from_address" ON "transactions" ("fromAddress");
    CREATE INDEX IF NOT EXISTS "idx_tx_to_address_created" ON "transactions" ("toAddress", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_tx_status_verified" ON "transactions" ("status", "verified");

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
      "mode" varchar(20) NOT NULL DEFAULT 'mock',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_api_key_configs_merchant" ON "api_key_configs" ("merchantId");

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
      "expiresAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "idx_payment_intents_merchant_created" ON "payment_intents" ("merchantId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_payment_intents_status" ON "payment_intents" ("status");

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
  console.log("[Database] PostgreSQL schema ready");
}

async function getPostgresPool() {
  if (_pgUnavailableReason) return null;
  if (!process.env.DATABASE_URL || !isPostgresDatabaseUrl(process.env.DATABASE_URL)) return null;
  if (!_pgPool) {
    try {
      _pgPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 5_000,
      });
      _pgPool.on("error", (error) => {
        console.warn("[Database] PostgreSQL pool error:", error.message);
      });
      await ensurePostgresSchema(_pgPool);
      console.log("[Database] PostgreSQL connection pool initialised (max=10)");
    } catch (error) {
      _pgUnavailableReason = error instanceof Error ? error.message : String(error);
      console.warn(`[Database] PostgreSQL unavailable; using in-memory fallback. ${_pgUnavailableReason}`);
      await _pgPool?.end().catch(() => undefined);
      _pgPool = null;
      return null;
    }
  }
  return _pgPool;
}

async function pgSelectOne<T>(pool: pg.Pool, table: string, where: string, values: unknown[]): Promise<T | undefined> {
  const result = await pool.query(`SELECT * FROM ${q(table)} WHERE ${where} LIMIT 1`, values);
  return result.rows[0] as T | undefined;
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
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
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

export async function getMerchantByApiKey(apiKey: string): Promise<Merchant | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Merchant>(pgPool, "merchants", `"apiKey" = $1`, [apiKey]);
  const db = await getDb();
  if (!db) return Array.from(memory.merchants.values()).find((m) => m.apiKey === apiKey);
  const result = await db.select().from(merchants).where(eq(merchants.apiKey, apiKey)).limit(1);
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
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgInsert(pgPool, "transactions", data); return; }
  const db = await getDb();
  if (!db) { memory.transactions.set(data.id, withTimestamps(data) as Transaction); return; }
  await db.insert(transactions).values(data);
}

export async function getTransactionById(id: string): Promise<Transaction | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `"id" = $1`, [id]);
  const db = await getDb();
  if (!db) return memory.transactions.get(id);
  const result = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
  return result[0];
}

export async function getTransactionByHash(txHash: string): Promise<Transaction | undefined> {
  const pgPool = await getPostgresPool();
  if (pgPool) return pgSelectOne<Transaction>(pgPool, "transactions", `"txHash" = $1`, [txHash]);
  const db = await getDb();
  if (!db) return Array.from(memory.transactions.values()).find((tx) => tx.txHash === txHash);
  const result = await db.select().from(transactions).where(eq(transactions.txHash, txHash)).limit(1);
  return result[0];
}

export async function updateTransaction(id: string, data: Partial<InsertTransaction>): Promise<void> {
  const pgPool = await getPostgresPool();
  if (pgPool) { await pgUpdate(pgPool, "transactions", id, data); return; }
  const db = await getDb();
  if (!db) {
    const existing = memory.transactions.get(id);
    if (existing) memory.transactions.set(id, { ...existing, ...data, updatedAt: now() } as Transaction);
    return;
  }
  await db.update(transactions).set(data).where(eq(transactions.id, id));
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
