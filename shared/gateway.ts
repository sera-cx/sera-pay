import { z } from "zod";

export const DEFAULT_SERA_API_BASE_URL = "https://api.sera.cx/api/v1";
export const DEFAULT_SERA_API_TESTNET_BASE_URL = "https://api.testnet.sera.cx/api/v1";
export const seraApiModeSchema = z.enum(["mock", "test", "live"]);
export type SeraApiMode = z.infer<typeof seraApiModeSchema>;

export const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Expected an EVM address")
  .transform((value) => value.toLowerCase());

export const coinSymbolSchema = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z0-9]+$/)
  .transform((value) => value.toUpperCase());

export const amountStringSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "Expected a positive decimal amount with max 6 decimals")
  .refine((value) => Number(value) > 0, "Amount must be greater than zero");

export const seraApiConfigInputSchema = z.object({
  seraApiKey: z.string().trim().min(1).max(512).optional().or(z.literal("")),
  seraApiBaseUrl: z.string().trim().url().max(255).default(DEFAULT_SERA_API_BASE_URL),
  seraWebhookSecret: z.string().trim().max(256).optional().or(z.literal("")),
  mode: seraApiModeSchema.default("mock"),
});

export const seraApiKeyGenerationInputSchema = z.object({
  owner: evmAddressSchema,
  action: z.literal("create"),
  timestamp: z.coerce.number().int().positive(),
  signature: z.string().trim().regex(/^0x[0-9a-fA-F]+$/, "Expected a hex EIP-712 signature"),
  label: z.string().trim().min(1).max(80).default("pay.sera dashboard"),
  seraApiBaseUrl: z.string().trim().url().max(255).default(DEFAULT_SERA_API_BASE_URL),
});

export const createSubWalletInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  address: evmAddressSchema,
  chainId: z.coerce.number().int().positive().default(1),
  receiveCoin: coinSymbolSchema.default("USDC"),
});

export const createPaymentIntentInputSchema = z.object({
  amount: amountStringSchema,
  coin: coinSymbolSchema.default("USDC"),
  chainId: z.coerce.number().int().positive().default(1),
  subWalletId: z.string().uuid().optional().or(z.literal("")),
  customerEmail: z.string().trim().email().max(320).optional().or(z.literal("")),
  customerName: z.string().trim().max(120).optional().or(z.literal("")),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.coerce.date().optional(),
});

export const seraWebhookPayloadSchema = z.object({
  paymentIntentId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  status: z.enum(["created", "open", "paid", "expired", "canceled", "failed"]),
  fromAddress: evmAddressSchema.optional(),
  toAddress: evmAddressSchema.optional(),
  amount: amountStringSchema.optional(),
  coin: coinSymbolSchema.optional(),
  timestamp: z.string().optional(),
});

export type SeraApiConfigInput = z.infer<typeof seraApiConfigInputSchema>;
export type SeraApiKeyGenerationInput = z.infer<typeof seraApiKeyGenerationInputSchema>;
export type CreateSubWalletInput = z.infer<typeof createSubWalletInputSchema>;
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentInputSchema>;
export type SeraWebhookPayload = z.infer<typeof seraWebhookPayloadSchema>;

export interface Wallet {
  id: string;
  merchantId: string;
  type: "master";
  address: string;
  settlementAddress: string;
  receiveCoin: string | null;
  chainId: number;
  createdAt: string | Date;
}

export interface ApiKeyConfig {
  merchantId: string;
  seraApiBaseUrl: string;
  hasSeraApiKey: boolean;
  seraApiKeyLast4: string | null;
  hasWebhookSecret: boolean;
  webhookSecretLast4: string | null;
  mode: SeraApiMode;
  encryptionReady: boolean;
  updatedAt?: string | Date;
}

export interface CheckoutSession {
  id: string;
  merchantId: string;
  amount: string;
  coin: string;
  chainId: number;
  checkoutUrl: string;
  status: "created" | "open" | "paid" | "expired" | "canceled" | "failed";
  subWalletId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  description?: string | null;
  expiresAt?: string | Date | null;
  createdAt: string | Date;
}
