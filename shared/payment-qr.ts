import { z } from "zod";
import { amountStringSchema, coinSymbolSchema } from "./gateway";
import { MAX_PAYMENT_DECIMALS } from "./decimal-input";

export const MAX_CHECKOUT_MICRO_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export const generatePaymentQrInputSchema = z.strictObject({
  baseAmount: amountStringSchema
    .refine((value) => value.replace(/^0+/, "").split(".")[0].length <= 18, "Amount must have at most 18 integer digits")
    .transform((value) => value.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""))
    .refine((value) => {
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole + fraction.padEnd(MAX_PAYMENT_DECIMALS, "0")) <= MAX_CHECKOUT_MICRO_UNITS;
    }, "Amount exceeds the supported checkout maximum of 9007199254.740991"),
  baseCurrency: coinSymbolSchema,
  targetCurrency: coinSymbolSchema,
  singleUse: z.boolean().default(false),
});

export type GeneratePaymentQrInput = z.infer<typeof generatePaymentQrInputSchema>;

export interface GeneratePaymentQrResponse extends GeneratePaymentQrInput {
  checkoutUrl: string;
  qrValue: string;
  qrCodeDataUrl: string;
  targetAmount: string;
  receiverAddress: string;
  chainId: number;
  paymentIntentId: string | null;
  requiresCustomerRequote: boolean;
}
