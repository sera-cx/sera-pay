DO $$ BEGIN CREATE TYPE "public"."api_config_mode" AS ENUM('mock', 'live'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."compliance_check_type" AS ENUM('merchant_wallet', 'sub_wallet', 'payer_wallet', 'recipient_wallet'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."compliance_status" AS ENUM('clear', 'blocked', 'unavailable', 'skipped'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."payment_intent_status" AS ENUM('created', 'open', 'paid', 'expired', 'canceled', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."sera_auth_mode" AS ENUM('none', 'api_key', 'eip712'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."sub_wallet_status" AS ENUM('active', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'confirming', 'confirmed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."user_role" AS ENUM('user', 'admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_key_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"seraApiBaseUrl" varchar(255) DEFAULT 'https://api.sera.cx/api/v1' NOT NULL,
	"seraApiKeyEncrypted" text,
	"seraApiKeyLast4" varchar(12),
	"seraWebhookSecretEncrypted" text,
	"seraWebhookSecretLast4" varchar(12),
	"mode" "api_config_mode" DEFAULT 'mock' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_configs_merchantId_unique" UNIQUE("merchantId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_screening_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36),
	"address" varchar(80) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"checkType" "compliance_check_type" NOT NULL,
	"status" "compliance_status" NOT NULL,
	"responseStatus" integer,
	"responseBody" text,
	"errorMessage" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"menuId" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"price" numeric(20, 6) NOT NULL,
	"coin" varchar(20) DEFAULT 'USDC' NOT NULL,
	"imageUrl" varchar(512),
	"category" varchar(60),
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"isActive" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menus" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"slug" varchar(80) NOT NULL,
	"isActive" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"walletAddress" varchar(42) NOT NULL,
	"name" varchar(120) NOT NULL,
	"apiKey" varchar(80) NOT NULL,
	"receiveCoin" varchar(20) DEFAULT 'USDC',
	"logoData" text,
	"webhookUrl" varchar(512),
	"webhookSecret" varchar(64),
	"storeAddress" varchar(42),
	"qrFgColor" varchar(9),
	"qrBgColor" varchar(9),
	"qrStyle" varchar(20),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_walletAddress_unique" UNIQUE("walletAddress"),
	CONSTRAINT "merchants_apiKey_unique" UNIQUE("apiKey")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"subWalletId" varchar(36),
	"amount" numeric(36, 18) NOT NULL,
	"coin" varchar(20) NOT NULL,
	"receiverAddress" varchar(42) NOT NULL,
	"chainId" integer DEFAULT 1 NOT NULL,
	"customerEmail" varchar(320),
	"customerName" varchar(120),
	"description" varchar(500),
	"metadata" text,
	"checkoutUrl" varchar(1024) NOT NULL,
	"status" "payment_intent_status" DEFAULT 'created' NOT NULL,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sera_api_request_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36),
	"seraApiBaseUrl" varchar(255) NOT NULL,
	"endpoint" varchar(160) NOT NULL,
	"method" varchar(10) NOT NULL,
	"authMode" "sera_auth_mode" DEFAULT 'none' NOT NULL,
	"requestQuery" text,
	"requestBody" text,
	"responseStatus" integer,
	"responseBody" text,
	"errorMessage" text,
	"durationMs" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sub_wallets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"label" varchar(120) NOT NULL,
	"address" varchar(42) NOT NULL,
	"chainId" integer DEFAULT 1 NOT NULL,
	"receiveCoin" varchar(20) DEFAULT 'USDC',
	"status" "sub_wallet_status" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"txHash" varchar(66),
	"fromAddress" varchar(42),
	"toAddress" varchar(42) NOT NULL,
	"coin" varchar(20) NOT NULL,
	"amount" numeric(36, 18) NOT NULL,
	"amountUsd" numeric(20, 6),
	"chainId" integer DEFAULT 1 NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"payCoin" varchar(20),
	"payAmount" numeric(36, 18),
	"memo" varchar(200),
	"notes" text,
	"verified" integer DEFAULT 0 NOT NULL,
	"notifiedAt" timestamp with time zone,
	"webhookSentAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_txHash_unique" UNIQUE("txHash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"privy_wallet" varchar(42),
	"user_wallet" varchar(42),
	"wallet_type" varchar(32),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"merchantId" varchar(36) NOT NULL,
	"txId" varchar(36) NOT NULL,
	"txHash" varchar(66),
	"url" varchar(512) NOT NULL,
	"statusCode" integer,
	"success" integer DEFAULT 0 NOT NULL,
	"responseBody" text,
	"error" text,
	"sentAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key_configs" ADD CONSTRAINT "api_key_configs_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_screening_logs" ADD CONSTRAINT "compliance_screening_logs_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menuId_menus_id_fk" FOREIGN KEY ("menuId") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_subWalletId_sub_wallets_id_fk" FOREIGN KEY ("subWalletId") REFERENCES "public"."sub_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sera_api_request_logs" ADD CONSTRAINT "sera_api_request_logs_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_wallets" ADD CONSTRAINT "sub_wallets_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_merchantId_merchants_id_fk" FOREIGN KEY ("merchantId") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_txId_transactions_id_fk" FOREIGN KEY ("txId") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_key_configs_merchant" ON "api_key_configs" USING btree ("merchantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_compliance_logs_merchant_created" ON "compliance_screening_logs" USING btree ("merchantId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_compliance_logs_address_created" ON "compliance_screening_logs" USING btree ("address","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_menu_items_menu" ON "menu_items" USING btree ("menuId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_menus_merchant" ON "menus" USING btree ("merchantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_merchants_wallet" ON "merchants" USING btree ("walletAddress");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_merchant_created" ON "payment_intents" USING btree ("merchantId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_status" ON "payment_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sera_api_logs_merchant_created" ON "sera_api_request_logs" USING btree ("merchantId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sera_api_logs_endpoint_created" ON "sera_api_request_logs" USING btree ("endpoint","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sub_wallets_merchant" ON "sub_wallets" USING btree ("merchantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sub_wallets_address" ON "sub_wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_merchant_created" ON "transactions" USING btree ("merchantId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_from_address" ON "transactions" USING btree ("fromAddress");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_to_address_created" ON "transactions" USING btree ("toAddress","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tx_status_verified" ON "transactions" USING btree ("status","verified");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wh_logs_merchant" ON "webhook_logs" USING btree ("merchantId","sentAt");
