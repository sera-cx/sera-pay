import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable Sera submission states.
 *
 * These are deliberately separate from `transactionStatusEnum`: the latter is
 * the user-facing payment state, while this state machine records whether a
 * single-use Sera quote may already have reached Sera.  Keeping the values in a
 * varchar (rather than a PostgreSQL enum) lets us add a future Sera recovery
 * state without a blocking enum migration.
 */
export const SERA_SWAP_SUBMIT_STATES = [
  "quote_ready",
  "submitting",
  "submitted",
  "settlement_unknown",
  "settled",
  "failed",
  "expired",
  "canceled",
] as const;

export type SeraSwapSubmitState = (typeof SERA_SWAP_SUBMIT_STATES)[number];

export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const transactionStatusEnum = pgEnum("transaction_status", ["pending", "confirming", "confirmed", "failed", "canceled"]);
export const apiConfigModeEnum = pgEnum("api_config_mode", ["mock", "test", "live"]);
export const subWalletStatusEnum = pgEnum("sub_wallet_status", ["active", "archived"]);
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", ["created", "open", "processing", "paid", "expired", "canceled", "failed"]);
export const seraAuthModeEnum = pgEnum("sera_auth_mode", ["none", "api_key", "eip712"]);
export const complianceCheckTypeEnum = pgEnum("compliance_check_type", ["merchant_wallet", "sub_wallet", "payer_wallet", "recipient_wallet"]);
export const complianceStatusEnum = pgEnum("compliance_status", ["clear", "blocked", "unavailable", "skipped"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  privyWallet: varchar("privy_wallet", { length: 42 }),
  userWallet: varchar("user_wallet", { length: 42 }),
  walletType: varchar("wallet_type", { length: 32 }),
  role: userRoleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true }).defaultNow().notNull(),
});

