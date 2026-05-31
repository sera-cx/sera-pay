import { pgTable, text, timestamp, uuid, numeric, boolean, index } from "drizzle-orm/pg-core";
import { merchantsTable } from "./merchants";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transactionsTable = pgTable("transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  merchantId: uuid("merchant_id").references(() => merchantsTable.id).notNull(),
  txHash: text("tx_hash").notNull().unique(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  amount: numeric("amount").notNull(),
  coin: text("coin").notNull(),
  payCoin: text("pay_coin"),
  payAmount: numeric("pay_amount"),
  status: text("status").notNull().default("pending"),
  verified: boolean("verified").notNull().default(false),
  webhookSent: boolean("webhook_sent").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // /payer/history: queries by fromAddress ordered by createdAt
  fromAddressIdx: index("idx_transactions_from_address").on(table.fromAddress),
  // /merchant/transactions: queries by merchantId ordered by createdAt
  merchantIdCreatedAtIdx: index("idx_transactions_merchant_id_created_at").on(table.merchantId, table.createdAt),
  // /payment/check: queries by toAddress + createdAt range
  toAddressCreatedAtIdx: index("idx_transactions_to_address_created_at").on(table.toAddress, table.createdAt),
  // Startup recovery: queries pending+unverified rows
  statusVerifiedIdx: index("idx_transactions_status_verified").on(table.status, table.verified),
}));

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
