import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const transactionStatusEnum = pgEnum("transaction_status", ["pending", "confirming", "confirmed", "failed", "canceled"]);
export const apiConfigModeEnum = pgEnum("api_config_mode", ["mock", "live"]);
export const subWalletStatusEnum = pgEnum("sub_wallet_status", ["active", "archived"]);
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", ["created", "open", "paid", "expired", "canceled", "failed"]);
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
    apiKey: varchar("apiKey", { length: 80 }).notNull().unique(),
    receiveCoin: varchar("receiveCoin", { length: 20 }).default("USDC"),
    logoData: text("logoData"),
    webhookUrl: varchar("webhookUrl", { length: 512 }),
    webhookSecret: varchar("webhookSecret", { length: 64 }),
    storeAddress: varchar("storeAddress", { length: 42 }),
    qrFgColor: varchar("qrFgColor", { length: 9 }),
    qrBgColor: varchar("qrBgColor", { length: 9 }),
    qrStyle: varchar("qrStyle", { length: 20 }),
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
    txHash: varchar("txHash", { length: 66 }).unique(),
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
  ]
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
    price: numeric("price", { precision: 20, scale: 6 }).notNull(),
    coin: varchar("coin", { length: 20 }).notNull().default("USDC"),
    imageUrl: varchar("imageUrl", { length: 512 }),
    category: varchar("category", { length: 60 }),
    sortOrder: integer("sortOrder").default(0).notNull(),
    isActive: integer("isActive").default(1).notNull(),
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
    mode: apiConfigModeEnum("mode").default("mock").notNull(),
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
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_payment_intents_merchant_created").on(t.merchantId, t.createdAt),
    index("idx_payment_intents_status").on(t.status),
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
