import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const merchantsTable = pgTable("merchants", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  name: text("name"),
  logoData: text("logo_data"),
  qrFgColor: text("qr_fg_color"),
  qrBgColor: text("qr_bg_color"),
  qrStyle: text("qr_style"),
  receiveCoin: text("receive_coin"),
  storeAddress: text("store_address"),
  webhookUrl: text("webhook_url"),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertMerchantSchema = createInsertSchema(merchantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertMerchant = z.infer<typeof insertMerchantSchema>;
export type Merchant = typeof merchantsTable.$inferSelect;