export const merchants = pgTable(
  "merchants",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    walletAddress: varchar("walletAddress", { length: 42 }).notNull().unique(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    // SHA-256 hex of the merchant API key. The raw key is shown once at
    // creation/regeneration and never stored.
    apiKeyHash: varchar("apiKeyHash", { length: 64 }).notNull(),
    receiveCoin: varchar("receiveCoin", { length: 20 }).default("USDC"),
    logoData: text("logoData"),
    webhookUrl: varchar("webhookUrl", { length: 512 }),
    webhookSecret: varchar("webhookSecret", { length: 64 }),
    storeAddress: varchar("storeAddress", { length: 42 }),
    qrFgColor: varchar("qrFgColor", { length: 9 }),
    qrBgColor: varchar("qrBgColor", { length: 9 }),
    qrStyle: varchar("qrStyle", { length: 20 }),
    qrMode: varchar("qrMode", { length: 20 }).default("standard"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_merchants_wallet").on(t.walletAddress)]
);

export const transactions = pgTable(
  "transactions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    txHash: varchar("txHash", { length: 66 }),
    fromAddress: varchar("fromAddress", { length: 42 }),
    toAddress: varchar("toAddress", { length: 42 }).notNull(),
    coin: varchar("coin", { length: 20 }).notNull(),
    amount: numeric("amount", { precision: 36, scale: 18 }).notNull(),
    amountUsd: numeric("amountUsd", { precision: 20, scale: 6 }),
    chainId: integer("chainId").notNull().default(1),
    status: transactionStatusEnum("status").default("pending").notNull(),
    payCoin: varchar("payCoin", { length: 20 }),
    payAmount: numeric("payAmount", { precision: 36, scale: 18 }),
    memo: varchar("memo", { length: 200 }),
    notes: text("notes"),
    // Stable browser/checkout ownership key. A payer may lose the wallet tab
    // after a quote was created; retaining this key lets the next session
    // recover that active Sera attempt instead of consuming a second quote.
    checkoutAttemptKey: varchar("checkoutAttemptKey", { length: 66 }),
    // Sera quote/order identity and settlement economics are first-class
    // columns rather than notes-only JSON.  They remain nullable so direct
    // transfers and every transaction created before this migration continue
    // to work unchanged.
    quoteUuid: varchar("quoteUuid", { length: 128 }),
    routeUuid: numeric("routeUuid", { precision: 78, scale: 0 }),
    intentHash: varchar("intentHash", { length: 66 }),
    tradeId: varchar("tradeId", { length: 128 }),
    seraAddress: varchar("seraAddress", { length: 42 }),
    seraVaultAddress: varchar("seraVaultAddress", { length: 42 }),
    seraSorAddress: varchar("seraSorAddress", { length: 42 }),
    payTokenAddress: varchar("payTokenAddress", { length: 42 }),
    receiveTokenAddress: varchar("receiveTokenAddress", { length: 42 }),
    payTokenDecimals: integer("payTokenDecimals"),
    receiveTokenDecimals: integer("receiveTokenDecimals"),
    requestedPayAmountRaw: numeric("requestedPayAmountRaw", { precision: 78, scale: 0 }),
    maximumPayAmountRaw: numeric("maximumPayAmountRaw", { precision: 78, scale: 0 }),
    targetReceiveAmountRaw: numeric("targetReceiveAmountRaw", { precision: 78, scale: 0 }),
    minimumReceiveAmountRaw: numeric("minimumReceiveAmountRaw", { precision: 78, scale: 0 }),
    initialDepositAmountRaw: numeric("initialDepositAmountRaw", { precision: 78, scale: 0 }),
    quoteExpiresAt: timestamp("quoteExpiresAt", { withTimezone: true }),
    intentDeadline: timestamp("intentDeadline", { withTimezone: true }),
    permitRequired: integer("permitRequired"),
    permitDeadline: timestamp("permitDeadline", { withTimezone: true }),
    submitState: varchar("submitState", { length: 32 }).$type<SeraSwapSubmitState>(),
    submittedBlockNumber: numeric("submittedBlockNumber", { precision: 78, scale: 0 }),
    seraStatus: varchar("seraStatus", { length: 64 }),
    // Permanent positive evidence: once an exact finalized IntentMatched was
    // observed, an empty later RPC scan can never classify this as unpaid.
    intentMatchedAt: timestamp("intentMatchedAt", { withTimezone: true }),
    intentMatchedTxHash: varchar("intentMatchedTxHash", { length: 66 }),
    intentMatchedBlockNumber: numeric("intentMatchedBlockNumber", { precision: 78, scale: 0 }),
    // Canonical latest-head observation shown to the payer before Ethereum
    // finality. This never owns funds, pays a linked order, or fires webhooks.
    provisionalSettlementAt: timestamp("provisionalSettlementAt", { withTimezone: true }),
    provisionalSettlementTxHash: varchar("provisionalSettlementTxHash", { length: 66 }),
    provisionalSettlementBlockNumber: numeric("provisionalSettlementBlockNumber", { precision: 78, scale: 0 }),
    provisionalSettlementBlockHash: varchar("provisionalSettlementBlockHash", { length: 66 }),
    provisionalSettlementConfirmations: integer("provisionalSettlementConfirmations"),
    seraOutcomeSyncedAt: timestamp("seraOutcomeSyncedAt", { withTimezone: true }),
    actualPayAmountRaw: numeric("actualPayAmountRaw", { precision: 78, scale: 0 }),
    actualReceiveAmountRaw: numeric("actualReceiveAmountRaw", { precision: 78, scale: 0 }),
    feeAmountRaw: numeric("feeAmountRaw", { precision: 78, scale: 0 }),
    feeTokenAddress: varchar("feeTokenAddress", { length: 42 }),
    settlementTxHash: varchar("settlementTxHash", { length: 66 }),
    failureCode: varchar("failureCode", { length: 128 }),
    verified: integer("verified").default(0).notNull(),
    notifiedAt: timestamp("notifiedAt", { withTimezone: true }),
    webhookSentAt: timestamp("webhookSentAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_tx_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_tx_from_address").on(t.fromAddress),
    index("idx_tx_to_address_created").on(t.toAddress, t.createdAt),
    index("idx_tx_status_verified").on(t.status, t.verified),
    uniqueIndex("uq_tx_direct_tx_hash")
      .on(sql`lower(${t.txHash})`)
      .where(sql`${t.intentHash} IS NULL`),
    uniqueIndex("uq_tx_quote_uuid").on(t.quoteUuid),
    uniqueIndex("uq_tx_route_uuid").on(t.routeUuid),
    uniqueIndex("uq_tx_intent_hash").on(t.intentHash),
    uniqueIndex("uq_tx_trade_id").on(t.tradeId),
    uniqueIndex("uq_tx_active_checkout_attempt_key")
      .on(sql`lower(btrim(${t.checkoutAttemptKey}))`)
      .where(sql`${t.checkoutAttemptKey} IS NOT NULL AND ${t.status} IN ('pending', 'confirming')`),
    index("idx_tx_submit_state_updated").on(t.submitState, t.updatedAt),
    index("idx_tx_settlement_hash").on(t.settlementTxHash),
    index("idx_tx_sera_vault_chain").on(t.chainId, t.seraVaultAddress),
    check(
      "ck_transactions_provisional_settlement_complete",
      sql`(
        (${t.provisionalSettlementAt} IS NULL
          AND ${t.provisionalSettlementTxHash} IS NULL
          AND ${t.provisionalSettlementBlockNumber} IS NULL
          AND ${t.provisionalSettlementBlockHash} IS NULL
          AND ${t.provisionalSettlementConfirmations} IS NULL)
        OR
        (${t.provisionalSettlementAt} IS NOT NULL
          AND ${t.provisionalSettlementTxHash} IS NOT NULL
          AND ${t.provisionalSettlementBlockNumber} IS NOT NULL
          AND ${t.provisionalSettlementBlockHash} IS NOT NULL
          AND ${t.provisionalSettlementConfirmations} BETWEEN 1 AND 2)
      )`,
    ),
  ]
);

/**
 * Serializes terminal transaction-hash ownership across payment kinds.
 *
 * A Sera batch transaction can settle many independently signed Intents, so a
 * single `sera` ownership row intentionally has no transaction id. A direct
 * transfer is one-to-one and records its owning transaction. Owners are
 * permanent, globally scoped replay tombstones: deletion or downgrade of a
 * payment row cannot make its chain hash reusable. PostgreSQL triggers
 * maintain this table; the application model is declared here so schema
 * snapshots and future migrations cannot accidentally drop it.
 */
export const transactionHashOwnership = pgTable(
  "transaction_hash_ownership",
  {
    txHash: varchar("txHash", { length: 66 }).primaryKey(),
    ownerKind: varchar("ownerKind", { length: 16 }).$type<"direct" | "sera">().notNull(),
    directTransactionId: varchar("directTransactionId", { length: 36 })
      .unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("ck_transaction_hash_ownership_hash", sql`${t.txHash} ~ '^0x[0-9a-f]{64}$'`),
    check(
      "ck_transaction_hash_ownership_kind",
      sql`(${t.ownerKind} = 'direct' AND ${t.directTransactionId} IS NOT NULL)
        OR (${t.ownerKind} = 'sera' AND ${t.directTransactionId} IS NULL)`,
    ),
  ],
);

export const menus = pgTable(
  "menus",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    businessCategory: varchar("businessCategory", { length: 80 }),
    businessCategoryOther: varchar("businessCategoryOther", { length: 120 }),
    slug: varchar("slug", { length: 80 }).notNull().unique(),
    isActive: integer("isActive").default(1).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_menus_merchant").on(t.merchantId)]
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    menuId: varchar("menuId", { length: 36 }).notNull().references(() => menus.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    itemCode: varchar("itemCode", { length: 64 }),
    price: numeric("price", { precision: 20, scale: 6 }).notNull(),
    coin: varchar("coin", { length: 20 }).notNull().default("USDC"),
    imageUrl: varchar("imageUrl", { length: 512 }),
    category: varchar("category", { length: 60 }),
    sortOrder: integer("sortOrder").default(0).notNull(),
    isActive: integer("isActive").default(1).notNull(),
    soldOutUntil: timestamp("soldOutUntil", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_menu_items_menu").on(t.menuId)]
);

export const menuOrders = pgTable(
  "menu_orders",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    menuId: varchar("menuId", { length: 36 }).notNull().references(() => menus.id, { onDelete: "cascade" }),
    paymentId: varchar("paymentId", { length: 36 }),
    paymentIntentId: varchar("paymentIntentId", { length: 36 }),
    transactionId: varchar("transactionId", { length: 36 }).references(() => transactions.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).default("created").notNull(),
    pax: integer("pax").default(1).notNull(),
    businessCategory: varchar("businessCategory", { length: 80 }),
    category1: text("category_1"),
    category2: text("category_2"),
    category3: text("category_3"),
    category4: text("category_4"),
    category5: text("category_5"),
    category6: text("category_6"),
    items: text("items").notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    coin: varchar("coin", { length: 20 }).notNull(),
    customerName: varchar("customerName", { length: 120 }),
    orderedAt: timestamp("orderedAt", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_menu_orders_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_menu_orders_menu_created").on(t.menuId, t.createdAt),
    index("idx_menu_orders_payment").on(t.paymentId),
  ]
);

export const webhookLogs = pgTable(
  "webhook_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    txId: varchar("txId", { length: 36 }).notNull().references(() => transactions.id, { onDelete: "cascade" }),
    txHash: varchar("txHash", { length: 66 }),
    url: varchar("url", { length: 512 }).notNull(),
    statusCode: integer("statusCode"),
    success: integer("success").default(0).notNull(),
    responseBody: text("responseBody"),
    error: text("error"),
    sentAt: timestamp("sentAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_wh_logs_merchant").on(t.merchantId, t.sentAt)]
);

export const apiKeyConfigs = pgTable(
  "api_key_configs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().unique().references(() => merchants.id, { onDelete: "cascade" }),
    seraApiBaseUrl: varchar("seraApiBaseUrl", { length: 255 }).default("https://api.sera.cx/api/v1").notNull(),
    seraApiKeyEncrypted: text("seraApiKeyEncrypted"),
    seraApiKeyLast4: varchar("seraApiKeyLast4", { length: 12 }),
    seraWebhookSecretEncrypted: text("seraWebhookSecretEncrypted"),
    seraWebhookSecretLast4: varchar("seraWebhookSecretLast4", { length: 12 }),
    mode: apiConfigModeEnum("mode").default("live").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_api_key_configs_merchant").on(t.merchantId)]
);

export const subWallets = pgTable(
  "sub_wallets",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull(),
    address: varchar("address", { length: 42 }).notNull(),
    chainId: integer("chainId").default(1).notNull(),
    receiveCoin: varchar("receiveCoin", { length: 20 }).default("USDC"),
    status: subWalletStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_sub_wallets_merchant").on(t.merchantId),
    index("idx_sub_wallets_address").on(t.address),
  ]
);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).notNull().references(() => merchants.id, { onDelete: "cascade" }),
    subWalletId: varchar("subWalletId", { length: 36 }).references(() => subWallets.id, { onDelete: "set null" }),
    amount: numeric("amount", { precision: 36, scale: 18 }).notNull(),
    coin: varchar("coin", { length: 20 }).notNull(),
    receiverAddress: varchar("receiverAddress", { length: 42 }).notNull(),
    chainId: integer("chainId").default(1).notNull(),
    customerEmail: varchar("customerEmail", { length: 320 }),
    customerName: varchar("customerName", { length: 120 }),
    description: varchar("description", { length: 500 }),
    metadata: text("metadata"),
    checkoutUrl: varchar("checkoutUrl", { length: 1024 }).notNull(),
    status: paymentIntentStatusEnum("status").default("created").notNull(),
    // Internal single-use submission owner. Quotes remain disposable; the
    // first transaction that actually starts submission claims the intent.
    transactionId: varchar("transactionId", { length: 36 }).references(() => transactions.id, { onDelete: "set null" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_payment_intents_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_payment_intents_status").on(t.status),
    index("idx_payment_intents_transaction").on(t.transactionId),
  ]
);

