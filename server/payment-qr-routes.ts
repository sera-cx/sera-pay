import { Router, type Response } from "express";
import type { Merchant } from "../drizzle/schema";
import { ZodError } from "zod";
import { generatePaymentQrInputSchema } from "../shared/payment-qr";
import { generatePaymentQr, PaymentQrError, type PaymentQrExchangeRate } from "./payment-qr-service";
import { requireApiKey, fetchSeraRestFxRate, seraPaymentErrorResponse, SeraRateLimitedError, SeraRateUnavailableError } from "./payment-routes";
import { SeraApiError } from "./sera-api";
import { SeraQuoteValidationError } from "./sera-swap-quote";
import { QrImageError } from "./qr-image";

export function createPaymentQrRouter(getExchangeRate: PaymentQrExchangeRate = fetchSeraRestFxRate) {
  const router = Router();
  router.post("/payment/qr", requireApiKey, async (req, res: Response<unknown, { merchant: Merchant }>) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const input = generatePaymentQrInputSchema.parse(req.body);
      res.status(201).json(await generatePaymentQr(res.locals.merchant, input, getExchangeRate));
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request", errorCode: "invalid_request" });
        return;
      }
      if (error instanceof PaymentQrError) {
        res.status(error.status).json({ error: error.message, errorCode: error.errorCode });
        return;
      }
      if (error instanceof QrImageError) {
        res.status(error.status).json({ error: error.message, errorCode: "qr_image_unavailable" });
        return;
      }
      if (error instanceof SeraRateLimitedError) {
        res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
        res.status(429).json({ error: error.message, errorCode: "sera_rate_limited" });
        return;
      }
      if (error instanceof SeraRateUnavailableError) {
        res.status(error.errorCode === "no_liquidity" ? 409 : 503).json({ error: error.message, errorCode: error.errorCode });
        return;
      }
      if (error instanceof SeraQuoteValidationError || error instanceof SeraApiError) {
        const response = seraPaymentErrorResponse(error, "Unable to verify this Sera conversion right now");
        res.status(response.status).json(response.body);
        return;
      }
      console.error("[payment/qr] Generation failed", { type: error instanceof Error ? error.name : "unknown_error" });
      res.status(500).json({ error: "Unable to generate payment QR", errorCode: "internal_error" });
    }
  });
  return router;
}