export const seraApiRequestLogs = pgTable(
  "sera_api_request_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).references(() => merchants.id, { onDelete: "set null" }),
    seraApiBaseUrl: varchar("seraApiBaseUrl", { length: 255 }).notNull(),
    endpoint: varchar("endpoint", { length: 160 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    authMode: seraAuthModeEnum("authMode").default("none").notNull(),
    requestQuery: text("requestQuery"),
    requestBody: text("requestBody"),
    responseStatus: integer("responseStatus"),
    responseBody: text("responseBody"),
    errorMessage: text("errorMessage"),
    durationMs: integer("durationMs").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_sera_api_logs_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_sera_api_logs_endpoint_created").on(t.endpoint, t.createdAt),
  ]
);

export const complianceScreeningLogs = pgTable(
  "compliance_screening_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    merchantId: varchar("merchantId", { length: 36 }).references(() => merchants.id, { onDelete: "set null" }),
    address: varchar("address", { length: 80 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    checkType: complianceCheckTypeEnum("checkType").notNull(),
    status: complianceStatusEnum("status").notNull(),
    responseStatus: integer("responseStatus"),
    responseBody: text("responseBody"),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_compliance_logs_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_compliance_logs_address_created").on(t.address, t.createdAt),
  ]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Merchant = typeof merchants.$inferSelect;
export type InsertMerchant = typeof merchants.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = typeof transactions.$inferInsert;
export type Menu = typeof menus.$inferSelect;
export type InsertMenu = typeof menus.$inferInsert;
export type MenuItem = typeof menuItems.$inferSelect;
export type InsertMenuItem = typeof menuItems.$inferInsert;
export type MenuOrder = typeof menuOrders.$inferSelect;
export type InsertMenuOrder = typeof menuOrders.$inferInsert;
export type WebhookLog = typeof webhookLogs.$inferSelect;
export type InsertWebhookLog = typeof webhookLogs.$inferInsert;
export type ApiKeyConfigRecord = typeof apiKeyConfigs.$inferSelect;
export type InsertApiKeyConfig = typeof apiKeyConfigs.$inferInsert;
export type SubWallet = typeof subWallets.$inferSelect;
export type InsertSubWallet = typeof subWallets.$inferInsert;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type InsertPaymentIntent = typeof paymentIntents.$inferInsert;
export type SeraApiRequestLog = typeof seraApiRequestLogs.$inferSelect;
export type InsertSeraApiRequestLog = typeof seraApiRequestLogs.$inferInsert;
export type ComplianceScreeningLog = typeof complianceScreeningLogs.$inferSelect;
export type InsertComplianceScreeningLog = typeof complianceScreeningLogs.$inferInsert;
